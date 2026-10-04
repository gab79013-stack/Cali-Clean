/**
 * La capa central: valida los staging, deduplica y planifica. Nada más.
 *
 * Es el único sitio de la fase 3 que mira el CRM, y solo lo LEE. Los scouts no
 * saben que existe un CRM; la capa central no sabe cómo se descarga un CSV. Esa
 * separación es la que hace que un scout nuevo no pueda escribir por error.
 *
 * Qué hace, en este orden y secuencialmente:
 *
 *   1. **Valida** cada staging por separado: esquema, procedencia, privacidad,
 *      frescura y hash. Un staging que no valida se descarta entero; no se
 *      rescatan "las filas buenas" de un archivo que pudo ser alterado.
 *   2. **Carga el índice del CRM una sola vez.** Una lectura, no una por
 *      candidato, y si queda incompleta no se continúa: con un índice a medias se
 *      crean duplicados.
 *   3. **Deduplica** contra las Companies que ya existen y entre los tres
 *      staging, con una prioridad determinista y documentada.
 *   4. **Planifica** una sync de Companies únicamente. No ejecuta nada.
 *
 * Y no muta el staging: los archivos se leen y se dejan como estaban. El plan es
 * un objeto nuevo.
 */

import { assertOutboundDisabled, manifestFor, SCOUT_IDS } from './registry.js';
import { readStaging } from './staging.js';
import { normalizeForMatch } from '../sources/city-btc-rules.js';

/**
 * Prioridad cuando dos fuentes describen la misma entidad.
 *
 * Determinista y razonada, no arbitraria. El criterio es **cuánto se puede
 * verificar de la ficha que quedaría**:
 *
 *   1. `cde_schools` — centro educativo con identificador oficial (CDSCode),
 *      estado activo, dirección del centro y, cuando la fuente lo publica, su
 *      sitio oficial. Es la ficha más completa de las tres, y la única que trae
 *      un sitio web que no hay que adivinar.
 *   2. `hud_multifamily` — propiedad institucional con dirección y número de
 *      unidades. Verificable y situable, sin sitio web.
 *   3. `cslb_contractors` — licencia de contratista. **No conserva dirección a
 *      propósito**, así que una ficha que venga solo de aquí no se puede situar.
 *      Pierde contra cualquiera que sí pueda.
 *
 * Y por encima de las tres, lo que ya está en el CRM: una Company existente
 * nunca se modifica desde aquí. El candidato se omite.
 *
 * `hcai_facilities` estuvo aquí y se retiró: su publicador prohíbe por robots las
 * rutas que necesitaba. Ver docs/retired/.
 */
export const SOURCE_PRIORITY = Object.freeze(['cde_schools', 'hud_multifamily', 'cslb_contractors']);

export const PRIORITY_RATIONALE = Object.freeze({
  cde_schools: 'identificador oficial, dirección del centro y sitio web publicado por la fuente: la más completa',
  hud_multifamily: 'propiedad institucional con dirección y número de unidades: situable',
  cslb_contractors: 'licencia de contratista sin dirección: no se puede situar, así que pierde',
});

/** Claves que un candidato puede traer. Lista cerrada. */
const CANDIDATE_KEYS = new Set([
  'dedupKey', 'sourceId', 'businessName', 'address', 'city', 'zip',
  'serviceArea', 'sourceUrl', 'evidence', 'matchKeys',
]);

/**
 * Señales de que algo personal se colό en un staging.
 *
 * Se busca por FORMA, no por nombre de campo: un staging alterado a mano no va a
 * llamar `email` a un correo. Esto es la última red antes de que un candidato
 * entre en un plan.
 */
const PII_PATTERNS = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, 'un correo electrónico'],
  [/\b(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/, 'un teléfono'],
  [/-?\d{1,3}\.\d{5,}/, 'una coordenada'],
  [/\bp\.?\s?o\.?\s*box\b/i, 'un apartado de correos'],
  [/\bpmb\b/i, 'un buzón privado'],
];

const PII_KEY_PATTERNS = /owner|contact|phone|email|latitude|longitude|administrator|manager_name|person/i;

