/**
 * Calificación del piloto de embudo: explicable, y solo con lo que se puede
 * comprobar.
 *
 * La regla de oro aquí es la misma que en los scouts, aplicada a otro sitio: no
 * se escribe en el CRM nada que no se pueda sostener señalando dónde está la
 * evidencia. Eso descarta de entrada tres tentaciones:
 *
 *   · **No se toca `contactabilityStatus`.** Las 49 Companies de ABC lo tienen en
 *     `NO_VERIFIED_CHANNEL`, y eso es la verdad: ABC no publica correo ni
 *     teléfono. Subirlo a `PUBLIC_BUSINESS_EMAIL` sería inventar un canal.
 *   · **Nadie llega a `RATING_5`.** El tope sería "esto es un cliente
 *     probable", y para afirmarlo haría falta un canal verificado o una
 *     necesidad confirmada. No tenemos ninguno de los dos.
 *   · **`leadStage` llega a `QUALIFIED`, no a `READY_FOR_OUTREACH`.** Listo para
 *     contactar implica saber por dónde, y no se sabe.
 *
 * El esquema de Company de este espacio de trabajo **no tiene campo de tags**
 * (18 campos, comprobado contra su OpenAPI). Así que no se escriben tags: no se
 * crea un campo para que quepa una idea.
 */

/** Señales obligatorias: si una falla, la Company no se califica. */
export const SIGNALS_REQUIRED = Object.freeze([
  'provenance',        // leadSource de directorio + sourceUrl + dedupKey
  'commercialAddress', // calle + ciudad + ZIP de 5 dígitos, sin PO Box ni APT
  'inServiceArea',     // serviceArea del condado y ciudad dentro de él
  'freshlyVerified',   // lastVerified dentro de la ventana
  'businessName',      // el nombre no tiene componente de persona
]);

/** Ventana de frescura: más allá, lo que se verificó ya no describe el hoy. */
export const FRESHNESS_DAYS = 30;

/**
 * Peso del segmento. Sale del tipo de licencia del propio permiso, que es el
 * único dato que dice qué clase de local es, y está en el snapshot sellado.
 *
 * El orden no es arbitrario: es cuánta limpieza genera la actividad.
 */
export const SEGMENT_RATING = Object.freeze({
  // Cocina y sala, a diario.
  '41': { rating: 'RATING_4', why: 'restaurante con servicio de comida: cocina y sala, limpieza diaria' },
  '47': { rating: 'RATING_4', why: 'restaurante con servicio de comida: cocina y sala, limpieza diaria' },
  '75': { rating: 'RATING_4', why: 'brewpub con restaurante: producción y sala' },
  '42': { rating: 'RATING_4', why: 'local de consumo en barra: suelos y baños de alta rotación' },
  '48': { rating: 'RATING_4', why: 'local de consumo en barra: suelos y baños de alta rotación' },
  '61': { rating: 'RATING_4', why: 'local de consumo en barra: suelos y baños de alta rotación' },
  // Instalaciones grandes, uso regular pero menos intenso.
  '50': { rating: 'RATING_3', why: 'club con instalaciones propias: uso regular, superficie grande' },
  '51': { rating: 'RATING_3', why: 'club con instalaciones propias: uso regular, superficie grande' },
  '52': { rating: 'RATING_3', why: 'club de veteranos con sede: uso regular, superficie grande' },
  '57': { rating: 'RATING_3', why: 'licencia especial sobre premisa fija: uso regular' },
  '70': { rating: 'RATING_3', why: 'servicio restrictivo (hotel, club): zonas comunes' },
  '90': { rating: 'RATING_3', why: 'sala de música: aforo alto, limpieza entre eventos' },
  // Comercio con menos superficie y sin consumo en local.
  '20': { rating: 'RATING_2', why: 'comercio para llevar: superficie menor, sin consumo en local' },
  '21': { rating: 'RATING_2', why: 'comercio para llevar: superficie menor, sin consumo en local' },
  '49': { rating: 'RATING_2', why: 'licencia estacional: actividad discontinua' },
  '59': { rating: 'RATING_2', why: 'licencia estacional: actividad discontinua' },
  '60': { rating: 'RATING_2', why: 'licencia estacional: actividad discontinua' },
});

const NO_COMERCIAL = [
  /\bp\.?\s?o\.?\s*box\b/i, /\bpmb\b/i, /\bapt\b/i, /\bapartment\b/i,
  /\bresiden(ce|tial)\b/i, /\bunit\s*[0-9a-z]*\b/i, /\bspc\b|\bspace\b/i,
];

const clean = (v) => String(v ?? '').trim();

/**
 * Califica una Company con la evidencia que la acompaña.
 *
 * `company` es el registro del CRM tal como está. `evidence` es lo que el
 * snapshot sellado dice de ella: su tipo de licencia. Si no hay evidencia de
 * segmento, no se califica — adivinar el segmento por el nombre sería inventar.
 */
