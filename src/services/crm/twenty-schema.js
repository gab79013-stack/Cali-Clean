/**
 * Contrato de esquema de Twenty CRM.
 *
 * Todos los nombres y enumeraciones de este archivo se leyeron de la propia
 * instancia, no de memoria ni de la documentación genérica:
 *
 *   GET {TWENTY_BASE_URL}/rest/open-api/core   → components.schemas.Company
 *   GET {TWENTY_BASE_URL}/rest/companies?limit=1&depth=0
 *
 * Verificado el 2026-10-04 contra "Twenty Api" v0.1 en crm.cali-clean.net.
 *
 * Si Twenty cambia de versión, vuelve a leer ese OpenAPI antes de tocar nada:
 * un nombre de campo inventado no falla en las pruebas, falla en producción.
 */

/** Objeto sobre el que trabaja el adaptador. */
export const OBJECTS = {
  companies: 'companies',
  people: 'people',
  opportunities: 'opportunities',
};

/**
 * Campos de Company tal y como los nombra la API. La clave es el nombre
 * interno que usamos en el código; el valor, el nombre real en Twenty.
 */
export const COMPANY_FIELDS = {
  name: 'name',
  domainName: 'domainName',           // LINKS
  sourceUrl: 'sourceUrl',             // LINKS
  businessEmail: 'businessEmail',     // EMAILS
  serviceArea: 'serviceArea',         // TEXT
  contactabilityStatus: 'contactabilityStatus', // SELECT
  leadScore: 'leadScore',             // SELECT
  leadStage: 'leadStage',             // SELECT
  leadSource: 'leadSource',           // SELECT
  lastVerified: 'lastVerified',       // DATE_TIME
  dedupKey: 'dedupKey',               // TEXT
  address: 'address',                 // ADDRESS
  accountOwnerId: 'accountOwnerId',   // relación con workspace member
};

/**
 * Campos que el adaptador NO escribe nunca.
 *
 * `noteTargets` son las notas que escribe el equipo y `accountOwnerId` es la
 * asignación del comercial: los dos son trabajo humano, y una sincronización
 * automática que los pisara destruiría información que nadie puede recuperar.
 * `accountOwnerId` solo se envía cuando el registro no tiene dueño todavía.
 */
export const NEVER_OVERWRITE = Object.freeze(['noteTargets', 'accountOwnerId']);

/** Valores admitidos. Enviar uno fuera de la lista devuelve 400. */
export const ENUMS = Object.freeze({
  contactabilityStatus: Object.freeze([
    'PUBLIC_BUSINESS_EMAIL',
    'PUBLIC_BUSINESS_PHONE',
    'CONTACT_FORM_ONLY',
    'NO_VERIFIED_CHANNEL',
    'OPTED_IN',
    'OPTED_OUT_DO_NOT_CONTACT',
  ]),
  leadScore: Object.freeze(['RATING_1', 'RATING_2', 'RATING_3', 'RATING_4', 'RATING_5']),
  leadSource: Object.freeze(['PUBLIC_WEBSITE', 'REFERRAL', 'INBOUND_WEBSITE', 'BUSINESS_DIRECTORY']),
  leadStage: Object.freeze([
    'NEW',
    'QUALIFIED',
    'READY_FOR_OUTREACH',
    'CONTACTED',
    'REPLIED',
    'OPPORTUNITY',
    'DO_NOT_CONTACT',
  ]),
  opportunityStage: Object.freeze(['NEW', 'SCREENING', 'MEETING', 'PROPOSAL', 'CUSTOMER']),
});

/**
 * `OPTED_IN` está deliberadamente fuera de lo que el adaptador puede escribir.
 * Es una afirmación de consentimiento y el sistema no tiene forma de probarla:
 * encontrar un correo publicado no es que alguien lo haya dado.
 */
export const FORBIDDEN_WRITE_VALUES = Object.freeze({
  contactabilityStatus: Object.freeze(['OPTED_IN']),
});

export function assertEnum(field, value) {
  const allowed = ENUMS[field];
  if (!allowed) throw new Error(`Campo sin enumeración conocida: ${field}`);
  if (!allowed.includes(value)) {
    throw new Error(`Valor inválido para ${field}: ${JSON.stringify(value)}. Admitidos: ${allowed.join(', ')}`);
  }
  const forbidden = FORBIDDEN_WRITE_VALUES[field] || [];
  if (forbidden.includes(value)) {
    throw new Error(`El adaptador no puede escribir ${field}=${value}: afirmaría un dato que no ha verificado.`);
  }
  return value;
}