/** Valida un staging por sí solo. Devuelve `{ ok, problems, doc }`. */
export function validateStaging(scoutId, file, { now = Date.now(), requireSameSession = true } = {}) {
  const base = readStaging(file, { now, requireSameSession });
  const problems = [...base.problems];
  const doc = base.doc;
  if (!doc) return { ok: false, problems, doc: null };

  const m = manifestFor(scoutId);
  if (!m) problems.push(`no hay manifiesto para ${scoutId}`);
  if (doc.scoutId !== scoutId) problems.push(`el staging dice ser de ${doc.scoutId}, no de ${scoutId}`);

  // ── Procedencia ──
  if (!doc.provenance || typeof doc.provenance !== 'object') problems.push('sin procedencia');
  else {
    if (!doc.provenance.license) problems.push('la procedencia no declara licencia');
    if (!doc.provenance.collectedAt) problems.push('la procedencia no dice cuándo se recogió');
    if (m && doc.provenance.egressHost !== m.egressHost) {
      problems.push(`la procedencia dice haber usado ${doc.provenance.egressHost} y el manifiesto declara ${m.egressHost}`);
    }
  }

  // ── Esquema y privacidad de cada candidato ──
  const namespace = m?.dedupNamespace;
  for (const [i, c] of (doc.candidates || []).entries()) {
    const donde = `candidato ${i}`;
    for (const k of Object.keys(c || {})) {
      if (!CANDIDATE_KEYS.has(k)) problems.push(`${donde}: clave inesperada "${k}"`);
      if (PII_KEY_PATTERNS.test(k)) problems.push(`${donde}: la clave "${k}" suena a dato personal`);
    }
    if (namespace && !String(c?.dedupKey || '').startsWith(`${namespace}:`)) {
      problems.push(`${donde}: la clave no empieza por "${namespace}:"`);
    }
    if (!c?.businessName) problems.push(`${donde}: sin nombre`);

    for (const k of Object.keys(c?.evidence || {})) {
      if (PII_KEY_PATTERNS.test(k) && !/managementAgent/i.test(k)) {
        problems.push(`${donde}: evidence.${k} suena a dato personal`);
      }
    }

    const texto = JSON.stringify(c);
    for (const [re, que] of PII_PATTERNS) {
      if (re.test(texto)) problems.push(`${donde}: contiene ${que}`);
    }
  }

  // ── Tope por fuente ──
  const tope = m?.limits?.maxAcceptedPerRun ?? 50;
  if ((doc.candidates || []).length > tope) {
    problems.push(`${doc.candidates.length} candidatos, por encima del tope de ${tope}`);
  }

  return { ok: problems.length === 0, problems, doc };
}

/**
 * Decide qué hacer con todos los candidatos.
 *
 * `crmIndex` lo carga quien llama, UNA vez, y llega aquí ya construido:
 * `{ dedupKeys:Set, crossKeys:Set, nameKeys:Set, complete:boolean }`.
 */
