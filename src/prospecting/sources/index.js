import { config } from '../../config.js';
import { apiFetch } from '../http.js';

/**
 * Catálogo de fuentes de registros públicos.
 *
 * Todas son portales de datos abiertos de California (Socrata), consultables por
 * API sin credenciales. Añadir una ciudad es añadir una entrada aquí: el resto
 * del pipeline no cambia.
 *
 * Cada fuente declara cómo traduce una fila cruda al prospecto que entiende el
 * sistema, y qué señal de compra representa.
 */

const clean = (v) => String(v ?? '').trim();
const titleCase = (s) => clean(s).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

export const SOURCES = {
  // ── Permisos de obra finalizados: la señal más perecedera y más rentable ──
  la_building_permits: {
    label: 'Permisos de obra · Los Ángeles',
    signalType: 'permit_finaled',
    domain: 'data.lacity.org',
    dataset: 'yv23-pmwf',
    /**
     * Permisos cerrados en los últimos N días: la obra acaba de terminar y
     * alguien tiene que limpiarla antes de la entrega.
     */
    query: ({ sinceDays = 30, limit = 50 }) => ({
      $where: `status_date > '${isoDaysAgo(sinceDays)}' AND upper(status) like '%FINAL%'`,
      $order: 'status_date DESC',
      $limit: String(limit),
    }),
    map: (row) => ({
      sourceId: clean(row.pcis_permit_no || row.permit_nbr || row.assessor_book),
      businessName: titleCase(row.applicant_business_name || row.contractor_business_name || row.applicant_first_name
        ? `${row.applicant_business_name || row.contractor_business_name || ''}`.trim() || 'Contratista'
        : 'Contratista'),
      contactName: titleCase([row.applicant_first_name, row.applicant_last_name].filter(Boolean).join(' ')),
      address: clean([row.address_start, row.street_direction, row.street_name, row.street_suffix]
        .filter(Boolean).join(' ')),
      city: 'Los Angeles',
      zip: clean(row.zip_code).slice(0, 5),
      phone: '',
      description: clean(row.permit_type || row.permit_sub_type),
      naics: '',
      signal: {
        type: 'permit_finaled',
        permit: clean(row.pcis_permit_no),
        permitType: clean(row.permit_type),
        finaledAt: clean(row.status_date).slice(0, 10),
        valuation: Number(row.valuation || 0) || null,
        work: clean(row.work_desc_ext || row.use_desc).slice(0, 240),
      },
    }),
  },

  // ── Licencias de negocio activas: quién existe y a qué se dedica ──
  la_active_businesses: {
    label: 'Negocios activos · Los Ángeles',
    signalType: 'new_business',
    domain: 'data.lacity.org',
    dataset: '6rrh-rzua',
    query: ({ sinceDays = 90, limit = 50 }) => ({
      $where: `location_start_date > '${isoDaysAgo(sinceDays)}'`,
      $order: 'location_start_date DESC',
      $limit: String(limit),
    }),
    map: (row) => ({
      sourceId: clean(row.location_account || row.primary_naics_description),
      businessName: titleCase(row.business_name || row.dba_name),
      contactName: '',
      address: clean(row.street_address),
      city: titleCase(row.city || 'Los Angeles'),
      zip: clean(row.zip_code).slice(0, 5),
      phone: '',
      description: clean(row.primary_naics_description),
      naics: clean(row.naics),
      signal: {
        type: 'new_business',
        openedAt: clean(row.location_start_date).slice(0, 10),
        naicsDescription: clean(row.primary_naics_description),
      },
    }),
  },

  // ── San Francisco: mismo patrón, otro portal ──
  sf_registered_businesses: {
    label: 'Negocios registrados · San Francisco',
    signalType: 'new_business',
    domain: 'data.sfgov.org',
    dataset: 'g8m3-pdis',
    query: ({ sinceDays = 90, limit = 50 }) => ({
      $where: `dba_start_date > '${isoDaysAgo(sinceDays)}'`,
      $order: 'dba_start_date DESC',
      $limit: String(limit),
    }),
    map: (row) => ({
      sourceId: clean(row.ttxid || row.location_id),
      businessName: titleCase(row.dba_name || row.ownership_name),
      contactName: '',
      address: clean(row.full_business_address),
      city: titleCase(row.city || 'San Francisco'),
      zip: clean(row.business_zip).slice(0, 5),
      phone: '',
      description: clean(row.naic_code_description),
      naics: clean(row.naic_code),
      signal: {
        type: 'new_business',
        openedAt: clean(row.dba_start_date).slice(0, 10),
        naicsDescription: clean(row.naic_code_description),
      },
    }),
  },

  sf_building_permits: {
    label: 'Permisos de obra · San Francisco',
    signalType: 'permit_finaled',
    domain: 'data.sfgov.org',
    dataset: 'i98e-djp9',
    query: ({ sinceDays = 30, limit = 50 }) => ({
      $where: `completed_date > '${isoDaysAgo(sinceDays)}'`,
      $order: 'completed_date DESC',
      $limit: String(limit),
    }),
    map: (row) => ({
      sourceId: clean(row.permit_number),
      businessName: titleCase(row.applicant || 'Contratista'),
      contactName: '',
      address: clean([row.street_number, row.street_name, row.street_suffix].filter(Boolean).join(' ')),
      city: 'San Francisco',
      zip: clean(row.zipcode).slice(0, 5),
      phone: '',
      description: clean(row.permit_type_definition),
      naics: '',
      signal: {
        type: 'permit_finaled',
        permit: clean(row.permit_number),
        finaledAt: clean(row.completed_date).slice(0, 10),
        valuation: Number(row.estimated_cost || 0) || null,
        work: clean(row.description).slice(0, 240),
      },
    }),
  },
};

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 19);
}

/** Construye la URL Socrata de una fuente. Se expone para poder probarla. */
export function buildUrl(source, params, baseOverride) {
  const base = baseOverride || `https://${source.domain}`;
  const url = new URL(`/resource/${source.dataset}.json`, base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

/**
 * Consulta una fuente y devuelve prospectos normalizados.
 * `baseOverride` permite apuntar a un servidor local en las pruebas.
 */
export async function fetchFromSource(key, { sinceDays, limit, baseOverride } = {}) {
  const source = SOURCES[key];
  if (!source) throw new Error(`Fuente desconocida: ${key}`);

  const params = source.query({ sinceDays: sinceDays ?? 30, limit: limit ?? 50 });
  const headers = config.prospecting.socrataAppToken
    ? { 'X-App-Token': config.prospecting.socrataAppToken }
    : {};

  const rows = await apiFetch(buildUrl(source, params, baseOverride), { headers });
  if (!Array.isArray(rows)) return [];

  return rows.map((row) => {
    const mapped = source.map(row);
    return { ...mapped, source: key, sourceLabel: source.label, raw: row };
  }).filter((p) => p.businessName && p.businessName !== 'Contratista' ? true : Boolean(p.address));
}

export default SOURCES;
