import { config } from '../../config.js';
import { apiFetch, apiFetchText } from '../http.js';
import { parseCsv, pick, pickDate } from './csv.js';
import { withinServiceArea } from '../geo.js';

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

  // ── San Diego: otro portal y otro formato ──
  //
  // Los Ángeles y San Francisco publican en Socrata, con filtros en el servidor.
  // San Diego publica ficheros CSV planos: no hay $where ni $order, así que se
  // descarga entero y se filtra aquí. Por eso estas fuentes llevan `kind: 'csv'`.
  //
  // Los nombres de columna se declaran como lista de variantes (ver `pick`):
  // el portal las ha renombrado entre versiones y una fuente que asume un único
  // nombre devuelve filas vacías sin avisar el día que cambie.
  sd_active_businesses: {
    label: 'Negocios activos · Ciudad de San Diego',
    kind: 'csv',
    signalType: 'new_business',
    domain: 'seshat.datasd.org',
    // Ruta conocida del fichero; si cambia, se resuelve por el catálogo CKAN.
    urls: ['https://seshat.datasd.org/ttcs/sd_businesses_active_datasd.csv'],
    ckan: { host: 'data.sandiego.gov', package: 'business-listings', match: /active.*\.csv$/i },
    dateFields: ['date_business_start', 'business_start_dt', 'date_account_creation', 'created_date'],
    areaFilter: true,
    map: (row) => {
      const street = [pick(row, ['address_no', 'street_number']), pick(row, ['address_pd', 'address_dir']),
        pick(row, ['address_road', 'street_name']), pick(row, ['address_sfx', 'street_suffix']),
        pick(row, ['suite', 'address_suite'])].filter(Boolean).join(' ').trim();
      return {
        sourceId: pick(row, ['account_key', 'certificate_number', 'account_number']),
        businessName: titleCase(pick(row, ['dba_name', 'business_name', 'name'])),
        contactName: titleCase(pick(row, ['ownership_name', 'business_owner_name', 'owner_name'])),
        address: street || pick(row, ['address', 'street_address', 'business_address']),
        city: titleCase(pick(row, ['address_city', 'city', 'business_city'], 'San Diego')),
        zip: pick(row, ['address_zip', 'zip', 'business_zip', 'zip_code']).slice(0, 5),
        phone: pick(row, ['business_phone', 'phone', 'phone_number']),
        description: pick(row, ['naics_description', 'business_activity', 'description']),
        naics: pick(row, ['naics_code', 'naics']),
        lat: pick(row, ['latitude', 'lat']),
        lon: pick(row, ['longitude', 'lon', 'lng']),
        signal: {
          type: 'new_business',
          openedAt: (pickDate(row, ['date_business_start', 'business_start_dt', 'date_account_creation'])
            || new Date(0)).toISOString().slice(0, 10),
          naicsDescription: pick(row, ['naics_description', 'business_activity']),
        },
      };
    },
  },

  sd_development_permits: {
    label: 'Permisos de obra · Ciudad de San Diego',
    kind: 'csv',
    signalType: 'permit_finaled',
    domain: 'seshat.datasd.org',
    urls: ['https://seshat.datasd.org/permits/permits_set1_datasd.csv'],
    ckan: { host: 'data.sandiego.gov', package: 'development-permits', match: /permits.*\.csv$/i },
    dateFields: ['date_close', 'date_approval_issue', 'approval_close_dt', 'issue_date'],
    areaFilter: true,
    map: (row) => ({
      sourceId: pick(row, ['approval_id', 'permit_number', 'permit_id', 'project_id']),
      businessName: titleCase(pick(row, ['applicant', 'contractor_name', 'applicant_name'], 'Contratista')),
      contactName: '',
      address: pick(row, ['address', 'job_address', 'project_address', 'address_location']),
      city: titleCase(pick(row, ['city', 'job_city'], 'San Diego')),
      zip: pick(row, ['zip', 'zip_code', 'job_zip']).slice(0, 5),
      phone: '',
      description: pick(row, ['approval_type', 'permit_type', 'scope']),
      naics: '',
      lat: pick(row, ['latitude', 'lat']),
      lon: pick(row, ['longitude', 'lon', 'lng']),
      signal: {
        type: 'permit_finaled',
        permit: pick(row, ['approval_id', 'permit_number']),
        permitType: pick(row, ['approval_type', 'permit_type']),
        finaledAt: (pickDate(row, ['date_close', 'date_approval_issue', 'issue_date'])
          || new Date(0)).toISOString().slice(0, 10),
        valuation: Number(pick(row, ['valuation', 'job_value', 'estimated_cost'], '0')) || null,
        work: pick(row, ['scope', 'description', 'project_scope']).slice(0, 240),
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
 * Pregunta al catálogo CKAN dónde está hoy el fichero de un dataset.
 *
 * Los portales CKAN mueven los ficheros de sitio entre versiones. La ruta
 * conocida se prueba primero porque es una petición menos; esto es la red de
 * seguridad para el día que esa ruta devuelva 404, y evita que la fuente haya
 * que arreglarla a mano.
 */
export async function resolveCkanResource({ host, package: pkg, match }, baseOverride) {
  const base = baseOverride || `https://${host}`;
  const url = new URL('/api/3/action/package_show', base);
  url.searchParams.set('id', pkg);

  const body = await apiFetch(url.toString());
  const resources = body?.result?.resources || [];
  const hit = resources.find((r) => match.test(String(r.url || '')))
    || resources.find((r) => /csv/i.test(String(r.format || '')));
  if (!hit?.url) throw new Error(`CKAN no devolvió fichero para ${pkg}`);
  return hit.url;
}

/** Localiza el fichero de una fuente CSV: ruta conocida primero, catálogo después. */
async function resolveCsvUrl(source, baseOverride) {
  const candidates = baseOverride
    ? (source.urls || []).map((u) => new URL(new URL(u).pathname, baseOverride).toString())
    : (source.urls || []);

  for (const candidate of candidates) {
    try {
      return { url: candidate, text: await apiFetchText(candidate) };
    } catch {
      // Ruta caducada: lo resuelve el catálogo.
    }
  }
  if (!source.ckan) throw new Error(`Sin ruta utilizable para ${source.label}`);

  const resolved = await resolveCkanResource(source.ckan, baseOverride);
  const url = baseOverride ? new URL(new URL(resolved).pathname, baseOverride).toString() : resolved;
  return { url, text: await apiFetchText(url) };
}

/**
 * Caché del fichero ya procesado.
 *
 * El listado de negocios de San Diego son decenas de miles de filas en un solo
 * fichero. Una corrida que quiere 300 correos da muchas vueltas, y bajarse el
 * fichero entero en cada una sería descargar lo mismo cuarenta veces: lento para
 * nosotros y un abuso del portal, que es justo lo que este sistema no hace.
 */
const csvCache = new Map(); // clave → { rows, at }
const CSV_TTL_MS = 30 * 60 * 1000;

export function _clearCsvCache() { csvCache.clear(); }

/**
 * Lee una fuente CSV. El portal no filtra ni ordena, así que aquí se hace lo
 * que Socrata haría en el servidor: quedarse con lo reciente, poner lo más
 * nuevo delante y cortar la página pedida.
 *
 * `offset` es lo que hace posible pedir más de una tanda: sin él, cada ronda se
 * llevaría otra vez las mismas filas más recientes y la segunda no encontraría
 * más que duplicados.
 */
async function fetchCsvSource(source, { sinceDays, limit, offset = 0, baseOverride }) {
  const cacheKey = `${source.label}|${sinceDays}|${baseOverride || ''}`;
  const hit = csvCache.get(cacheKey);

  let entry;
  if (hit && Date.now() - hit.at < CSV_TTL_MS) {
    entry = hit;
  } else {
    const { url, text } = await resolveCsvUrl(source, baseOverride);
    const rows = parseCsv(text);
    const cutoff = new Date(Date.now() - sinceDays * 86400000);

    const mapped = [];
    for (const row of rows) {
      const date = pickDate(row, source.dateFields || []);
      // Sin fecha no hay señal: no sabemos si abrió ayer o hace quince años.
      if (!date || date < cutoff) continue;
      const prospect = source.map(row);
      if (!prospect.businessName) continue;
      mapped.push({ ...prospect, _date: date, raw: row });
    }
    // Orden estable: sin él, dos filas de la misma fecha podrían intercambiarse
    // entre páginas y un prospecto se perdería o saldría dos veces.
    mapped.sort((a, b) => (b._date - a._date) || String(a.sourceId).localeCompare(String(b.sourceId)));

    entry = { rows: mapped, resourceUrl: url, scanned: rows.length, at: Date.now() };
    csvCache.set(cacheKey, entry);
  }

  return {
    rows: entry.rows.slice(offset, offset + limit).map(({ _date, ...p }) => p),
    resourceUrl: entry.resourceUrl,
    scanned: entry.scanned,
    available: entry.rows.length,
  };
}

/** Lee una fuente Socrata. */
async function fetchSocrataSource(source, { sinceDays, limit, baseOverride }) {
  const params = source.query({ sinceDays, limit });
  const headers = config.prospecting.socrataAppToken
    ? { 'X-App-Token': config.prospecting.socrataAppToken }
    : {};
  const rows = await apiFetch(buildUrl(source, params, baseOverride), { headers });
  if (!Array.isArray(rows)) return { rows: [], scanned: 0 };
  return { rows: rows.map((row) => ({ ...source.map(row), raw: row })), scanned: rows.length };
}

/**
 * Consulta una fuente y devuelve prospectos normalizados.
 * `baseOverride` permite apuntar a un servidor local en las pruebas.
 */
export async function fetchFromSource(key, { sinceDays, limit, offset = 0, baseOverride } = {}) {
  const source = SOURCES[key];
  if (!source) throw new Error(`Fuente desconocida: ${key}`);

  const opts = {
    sinceDays: sinceDays ?? (source.kind === 'csv' ? 90 : 30),
    limit: limit ?? 50,
    offset,
    baseOverride,
  };
  const { rows } = source.kind === 'csv'
    ? await fetchCsvSource(source, opts)
    : await fetchSocrataSource(source, opts);

  return rows
    .map((mapped) => {
      // El área de servicio se decide aquí, antes de gastar una visita web en
      // un negocio al que no podemos ir a limpiar.
      const area = source.areaFilter
        ? withinServiceArea({ city: mapped.city, zip: mapped.zip, lat: mapped.lat, lon: mapped.lon })
        : null;
      return { ...mapped, source: key, sourceLabel: source.label, area };
    })
    .filter((p) => !p.area || p.area.inside)
    .filter((p) => (p.businessName && p.businessName !== 'Contratista' ? true : Boolean(p.address)));
}

export default SOURCES;