export function reconcile({ stagings, crmIndex, now = Date.now() }) {
  if (!crmIndex?.complete) {
    throw new Error('el índice del CRM está incompleto: con un índice a medias se crearían duplicados');
  }

  const resultado = {
    create: [],
    omitted: [],
    bySource: {},
    conflicts: [],
    totals: { candidates: 0, create: 0, omitted_existing: 0, omitted_cross_source: 0 },
  };

  // Se recorre en el orden de prioridad, así que el primero que reclama una
  // entidad se la queda y el resto se omite. Como el orden es fijo, dos
  // ejecuciones con los mismos staging dan el mismo plan.
  const reclamadas = new Map();

  for (const scoutId of SOURCE_PRIORITY) {
    const doc = stagings[scoutId];
    resultado.bySource[scoutId] = { candidates: 0, create: 0, omitted_existing: 0, omitted_cross_source: 0 };
    if (!doc) continue;

    for (const c of doc.candidates) {
      resultado.totals.candidates++;
      resultado.bySource[scoutId].candidates++;

      const cross = c.matchKeys?.cross || null;
      const name = c.matchKeys?.name || normalizeForMatch(c.businessName) || null;

      // 1. Ya está en el CRM: se omite. Nunca se modifica lo existente.
      const yaEsta = crmIndex.dedupKeys.has(c.dedupKey)
        || (cross && crmIndex.crossKeys.has(cross))
        || (name && crmIndex.nameKeys?.has(name));
      if (yaEsta) {
        resultado.omitted.push({ scoutId, dedupKey: c.dedupKey, reason: 'ya_existe_en_crm' });
        resultado.totals.omitted_existing++;
        resultado.bySource[scoutId].omitted_existing++;
        continue;
      }

      // 2. Otra fuente de más prioridad ya reclamó esta entidad.
      //
      // Se comparan LAS DOS claves, no "la mejor que haya". CSLB no conserva
      // dirección, así que su única firma es el nombre; HCAI y HUD tienen
      // nombre+dirección. Comparando solo la clave más específica de cada uno,
      // "harborgeneralhospital" nunca coincidiría con
      // "harborgeneralhospital|555medicalcenterdr", y CSLB duplicaría cada
      // entidad que otra fuente ya hubiera traído.
      const firmas = [cross, name].filter(Boolean);
      const firmaReclamada = firmas.find((f) => reclamadas.has(f));
      if (firmaReclamada) {
        const firma = firmaReclamada;
        const dueño = reclamadas.get(firma);
        resultado.omitted.push({
          scoutId, dedupKey: c.dedupKey, reason: 'misma_entidad_en_otra_fuente',
          wonBy: dueño.scoutId, wonKey: dueño.dedupKey,
          why: PRIORITY_RATIONALE[dueño.scoutId],
        });
        resultado.conflicts.push({
          signature: firma, winner: dueño.scoutId, loser: scoutId,
          winnerKey: dueño.dedupKey, loserKey: c.dedupKey,
          rationale: PRIORITY_RATIONALE[dueño.scoutId],
        });
        resultado.totals.omitted_cross_source++;
        resultado.bySource[scoutId].omitted_cross_source++;
        continue;
      }
      // El ganador reclama todas sus firmas, para que una fuente posterior con
      // menos información tampoco pueda colarse.
      for (const f of firmas) reclamadas.set(f, { scoutId, dedupKey: c.dedupKey });

      resultado.create.push({ scoutId, candidate: c });
      resultado.totals.create++;
      resultado.bySource[scoutId].create++;
    }
  }

  resultado.generatedAt = new Date(now).toISOString();
  return resultado;
}

/**
 * Motivos por los que una sync central se rechaza, antes de hacer nada.
 *
 * Están en una lista con su comprobación para que el rechazo sea una decisión
 * declarada y no el resultado de que alguien se acordara de poner un `if`.
 */
export const SYNC_REFUSALS = Object.freeze([
  { code: 'outbound_activo', when: (ctx) => ctx.config?.outbound?.enabled !== false,
    why: 'OUTBOUND_ENABLED tiene que ser false' },
  { code: 'objeto_no_permitido', when: (ctx) => (ctx.objects || []).some((o) => o !== 'companies'),
    why: 'solo se escriben Companies: ni People, ni Opportunities, ni notas, ni mensajes' },
  { code: 'operacion_no_permitida', when: (ctx) => (ctx.operations || []).some((o) => !['create'].includes(o)),
    why: 'solo creaciones: actualizar lo existente exige un enriquecimiento previsualizado aparte, y borrar no se contempla' },
  { code: 'por_encima_del_tope', when: (ctx) => Object.values(ctx.perSource || {}).some((n) => n > 50),
    why: 'más de 50 por fuente' },
  { code: 'fuente_deshabilitada', when: (ctx) => (ctx.disabledSources || []).length > 0,
    why: 'alguna fuente del plan no está habilitada' },
  { code: 'constancia_o_cuota_vencida', when: (ctx) => (ctx.staleSources || []).length > 0,
    why: 'constancia o cuota vencida en alguna fuente' },
  { code: 'staging_alterado', when: (ctx) => (ctx.invalidStagings || []).length > 0,
    why: 'algún staging no valida su hash, su frescura o su privacidad' },
]);

/** Comprueba los rechazos. Devuelve la lista de los que aplican, vacía si todo bien. */
export function refusalsFor(ctx) {
  assertOutboundDisabled(ctx.config);
  return SYNC_REFUSALS.filter((r) => r.when(ctx)).map((r) => ({ code: r.code, why: r.why }));
}

/** Los tres scouts, en el orden de prioridad documentado. */
export function prioritizedScoutIds() {
  return SOURCE_PRIORITY.filter((id) => SCOUT_IDS.includes(id));
}

export default reconcile;
