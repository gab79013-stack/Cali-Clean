/**
 * Planificador de enriquecimiento: qué se puede afirmar de una empresa que ya
 * está en el CRM, sin salir a buscarlo a ninguna parte.
 *
 * La regla que gobierna este archivo: **solo se propone lo que ya se sabe.** No
 * se visita ninguna web, no se adivina un dominio a partir del nombre, no se
 * infiere un teléfono y no se construye un correo. Si un campo no está
 * sustentado por un dato que ya tenemos, se deja vacío, y "vacío" aquí significa
 * que no se propone nada, no que se escriba una cadena en blanco encima de algo
 * que alguien puso a mano.
 *
 * Qué sí se puede deducir con reglas escritas:
 *   · **segmento / tipo** desde el NAICS o el tipo de establecimiento;
 *   · **área de servicio** desde el ZIP, cuando falta;
 *   · **Lead Score** desde señales objetivas, con los puntos tabulados abajo;
 *   · **Lead Stage** desde si hay un canal de contacto verificado.
 *
 * Y lo que no se toca nunca: `accountOwnerId`, notas, y cualquier campo que el
 * administrador haya rellenado a mano. Un planificador que sobrescribe el
 * trabajo de una persona no es útil, es una pérdida de confianza.
 */

import { segmentFromNaics } from './sources/city-btc-rules.js';
import { isInServiceArea } from '../services/scoring.js';
import { ENUMS } from '../services/crm/twenty-schema.js';

/**
 * Puntuación. Cada regla, su motivo y sus puntos, para que un score sea
 * explicable sin leer el código.
 *
 * El techo es deliberadamente bajo: sin canal de contacto verificado, un
 * prospecto no puede pasar de ahí, porque todavía no se le puede escribir.
 */
export const SCORE_RULES = Object.freeze([
  { id: 'canal_verificado', points: 25, why: 'hay un correo o teléfono comercial verificado', fromCrm: true },
  { id: 'dentro_del_area', points: 15, why: 'el ZIP está en el área de servicio', fromCrm: true },
  { id: 'procedencia_oficial', points: 10, why: 'viene de un registro público oficial, con URL comprobable', fromCrm: true },
  { id: 'direccion_completa', points: 10, why: 'calle, ciudad y ZIP: se puede visitar', fromCrm: true },
  // Las dos de abajo NO puntúan, y el motivo es la idempotencia, no su valor.
  //
  // El CRM no tiene campo para el tipo de establecimiento, el NAICS ni la forma
  // jurídica, así que esas señales solo se conocen leyendo los snapshots
  // locales, que viven en un contenedor efímero. Si puntuaran, el mismo
  // prospecto valdría 60 en el contenedor que tiene el snapshot y 35 en el
  // siguiente, y cada corrida propondría cambiar el score en una dirección
  // distinta para siempre.
  //
  // Un score que oscila no es información: es ruido con aspecto de dato. Así que
  // el score se calcula SOLO con lo que el propio CRM sostiene, y estas dos se
  // informan sin puntuar.
  { id: 'segmento_conocido', points: 15, why: 'el segmento del ICP está identificado', fromCrm: false },
  { id: 'entidad_juridica', points: 10, why: 'es una entidad, no una persona física', fromCrm: false },
]);

/** Puntos que puede dar el CRM por sí solo. El techo real de un score escrito. */
export const MAX_SCORE_FROM_CRM = SCORE_RULES
  .filter((r) => r.fromCrm)
  .reduce((sum, r) => sum + r.points, 0);

const RATING_THRESHOLDS = Object.freeze([
  { min: 70, rating: 'RATING_4' },
  { min: 50, rating: 'RATING_3' },
  { min: 30, rating: 'RATING_2' },
  { min: 0, rating: 'RATING_1' },
]);

/**
 * Comprueba que un valor propuesto existe en el vocabulario del CRM.
 *
 * Esto está aquí porque el planificador proponía la etapa `DISCOVERED`, que
 * suena razonable y NO existe: el enum real es NEW, QUALIFIED,
 * READY_FOR_OUTREACH, CONTACTED, REPLIED, OPPORTUNITY, DO_NOT_CONTACT. Un
 * PATCH con ese valor lo habría rechazado la API, y el planificador habría
 * seguido proponiéndolo en cada corrida sin que nada lo detuviera.
 *
 * Ahora el vocabulario sale de twenty-schema.js, que es el que se contrasta con
 * el esquema vivo, y un valor fuera de él lanza aquí en vez de en la red.
 */
function assertVocabulario(campo, valor) {
  const permitidos = ENUMS[campo];
  if (!permitidos) throw new Error(`No hay vocabulario declarado para "${campo}".`);
  if (!permitidos.includes(valor)) {
    throw new Error(`"${valor}" no está en el vocabulario de ${campo}: ${permitidos.join(', ')}`);
  }
  return valor;
}

