/**
 * Registro de los scouts de la fase 3: manifiesto, puerta y guard duro.
 *
 * Separado del allowlist de San Diego a propósito. Cada scout responde por su
 * propio manifiesto (`config/scouts/<id>.json`), su propia evidencia
 * (`config/source-attestation-<slug>.json` con su digest), su propia cuota y su
 * propia decisión operativa. Que una fuente esté en regla no dice nada de otra.
 *
 * La puerta tiene las mismas dos capas que ya gobiernan County y City, y en el
 * mismo orden, porque el orden es parte de la respuesta:
 *
 *   elegible → habilitada → implementada → constancia vigente
 *
 * Un scout no sale a la red si falla cualquiera de las cuatro, y hoy fallan
 * todos en la cuarta: su evidencia está marcada como pendiente porque Cloud no
 * tiene egress a sus hosts y no puede auditarla. Eso es fail-closed funcionando,
 * no un error que arreglar.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../../config.js';
import { attestationFor } from '../sources/attestation.js';

/**
 * Los scouts activos del catálogo.
 *
 * `hcai_facilities` ya no está: se retiró el 2026-10-04 porque el robots.txt de
 * data.chhs.ca.gov prohíbe las rutas que su scout necesitaba. `cslb_contractors`
 * tampoco: su portal rechaza la descarga con un 403 del WAF y no se intenta
 * sortear, así que dejó de ser una opción activa y la sustituye
 * `city_development_permits`. Las dos tienen su expediente en docs/retired/.
 */
export const SCOUT_IDS = Object.freeze(['hud_multifamily', 'cde_schools', 'city_development_permits']);

/** Dónde vive el manifiesto de cada scout. */
const manifestDir = () => process.env.SCOUT_MANIFEST_DIR || path.join(ROOT, 'config', 'scouts');

let cache = null;

export function loadManifests({ reload = false, dir = manifestDir() } = {}) {
  if (cache && !reload) return cache;
  const out = {};
  for (const id of SCOUT_IDS) {
    const file = path.join(dir, `${id}.json`);
    try {
      out[id] = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      // Un manifiesto ilegible no se sustituye por valores por defecto: el scout
      // se queda sin manifiesto y la puerta lo bloquea.
      out[id] = { scoutId: id, broken: true, error: err.message };
    }
  }
  cache = out;
  return out;
}

export function manifestFor(scoutId, opts = {}) {
  return loadManifests(opts)[scoutId] || null;
}

/** Campos que un scout puede conservar, según su manifiesto. */
/**
 * Allowlist cerrada de campos del scout.
 *
 * Lanza si el manifiesto no declara ninguna, y no devuelve `[]`: una lista vacía
 * recortaría cada fila a un objeto vacío, `assertOnlyAllowed` no encontraría nada
 * que prohibir, y el control se volvería decorativo justo donde tiene que morder.
 */
export function allowedFields(scoutId) {
  const lista = manifestFor(scoutId)?.fields?.allowed;
  if (!Array.isArray(lista) || lista.length === 0) {
    throw new Error(
      `El manifiesto de ${scoutId} no declara fields.allowed. Sin allowlist no se recorta nada, `
      + 'y un recorte vacío no es seguro: es un control que no comprueba.',
    );
  }
  return lista;
}

/** Campos que no se piden nunca al servidor. */
export function neverRequested(scoutId) {
  return manifestFor(scoutId)?.fields?.neverRequested || [];
}

/**
 * Guard duro del outbound.
 *
 * No devuelve un valor: lanza. Un guard que se pueda ignorar leyendo mal su
 * resultado no es un guard, y esta fase no envía nada bajo ninguna
 * circunstancia.
 */
export function assertOutboundDisabled(config) {
  if (config?.outbound?.enabled !== false) {
    throw new Error(
      'OUTBOUND_ENABLED tiene que ser false para correr cualquier parte de la fase 3. '
      + `Vale ${JSON.stringify(config?.outbound?.enabled)}. No se continúa.`,
    );
  }
  return true;
}

/**
 * ¿Puede este scout salir a la red ahora mismo?
 *
 * Devuelve el motivo exacto cuando no, para que un informe lo pueda explicar sin
 * que nadie tenga que leer el código.
 */