export function qualifyCompany(company, evidence, { now = Date.now(), freshnessDays = FRESHNESS_DAYS } = {}) {
  const señales = {};
  const motivos = [];

  // ── Procedencia intacta ──
  const dedupKey = clean(company?.dedupKey);
  const sourceUrl = clean(company?.sourceUrl?.primaryLinkUrl);
  señales.provenance = Boolean(dedupKey) && Boolean(sourceUrl)
    && company?.leadSource === 'BUSINESS_DIRECTORY';
  if (!señales.provenance) motivos.push('sin procedencia completa (dedupKey, sourceUrl y leadSource de directorio)');

  // ── Dirección comercial ──
  const a = company?.address || {};
  const calle = clean(a.addressStreet1);
  const ciudad = clean(a.addressCity);
  const zip = clean(a.addressPostcode).slice(0, 5);
  const direccionCompleta = Boolean(calle) && Boolean(ciudad) && /^\d{5}$/.test(zip);
  const pareceVivienda = NO_COMERCIAL.some((re) => re.test(`${calle} ${clean(a.addressStreet2)}`));
  señales.commercialAddress = direccionCompleta && !pareceVivienda;
  if (!direccionCompleta) motivos.push('dirección incompleta');
  else if (pareceVivienda) motivos.push('la dirección señala una vivienda o un apartado');

  // ── Ámbito ──
  señales.inServiceArea = clean(company?.serviceArea) === 'San Diego County, CA';
  if (!señales.inServiceArea) motivos.push(`serviceArea "${clean(company?.serviceArea) || '—'}" fuera del ámbito`);

  // ── Frescura ──
  const verificado = Date.parse(clean(company?.lastVerified));
  const dias = Number.isFinite(verificado) ? Math.floor((now - verificado) / 86400000) : null;
  señales.freshlyVerified = dias !== null && dias >= 0 && dias <= freshnessDays;
  if (!señales.freshlyVerified) {
    motivos.push(dias === null ? 'sin lastVerified legible' : `verificada hace ${dias} días (ventana ${freshnessDays})`);
  }

  // ── Nombre de negocio ──
  const nombre = clean(company?.name);
  const personaSuelta = /^[\p{Lu}][\p{L}'’-]+\s*,\s*[\p{Lu}][\p{L}'’-]+/u.test(nombre)
    || /^[\p{Lu}][\p{L}'’-]+\s+[\p{Lu}]\.?\s+[\p{Lu}][\p{L}'’-]+$/u.test(nombre);
  señales.businessName = Boolean(nombre) && !personaSuelta;
  if (!señales.businessName) motivos.push('el nombre no se puede afirmar de un negocio');

  // ── Segmento: del snapshot sellado, no del nombre ──
  // Sin valor no se rellena con ceros: `''.padStart(2, '0')` da '00', que es
  // "truthy", y entonces "no hay evidencia" se reporta como "el tipo 00 no tiene
  // peso documentado". Son dos cosas distintas y conviene no confundirlas.
  const bruto = clean(evidence?.licenseType);
  const tipo = bruto ? bruto.padStart(2, '0') : '';
  const segmento = SEGMENT_RATING[tipo] || null;
  señales.segment = Boolean(segmento);
  if (!segmento) {
    motivos.push(tipo
      ? `el tipo de licencia ${tipo} no tiene peso de segmento documentado`
      : 'sin evidencia de segmento: no se adivina por el nombre');
  }

  const faltan = SIGNALS_REQUIRED.filter((s) => señales[s] !== true);
  const qualified = faltan.length === 0 && señales.segment === true;

  return {
    qualified,
    dedupKey,
    name: nombre,
    signals: señales,
    missing: faltan,
    reasons: motivos,
    // Lo que se escribiría, y solo si está calificada.
    proposed: qualified
      ? { leadScore: segmento.rating, leadStage: 'QUALIFIED' }
      : null,
    // La explicación, en una frase que una persona pueda contrastar.
    explanation: qualified
      ? `${segmento.rating} · ${segmento.why} · tipo de licencia ${tipo}, `
        + `verificada hace ${dias} día(s), dirección comercial en ${ciudad}`
      : `no calificada: ${motivos.join('; ')}`,
    segment: segmento ? { licenseType: tipo, rating: segmento.rating, why: segmento.why } : null,
    verifiedDaysAgo: dias,
  };
}

/**
 * Nombre determinista de la Opportunity. Dos corridas sobre la misma Company dan
 * el mismo nombre, que es lo que permite detectar la que ya existe en vez de
 * crear una segunda.
 */
export function opportunityName(company) {
  return `Limpieza comercial · ${clean(company?.name)} · ${clean(company?.dedupKey)}`;
}

/** Etapa inicial: la primera del enum real del espacio de trabajo. */
export const OPPORTUNITY_INITIAL_STAGE = 'NEW';

/** Título determinista de la tarea de revisión humana. */
export function reviewTaskTitle(company) {
  return `Revisar lead calificado · ${clean(company?.name)} · ${clean(company?.dedupKey)}`;
}

export default { qualifyCompany, opportunityName, reviewTaskTitle };