/**
 * Índice de tipo y NAICS a partir de los snapshots locales.
 *
 * Hace falta porque el CRM **no tiene campo** para el tipo de establecimiento ni
 * para el NAICS: esos datos vienen del registro oficial y, al crear la empresa,
 * no hay dónde ponerlos sin añadir un campo al esquema del cliente. Así que para
 * asignar un segmento hay dos caminos: leerlo del dato oficial que trajimos
 * (esto), o adivinarlo del nombre comercial (que no se hace).
 *
 * "Lucys Bakery And Pizza" probablemente sea un restaurante, pero probablemente
 * no es verificable, y una ficha con un segmento inventado es peor que una sin
 * segmento: la primera se usa para decidir y la segunda se revisa.
 */
export function typeIndexFromSnapshots(snapshots = []) {
  const index = new Map();
  for (const doc of snapshots) {
    for (const row of doc?.rows || []) {
      if (!row?.dedupKey) continue;
      index.set(row.dedupKey, {
        businessType: row.raw?.business_type || row.description || null,
        naics: row.naics || row.raw?.naics_code || null,
        entityType: row.entityType || null,
        source: doc.sourceId || null,
        verifiedAt: doc.createdAt || null,
      });
    }
  }
  return index;
}

/** Segmento a partir de lo que ya hay en la ficha. */
export function segmentFor(company) {
  const naics = String(company.naics || '').replace(/\D/g, '');
  if (naics) {
    const fromNaics = segmentFromNaics(naics);
    if (fromNaics) return { segment: fromNaics, basis: `NAICS ${naics}` };
  }

  // Sin NAICS queda el tipo de establecimiento del condado, que es texto pero
  // con un vocabulario cerrado y conocido.
  const type = String(company.businessType || company.description || '').toLowerCase();
  if (!type) return { segment: null, basis: null };
  const rules = [
    // "Satellite Food Service Operation" es servicio de comidas en un local
    // ajeno (una cafetería dentro de otra instalación): comercial y con cocina.
    [/restaurant|food facility|food service|coffee|deli|bakery|caterer|market|taquer|pizza|grill|bar\b/, 'restaurants'],
    [/health care|medical|dental|clinic/, 'offices'],
    [/school|conference|church/, 'offices'],
    [/retail|store|shop/, 'retail'],
    [/property|real estate|management/, 'property_managers'],
    [/construction|contractor/, 'post_construction'],
  ];
  for (const [re, segment] of rules) {
    if (re.test(type)) return { segment, basis: `tipo de establecimiento "${type.slice(0, 40)}"` };
  }
  return { segment: null, basis: null };
}

/**
 * Plan de enriquecimiento de una empresa. Devuelve propuestas, nunca escrituras.
 *
 * `changes` solo lleva campos que de verdad cambiarían: un valor que ya está
 * puesto no se vuelve a proponer, y así una segunda pasada no propone nada. Eso
 * es lo que hace esto idempotente.
 */