export function checkScoutAllowed(scoutId, { now = Date.now(), maxAgeDays = 180 } = {}) {
  if (!SCOUT_IDS.includes(scoutId)) {
    return { allowed: false, reason: 'scout_desconocido' };
  }
  const m = manifestFor(scoutId);
  if (!m || m.broken) {
    return { allowed: false, reason: 'sin_manifiesto', detail: m?.error || 'no se pudo leer el manifiesto' };
  }
  // El robots del publicador va PRIMERO, y no se puede sortear con un flag.
  //
  // Esto está aquí porque pasó: el robots.txt de data.chhs.ca.gov resultó ser
  // legible y prohibir `/api/` para `User-agent: *`, justo la ruta que el scout
  // usaría. Si ese "no" viviera solo en `enabled`, bastaría con que alguien
  // pusiera enabled=true para pasar por encima de lo que el publicador dijo.
  // Vive aquí para que no se pueda.
  if (m.robots?.disallowsOurPath === true) {
    return {
      allowed: false,
      reason: 'robots_prohibe',
      state: m.state,
      detail: m.robots.disallowReason || 'el robots.txt del publicador prohíbe la ruta que este scout usaría',
      overridable: false,
    };
  }
  // Y un robots que nadie ha leído tampoco abre la puerta.
  //
  // El manifiesto de CDE lo dice con palabras —"desconocer no es permiso"— pero
  // una frase en un JSON no detiene nada. Mientras `disallowsOurPath` no sea un
  // `false` comprobado, la puerta se queda cerrada, y tampoco esto se sortea con
  // un flag: `enabled: true` sobre un robots sin leer no es una decisión, es un
  // descuido.
  if (m.robots?.disallowsOurPath !== false) {
    return {
      allowed: false,
      reason: 'robots_sin_leer',
      state: m.state,
      detail: m.robots?.interpretation
        || 'el robots.txt del publicador no se ha leído, y no leerlo no equivale a que permita',
      overridable: false,
    };
  }
  if (m.eligible !== true) {
    return { allowed: false, reason: 'no_elegible', state: m.state, detail: m.decision };
  }
  if (m.enabled !== true) {
    return {
      allowed: false, reason: 'no_habilitada', state: m.state, eligible: true,
      detail: m.decision, blockers: m.blockers || [],
    };
  }
  if (m.implemented !== true) {
    return { allowed: false, reason: 'acceso_no_implementado', state: m.state, eligible: true };
  }

  const att = attestationFor(scoutId, { now, maxAgeDays });
  if (!att.ok) {
    return {
      allowed: false,
      reason: att.reason === 'fuente_no_atestiguada' ? 'sin_constancia_operativa' : 'constancia_invalida',
      state: m.state,
      eligible: true,
      detail: (att.problems || []).join('; ') || att.reason,
    };
  }
  // La verificación en vivo desde Cloud no se da por hecha: mientras la
  // evidencia no se haya obtenido desde aquí, se dice.
  return {
    allowed: true,
    state: m.state,
    eligible: true,
    attestationFile: att.file,
    liveVerifiedFromCloud: att.checks?.liveVerifiedFromCloud === true,
  };
}

export function assertScoutAllowed(scoutId, opts) {
  const check = checkScoutAllowed(scoutId, opts);
  if (!check.allowed) {
    const err = new Error(
      `El scout "${scoutId}" no puede salir a la red: ${check.reason}`
      + (check.detail ? ` (${check.detail})` : ''),
    );
    err.code = check.reason;
    err.scoutId = scoutId;
    throw err;
  }
  return check;
}

/** Estado de los tres, para un informe o un panel. */
export function scoutStatus(opts = {}) {
  return SCOUT_IDS.map((id) => {
    const m = manifestFor(id) || {};
    return {
      scoutId: id,
      displayName: m.displayName || id,
      label: m.label || id,
      accessType: m.accessType || null,
      egressHost: m.egressHost || null,
      dedupNamespace: m.dedupNamespace || null,
      state: m.state || 'SIN_MANIFIESTO',
      eligible: m.eligible === true,
      enabled: m.enabled === true,
      implemented: m.implemented === true,
      maxAcceptedPerRun: m.limits?.maxAcceptedPerRun ?? null,
      blockers: m.blockers || [],
      ...checkScoutAllowed(id, opts),
    };
  });
}

/** Los hosts que habría que permitir para una preview real. Uno por scout. */
export function requiredEgressHosts() {
  return SCOUT_IDS.map((id) => manifestFor(id)?.egressHost).filter(Boolean);
}

/** Métricas de una corrida de scout. Solo recuentos, nunca filas. */
export const emptyScoutMetrics = () => ({
  requests: 0,
  bytes: 0,
  fetched: 0,
  accepted: 0,
  rejected_personal: 0,
  rejected_residential: 0,
  rejected_inactive: 0,
  rejected_out_of_area: 0,
  rejected_unverifiable: 0,
  rejected_malformed: 0,
  // Razones que trajo la fuente de permisos: un permiso viejo, una obra que no es
  // comercial, una clasificación que no distingue vivienda de local, y un tipo de
  // permiso que no es obra que haya que limpiar. Cada una tiene su contador porque
  // "rechazado" sin más no deja revisar si el filtro está bien calibrado.
  rejected_stale: 0,
  rejected_not_commercial: 0,
  rejected_mixed_use_ambiguous: 0,
  rejected_not_relevant: 0,
  deduped: 0,
  // Candidatos válidos que quedaron fuera por el tope de la corrida.
  over_cap: 0,
  retries: 0,
  http429: 0,
  quota_blocked: 0,
  errors: 0,
  duration_ms: 0,
  // Invariantes de la fase, medidas y reportadas en cada corrida.
  crm_writes: 0,
  outbound: 0,
});

/**
 * Suma un rechazo a la métrica que le corresponde por su `kind`.
 *
 * Un `kind` que no tenga contador cae en `rejected_unverifiable` en lugar de
 * crear un campo nuevo: así la suma de los contadores sigue cuadrando con las
 * filas leídas, y una regla que devuelva un `kind` mal escrito se nota en que
 * los no-verificables suben sin motivo, no en que una fila desaparezca.
 */
export function countRejection(metrics, kind) {
  const campo = `rejected_${kind || 'unverifiable'}`;
  if (metrics[campo] === undefined) metrics.rejected_unverifiable++;
  else metrics[campo]++;
  return metrics;
}

export default loadManifests;