// ── Constructores de los tipos compuestos ────────────────────
/** LINKS. Devuelve undefined si no hay URL: un objeto vacío borraría el valor. */
export function links(url, label = '') {
  const clean = String(url || '').trim();
  if (!clean) return undefined;
  return { primaryLinkUrl: clean, primaryLinkLabel: String(label || '').trim(), secondaryLinks: [] };
}

/** EMAILS. Igual: sin correo verificado no se envía el campo. */
export function emails(primary, additional = []) {
  const clean = String(primary || '').trim().toLowerCase();
  if (!clean) return undefined;
  return {
    primaryEmail: clean,
    additionalEmails: [...new Set(additional.map((e) => String(e).trim().toLowerCase()).filter(Boolean))],
  };
}

export function address({ street, city, postcode, state, country } = {}) {
  const parts = {
    addressStreet1: String(street || '').trim(),
    addressCity: String(city || '').trim(),
    addressPostcode: String(postcode || '').trim().slice(0, 10),
    addressState: String(state || '').trim(),
    addressCountry: String(country || '').trim(),
  };
  return Object.values(parts).some(Boolean) ? parts : undefined;
}

// ── Traducciones desde el modelo interno ─────────────────────
/** Puntuación 0-100 del ICP a la escala de cinco peldaños de Twenty. */
export function toLeadScore(icpScore) {
  // `Number(null)` y `Number('')` valen 0, y escribir RATING_1 por no tener
  // puntuación sería afirmar que el prospecto es malo cuando lo cierto es que
  // no se ha evaluado. Sin dato, el campo no se envía.
  if (icpScore === null || icpScore === undefined || icpScore === '') return undefined;
  const n = Number(icpScore);
  if (!Number.isFinite(n)) return undefined;
  const clamped = Math.max(0, Math.min(100, n));
  return `RATING_${Math.min(5, Math.floor(clamped / 20) + 1)}`;
}

/**
 * Estado de contactabilidad a partir de lo que se verificó de verdad.
 * Cada rama corresponde a una evidencia concreta; nada se deduce.
 */
export function toContactabilityStatus({ optedOut, businessEmail, phone, contactFormOnly } = {}) {
  if (optedOut) return 'OPTED_OUT_DO_NOT_CONTACT';
  if (businessEmail) return 'PUBLIC_BUSINESS_EMAIL';
  if (phone) return 'PUBLIC_BUSINESS_PHONE';
  if (contactFormOnly) return 'CONTACT_FORM_ONLY';
  return 'NO_VERIFIED_CHANNEL';
}

/**
 * Etapa del lead. `READY_FOR_OUTREACH` describe el estado del registro, no
 * autoriza ningún envío: el outbound sigue gobernado por OUTBOUND_ENABLED.
 */
export function toLeadStage({ stage, optedOut, hasVerifiedChannel } = {}) {
  if (optedOut) return 'DO_NOT_CONTACT';
  switch (stage) {
    case 'contacted': return 'CONTACTED';
    case 'qualified': return hasVerifiedChannel ? 'READY_FOR_OUTREACH' : 'QUALIFIED';
    case 'enriched':
    case 'discovered': return 'NEW';
    default: return 'NEW';
  }
}

/** De dónde salió el registro. Solo dos orígenes son posibles hoy. */
/**
 * Procedencia del lead, con los valores que el enum del CRM ya tiene.
 *
 * `public_record` es el caso de los registros oficiales: un catálogo público de
 * establecimientos con permiso. PUBLIC_WEBSITE sería mentir —a ese negocio no
 * se le ha visitado la web— y de los cuatro valores que existen, un registro
 * oficial es un directorio. No se añade un valor nuevo al enum: eso sería
 * cambiar el esquema del CRM del cliente.
 */
export function toLeadSource(channel) {
  if (channel === 'inbound') return 'INBOUND_WEBSITE';
  if (channel === 'public_record') return 'BUSINESS_DIRECTORY';
  if (channel === 'referral') return 'REFERRAL';
  return 'PUBLIC_WEBSITE';
}

/** Marca temporal de la última verificación, en el formato que acepta la API. */
export function toLastVerified(value) {
  if (!value) return undefined;
  const d = value instanceof Date ? value : new Date(String(value).replace(' ', 'T') + (String(value).includes('T') || String(value).endsWith('Z') ? '' : 'Z'));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export default COMPANY_FIELDS;