export function planEnrichment(company, { serviceAreaDefault = 'San Diego County, CA', typeIndex = null } = {}) {
  const reasons = [];
  const changes = {};
  const hits = new Set();

  // El tipo oficial, si lo trajimos de la fuente. No se busca en ningún sitio
  // más y no se deduce del nombre.
  const official = typeIndex?.get?.(company.dedupKey) || null;
  const enriched = official
    ? {
      ...company,
      businessType: company.businessType ?? official.businessType,
      naics: company.naics ?? official.naics,
      entityType: company.entityType ?? official.entityType,
    }
    : company;

  // ── Segmento ──
  const { segment, basis } = segmentFor(enriched);
  if (segment) {
    hits.add('segmento_conocido');
    reasons.push(`segmento ${segment} (${basis})`);
  }

  // ── Área de servicio ──
  const zip = String(company.zip || company.address?.addressPostcode || '').slice(0, 5);
  const inArea = zip ? isInServiceArea(zip) : false;
  if (inArea) { hits.add('dentro_del_area'); reasons.push(`ZIP ${zip} dentro del área`); }
  if (!String(company.serviceArea || '').trim()) {
    // Solo se rellena si está vacío: si alguien escribió otra cosa, manda.
    changes.serviceArea = serviceAreaDefault;
    reasons.push('área de servicio vacía: se propone la del despliegue');
  }

  // ── Procedencia ──
  const sourceUrl = company.sourceUrl?.primaryLinkUrl || company.sourceUrl || '';
  if (/^https:\/\/(data\.sandiegocounty\.gov|data\.sandiego\.gov)\//.test(String(sourceUrl))) {
    hits.add('procedencia_oficial');
    reasons.push('procedencia: registro público oficial');
  }

  // ── Dirección ──
  const street = company.address?.addressStreet1 || company.address || '';
  const city = company.address?.addressCity || company.city || '';
  if (String(street).trim() && String(city).trim() && zip) {
    hits.add('direccion_completa');
    reasons.push('dirección completa');
  }

  // ── Entidad jurídica ──
  if (enriched.entityType) {
    hits.add('entidad_juridica');
    reasons.push(`forma jurídica ${enriched.entityType}`);
  }

  // ── Canal de contacto ──
  const email = company.businessEmail?.primaryEmail || company.email || '';
  const phone = company.phone || '';
  const hasChannel = Boolean(String(email).trim() || String(phone).trim());
  if (hasChannel) { hits.add('canal_verificado'); reasons.push('canal de contacto verificado'); }

  // Solo las señales que el CRM sostiene por sí mismo entran en el score. Ver el
  // comentario de SCORE_RULES: lo demás haría que el score oscilara según qué
  // snapshots tenga el contenedor de turno.
  const score = SCORE_RULES
    .filter((r) => r.fromCrm && hits.has(r.id))
    .reduce((sum, r) => sum + r.points, 0);
  const informativas = SCORE_RULES.filter((r) => !r.fromCrm && hits.has(r.id)).map((r) => r.id);
  const rating = RATING_THRESHOLDS.find((t) => score >= t.min).rating;

  if (company.leadScore !== rating) {
    changes.leadScore = assertVocabulario('leadScore', rating);
    reasons.push(`Lead Score ${rating} (${score}/${MAX_SCORE_FROM_CRM} posibles desde el CRM)`);
  }

  // ── Etapa ──
  // Sin canal verificado una empresa no puede estar cualificada: no hay por
  // dónde contactarla. Es una afirmación sobre lo que sabemos, no un juicio.
  //
  // Dos valores y nada más, los dos comprobados contra el vocabulario del CRM:
  //
  //   sin canal  → NEW        no hay por dónde escribirle
  //   con canal  → QUALIFIED  hay un canal verificado
  //
  // No se usa READY_FOR_OUTREACH, que existe: afirmaría que el prospecto está
  // listo para que se le escriba, y eso es una decisión de outreach, no una
  // consecuencia de tener un correo. El outbound está apagado.
  //
  // Y no se reutiliza `toLeadStage`, cuyo vocabulario de entrada es el del
  // pipeline de prospección (discovered/enriched/qualified/contacted): es otro
  // dominio, y traducir dos veces entre dos vocabularios es cómo apareció el
  // `DISCOVERED` inexistente. Lo que impide repetir ese fallo es el validador.
  const stage = assertVocabulario('leadStage', hasChannel ? 'QUALIFIED' : 'NEW');
  if (company.leadStage !== stage) {
    changes.leadStage = stage;
    reasons.push(`etapa ${stage}${hasChannel ? '' : ' (sin canal de contacto todavía)'}`);
  }

  // Lo que NO se propone, y conviene que se vea en el plan.
  const notProposed = [];
  // El campo no existe en el esquema del CRM. No se propone, no se pide un
  // permiso más alto y no se añade un campo al CRM del cliente: se informa.
  notProposed.push('segment/type: el esquema de Company no tiene campo para el segmento '
    + 'ni para el NAICS. Añadirlo sería cambiar el esquema del CRM');
  if (!segment) {
    notProposed.push(official
      ? `segmento: el tipo oficial "${String(official.businessType).slice(0, 40)}" no encaja en ninguna regla`
      : 'segmento: el CRM no guarda tipo ni NAICS y no se deduce del nombre comercial');
  }
  if (!email) notProposed.push('businessEmail: no hay correo sustentado por una fuente oficial');
  if (!company.domainName?.primaryLinkUrl) notProposed.push('domainName: no se adivina un dominio desde el nombre');
  if (!phone) notProposed.push('phone: no hay teléfono verificado');

  return {
    dedupKey: company.dedupKey || null,
    name: company.name || company.businessName || null,
    typeBasis: official ? `snapshot ${official.source} del ${String(official.verifiedAt).slice(0, 10)}` : null,
    // Señales conocidas que no puntúan porque el CRM no las sostiene.
    informativas,
    action: Object.keys(changes).length ? 'update' : 'noop',
    changes,
    score,
    rating,
    segment,
    reasons,
    notProposed,
  };
}

/** Plan para una lista de empresas, con el recuento por acción. */
export function planEnrichmentBatch(companies, opts = {}) {
  const plans = companies.map((c) => planEnrichment(c, opts));
  const tally = { update: 0, noop: 0 };
  for (const p of plans) tally[p.action]++;
  return { plans, tally };
}

export default planEnrichment;
