import { config } from '../../config.js';
import { apiFetch } from '../http.js';
import { assertSourceAllowed, checkSourceAllowed } from './compliance.js';

/**
 * Catálogo de fuentes de registros públicos del área de San Diego.
 *
 * Dos cosas que este archivo hace cumplir y que no son opcionales:
 *
 * 1. Ninguna fuente se consulta sin una verificación registrada de su
 *    robots.txt, sus términos y su endpoint real. La puerta está en
 *    `fetchFromSource`, no en la documentación.
 *
 * 2. Los nombres de columna se declaran como candidatos, no como certezas. Si
 *    el portal no trae ninguno de los candidatos de un campo obligatorio, la
 *    fila se descarta en lugar de inventarse: una columna mal adivinada
 *    produciría prospectos plausibles y falsos, que es el peor resultado
 *    posible.
 *
 * Para habilitar una fuente:  node scripts/verify-sources.js <clave>
 */

const clean = (v) => String(v ?? '').trim();
const titleCase = (s) => clean(s).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** Primer campo presente entre varios candidatos. */
function pick(row, candidates) {
  for (const c of candidates) {
    const v = row?.[c];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

export const SERVICE_AREA = 'San Diego County, CA';

export const SOURCES = {
  // ── Permisos de obra cerrados: la señal más perecedera y más rentable ──
  sd_building_permits: {
    label: 'Permisos de obra · Ciudad de San Diego',
    serviceArea: SERVICE_AREA,
    signalType: 'permit_finaled',
    domain: 'data.sandiego.gov',
    dataset: 'development-permits-set1',
    api: 'socrata',
    compliance: {
      robotsUrl: 'https://data.sandiego.gov/robots.txt',
      termsUrl: 'https://data.sandiego.gov/terms/',
      portal: 'https://data.sandiego.gov/datasets/',
      note: 'Portal de datos abiertos de la Ciudad de San Diego.',
    },
    query: ({ sinceDays = 30, limit = 50 }) => ({
      $where: `date_close > '${isoDaysAgo(sinceDays)}'`,
      $order: 'date_close DESC',
      $limit: String(limit),
    }),
    // Campos obligatorios para que la fila sirva de algo.
    requires: ['businessName', 'address'],
    fields: {
      sourceId: ['approval_id', 'permit_number', 'pmt_number', 'approval_number'],
      businessName: ['contractor_name', 'applicant_name', 'firm_name', 'company_name'],
      address: ['job_address', 'address', 'project_address', 'site_address'],
      city: ['city', 'job_city'],
      zip: ['zip', 'zip_code', 'job_zip', 'postal_code'],
      closedAt: ['date_close', 'close_date', 'completion_date', 'issue_date'],
      scope: ['scope', 'description', 'work_description', 'project_scope'],
      valuation: ['valuation', 'estimated_cost', 'job_value'],
    },
  },

  // ── Certificados de actividad nuevos: aún no tienen proveedor fijo ──
  sd_business_certificates: {
    label: 'Certificados de actividad · Ciudad de San Diego',
    serviceArea: SERVICE_AREA,
    signalType: 'new_business',
    domain: 'data.sandiego.gov',
    dataset: 'business-listings',
    api: 'socrata',
    compliance: {
      robotsUrl: 'https://data.sandiego.gov/robots.txt',
      termsUrl: 'https://data.sandiego.gov/terms/',
      portal: 'https://data.sandiego.gov/datasets/',
      note: 'Registro mercantil municipal. Solo datos de empresa, nunca de persona física.',
    },
    query: ({ sinceDays = 90, limit = 50 }) => ({
      $where: `creation_dt > '${isoDaysAgo(sinceDays)}'`,
      $order: 'creation_dt DESC',
      $limit: String(limit),
    }),
    requires: ['businessName'],
    fields: {
      sourceId: ['account_key', 'certificate_number', 'business_account'],
      businessName: ['dba_name', 'business_name', 'ownership_name'],
      address: ['address_full', 'address', 'business_address'],
      city: ['city', 'address_city'],
      zip: ['zip', 'address_zip', 'zip_code'],
      openedAt: ['creation_dt', 'date_account_creation', 'start_date'],
      naics: ['naics_code', 'naics', 'sic_code'],
      naicsDescription: ['naics_description', 'business_description', 'description'],
    },
  },

  // ── Condado de San Diego: cubre las ciudades fuera del municipio ──
  sdcounty_business_licenses: {
    label: 'Licencias de actividad · Condado de San Diego',
    serviceArea: SERVICE_AREA,
    signalType: 'new_business',
    domain: 'data.sandiegocounty.gov',
    dataset: null,            // a confirmar durante la verificación
    api: 'socrata',
    compliance: {
      robotsUrl: 'https://data.sandiegocounty.gov/robots.txt',
      termsUrl: 'https://data.sandiegocounty.gov/about',
      portal: 'https://data.sandiegocounty.gov/browse',
      note: 'Falta identificar el dataset concreto antes de verificar.',
    },
    query: ({ sinceDays = 90, limit = 50 }) => ({
      $order: ':id DESC',
      $limit: String(limit),
    }),
    requires: ['businessName'],
    fields: {
      sourceId: ['id', 'license_number', 'account_number'],
      businessName: ['business_name', 'dba', 'dba_name'],
      address: ['address', 'street_address', 'site_address'],
      city: ['city'],
      zip: ['zip', 'zip_code', 'postal_code'],
      openedAt: ['issue_date', 'start_date', 'effective_date'],
      naics: ['naics', 'naics_code'],
      naicsDescription: ['naics_description', 'business_type', 'description'],
    },
  },
};

/** Traduce una fila cruda usando los candidatos declarados por la fuente. */
export function mapRow(source, row) {
  const f = source.fields;
  const get = (name) => (f[name] ? pick(row, f[name]) : '');

  const businessName = titleCase(get('businessName'));
  const mapped = {
    sourceId: get('sourceId'),
    businessName,
    // Ninguna fuente de registro público aporta contacto: lo busca el
    // enriquecedor en la web del propio negocio, y solo si allí está publicado.
    contactName: '',
    address: get('address'),
    city: titleCase(get('city')) || 'San Diego',
    zip: get('zip').slice(0, 5),
    phone: '',
    serviceArea: source.serviceArea,
    description: get('naicsDescription') || get('scope'),
    naics: get('naics'),
    signal: source.signalType === 'permit_finaled'
      ? {
        type: 'permit_finaled',
        permit: get('sourceId'),
        finaledAt: get('closedAt').slice(0, 10),
        valuation: Number(get('valuation')) || null,
        work: get('scope').slice(0, 240),
      }
      : {
        type: 'new_business',
        openedAt: get('openedAt').slice(0, 10),
        naicsDescription: get('naicsDescription'),
      },
  };

  // Si falta algo obligatorio, la fila no vale: devolver null es preferible a
  // devolver un prospecto a medias que luego nadie sabe de dónde salió.
  for (const required of source.requires || []) {
    if (!mapped[required]) return null;
  }
  return mapped;
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 19);
}

/** URL de consulta. Se expone para poder probarla sin red. */
export function buildUrl(source, params, baseOverride) {
  const base = baseOverride || `https://${source.domain}`;
  if (!source.dataset) throw new Error(`La fuente "${source.label}" no tiene dataset confirmado todavía.`);
  const url = new URL(`/resource/${source.dataset}.json`, base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

/** Fuentes habilitadas ahora mismo, con el motivo de las que no lo están. */
export function sourceStatus() {
  return Object.entries(SOURCES).map(([key, source]) => ({
    key,
    label: source.label,
    signalType: source.signalType,
    configured: config.prospecting.sources.includes(key),
    ...checkSourceAllowed(key, source),
  }));
}

/**
 * Consulta una fuente. Falla antes de salir a la red si no está verificada:
 * la puerta se cruza aquí, no en el llamante.
 */
export async function fetchFromSource(key, { sinceDays, limit, baseOverride } = {}) {
  const source = SOURCES[key];
  if (!source) throw new Error(`Fuente desconocida: ${key}`);
  // Sin puerta trasera: tampoco las pruebas la esquivan. Las que necesitan
  // consultar una fuente registran una constancia de verificación real.
  assertSourceAllowed(key, source);

  const params = source.query({ sinceDays: sinceDays ?? 30, limit: limit ?? 50 });
  const headers = config.prospecting.socrataAppToken
    ? { 'X-App-Token': config.prospecting.socrataAppToken }
    : {};

  const rows = await apiFetch(buildUrl(source, params, baseOverride), { headers });
  if (!Array.isArray(rows)) return [];

  return rows
    .map((row) => {
      const mapped = mapRow(source, row);
      return mapped ? { ...mapped, source: key, sourceLabel: source.label, raw: row } : null;
    })
    .filter(Boolean);
}

export default SOURCES;
