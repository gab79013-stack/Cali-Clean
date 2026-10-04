import { config } from '../../config.js';
import {
  assertSourceAllowed, checkSourceAllowed, allowlistEntry,
  allowedFields, forbiddenFields, scrubRow, isBannedDataset, rejectionFor,
} from './compliance.js';
import { sodaGet } from './soda-client.js';
import { withQuota, MAX_ROWS_PER_RUN } from './quota.js';
import { filterRow, assertNoForbidden } from './row-filter.js';

/**
 * Catálogo de fuentes del área de San Diego.
 *
 * Las definiciones de aquí describen CÓMO se consulta una fuente. Si se puede
 * consultar, y con qué campos, lo decide la evidencia de la auditoría en
 * config/source-allowlist.json. Este archivo no concede permisos.
 *
 * Tres reglas que el código hace cumplir, no la documentación:
 *
 *   1. Una fuente no sale a la red sin pasar las dos capas de la puerta.
 *   2. Los campos prohibidos por la auditoría se excluyen en origen: en SODA
 *      con $select, y en el resto quitándolos de la fila antes de mapear y
 *      antes de guardarla.
 *   3. Un dataset de la lista de rechazados no puede ni construir su URL.
 *
 * Estado al 2026-10-04: habilitada solo sdcounty_food_facility_permits; las dos
 * municipales siguen apagadas. Ver docs/source-verification.md.
 */

const clean = (v) => String(v ?? '').trim();

/**
 * Capitaliza respetando el alfabeto completo.
 *
 * Con `\b[a-z]` la frontera de palabra de ASCII cae justo detrás de una letra
 * acentuada, así que "panadería" salía como "PanaderíA". En San Diego, donde
 * buena parte de los negocios llevan tilde o ñ, eso significa escribir mal el
 * nombre del cliente en el CRM.
 */
const titleCase = (s) => clean(s)
  .toLowerCase()
  .replace(/(^|[^\p{L}\p{N}'’])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase())
  // El apóstrofo no separa palabra —"Miguel's Cocina", no "Miguel'S"— salvo
  // tras los prefijos cortos de apellido: O'Reilly, D'Angelo, L'Auberge.
  .replace(/\b([OD]|L)(['’])(\p{L})/gu, (_, pre, apos, ch) => pre + apos + ch.toUpperCase());

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
  /**
   * Condado de San Diego · permisos de establecimientos de alimentación.
   *
   * La única habilitada, y la única con acceso implementado: API SODA, dominio
   * público y /resource permitido por su robots.txt. Se encendió el 2026-10-04,
   * cuando el control de caudal (429 + Retry-After) y la cuota de una corrida
   * cada 24 h pasaron pruebas. Sigue atada a 50 filas por corrida.
   */
  sdcounty_food_facility_permits: {
    label: 'Permisos de alimentación · Condado de San Diego',
    serviceArea: SERVICE_AREA,
    signalType: 'new_business',
    accessType: 'soda',
    domain: 'data.sandiegocounty.gov',
    dataset: 'c5ez-ufrd',
    dateField: 'record_open_date',
    query: ({ sinceDays = 90, limit = 50 } = {}) => ({
      // $select limita lo que el servidor llega a enviar: los campos prohibidos
      // no se filtran después, es que no se piden.
      $select: allowedFields('sdcounty_food_facility_permits').join(','),
      $where: `record_open_date > '${isoDaysAgo(sinceDays)}'`,
      $order: 'record_open_date DESC',
      // Tope de la política interna: 50 filas por corrida.
      $limit: String(Math.min(limit, 50)),
    }),
    requires: ['businessName'],
    fields: {
      sourceId: ['record_id'],
      businessName: ['record_name'],
      address: ['address'],
      city: ['city'],
      zip: ['zip'],
      openedAt: ['record_open_date'],
      issuedAt: ['record_issue_date'],
      businessType: ['business_type'],
      permitStatus: ['permit_status'],
    },
  },

  /**
   * Ciudad de San Diego · certificados de actividad activos.
   *
   * CSV estático con ETag. El acceso csv-static NO está implementado: la
   * definición existe para que la evidencia y el mapeo estén listos, no para
   * fingir que la fuente funciona.
   */
  sd_business_tax_certificates: {
    label: 'Certificados de actividad · Ciudad de San Diego',
    serviceArea: SERVICE_AREA,
    signalType: 'new_business',
    accessType: 'csv-static',
    domain: 'seshat.datasd.org',
    dataset: null,
    downloadUrl: 'https://seshat.datasd.org/business_tax_certificates/sd_businesses_active_datasd.csv',
    dateField: 'date_account_creation',
    requires: ['businessName'],
    fields: {
      sourceId: ['account_key'],
      businessName: ['dba_name'],
      // La dirección viene troceada en seis columnas; se recompone al mapear.
      addressParts: ['address_no', 'address_pd', 'address_road', 'address_sfx', 'address_suite'],
      city: ['address_city'],
      state: ['address_state'],
      zip: ['address_zip'],
      openedAt: ['date_account_creation'],
      startedAt: ['date_business_start'],
      naics: ['naics_code'],
      naicsDescription: ['naics_description'],
      status: ['account_status'],
    },
  },

  /**
   * Ciudad de San Diego · aprobaciones de proyectos de desarrollo.
   *
   * Solo investigación. APPROVAL_PERMIT_HOLDER puede ser una persona física, y
   * hasta que exista un filtro que distinga organización de particular esta
   * fuente no puede producir leads. La puerta lo impide por `leadUseAllowed`.
   */
  sd_development_approvals: {
    label: 'Aprobaciones de desarrollo · Ciudad de San Diego',
    serviceArea: SERVICE_AREA,
    signalType: 'permit_finaled',
    accessType: 'csv-static',
    researchOnly: true,
    domain: 'seshat.datasd.org',
    dataset: null,
    downloadUrl: 'https://seshat.datasd.org/development_permits/approvals_created_2026_datasd.csv',
    dateField: 'APPROVAL_CREATE_DATE',
    requires: ['businessName', 'address'],
    fields: {
      sourceId: ['APPROVAL_ID', 'PROJECT_ID'],
      // Deliberadamente NO incluye APPROVAL_PERMIT_HOLDER, que es el único
      // campo del dataset que nombraría a alguien.
      businessName: ['PROJECT_TITLE'],
      address: ['GIS_ADDRESS'],
      closedAt: ['APPROVAL_CREATE_DATE', 'PROJECT_CREATE_DATE'],
      scope: ['APPROVAL_SCOPE', 'PROJECT_SCOPE'],
      valuation: ['APPROVAL_VALUATION'],
      approvalType: ['APPROVAL_TYPE'],
      approvalStatus: ['APPROVAL_STATUS'],
    },
  },
};

/**
 * Traduce una fila cruda. La fila se limpia de campos prohibidos antes de
 * mirarla, así que ni un candidato mal declarado podría colarlos.
 */
export function mapRow(source, row, key) {
  const sourceKey = key || Object.keys(SOURCES).find((k) => SOURCES[k] === source);
  const safeRow = scrubRow(sourceKey, row);
  const f = source.fields;
  const get = (name) => (f[name] ? pick(safeRow, f[name]) : '');

  const businessName = titleCase(get('businessName'));
  const address = f.addressParts
    ? f.addressParts.map((c) => clean(safeRow?.[c])).filter(Boolean).join(' ')
    : get('address');

  const mapped = {
    sourceId: get('sourceId'),
    businessName,
    // Ningún registro público aporta contacto comercial: lo busca el
    // enriquecedor en la web del propio negocio, y solo si allí está publicado.
    contactName: '',
    address,
    city: titleCase(get('city')) || 'San Diego',
    zip: get('zip').slice(0, 5),
    phone: '',
    serviceArea: source.serviceArea,
    sourceUrl: source.downloadUrl || allowlistEntry(sourceKey)?.datasetPage || null,
    description: get('naicsDescription') || get('businessType') || get('scope'),
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
        naicsDescription: get('naicsDescription') || get('businessType'),
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

/**
 * URL de consulta. Se niega a construirla para un dataset rechazado o para un
 * tipo de acceso que no está implementado.
 */
export function buildUrl(source, params, baseOverride) {
  if (source.accessType !== 'soda') {
    throw new Error(
      `La fuente "${source.label}" usa accessType "${source.accessType}", que no está implementado. ` +
      'Ver los bloqueos en config/source-allowlist.json.',
    );
  }
  if (!source.dataset) throw new Error(`La fuente "${source.label}" no tiene dataset confirmado.`);
  if (isBannedDataset(source.dataset)) {
    const r = rejectionFor(source.dataset);
    throw new Error(`El dataset "${source.dataset}" está rechazado por la auditoría: ${r?.reason}`);
  }

  const base = baseOverride || `https://${source.domain}`;
  const url = new URL(`/resource/${source.dataset}.json`, base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

/** Estado de cada fuente: evidencia de la auditoría más constancia operativa. */
export function sourceStatus() {
  return Object.entries(SOURCES).map(([key, source]) => {
    const entry = allowlistEntry(key);
    return {
      key,
      label: source.label,
      accessType: source.accessType,
      signalType: source.signalType,
      configured: config.prospecting.sources.includes(key),
      state: entry?.state || 'SIN_AUDITAR',
      eligible: entry?.eligible === true,
      enabled: entry?.enabled === true,
      implemented: entry?.implemented === true,
      license: entry?.license?.name || null,
      forbiddenFields: forbiddenFields(key),
      blockers: entry?.blockers || [],
      ...checkSourceAllowed(key, source),
    };
  });
}

/** Métricas de una corrida. Solo recuentos: ni una fila, ni un dato personal. */
export const emptyMetrics = () => ({
  attempted: 0,
  fetched: 0,
  mapped: 0,
  skipped_sensitive: 0,
  skipped_residential: 0,
  skipped_invalid: 0,
  deduped: 0,
  retries: 0,
  http429: 0,
  quota_blocked: 0,
  duration_ms: 0,
  crm_writes: 0,
  outbound: 0,
});

/**
 * Consulta una fuente bajo todos los controles.
 *
 * El orden importa y es el único correcto:
 *
 *   puerta de cumplimiento → cuota y lock → petición con reintentos →
 *   filtrado de filas → mapeo → filtrado otra vez antes de raw
 *
 * Nada de esto es opcional ni se puede saltar desde el llamante. Devuelve
 * `{ rows, metrics, blocked }`: si la cuota lo impide, `rows` viene vacío y
 * `blocked` dice por qué, en lugar de lanzar como si fuera un error.
 */
export async function fetchFromSource(key, {
  sinceDays, limit, baseOverride,
  fetchImpl, sleep, clock, random,
  quotaOptions = {},
} = {}) {
  const started = Date.now();
  const metrics = emptyMetrics();
  const source = SOURCES[key];
  if (!source) throw new Error(`Fuente desconocida: ${key}`);
  assertSourceAllowed(key, source);

  const outcome = await withQuota(key, async ({ maxRows }) => {
    const effectiveLimit = Math.min(limit ?? maxRows, maxRows);
    const params = source.query({ sinceDays: sinceDays ?? 90, limit: effectiveLimit });
    const headers = config.prospecting.socrataAppToken
      ? { 'X-App-Token': config.prospecting.socrataAppToken }
      : {};

    metrics.attempted = 1;
    const url = buildUrl(source, params, baseOverride);
    const { rows: rawRows, metrics: httpMetrics } = await sodaGet(url, {
      fetchImpl, sleep, clock, random, headers,
    });
    metrics.retries = httpMetrics.retries;
    metrics.http429 = httpMetrics.http429;
    metrics.fetched = rawRows.length;

    const out = [];
    const seen = new Set();
    for (const rawRow of rawRows) {
      const { row: safeRow, reason } = filterRow(key, rawRow);
      if (!safeRow) {
        if (reason === 'residential') metrics.skipped_residential++;
        else if (reason === 'invalid' || reason === 'sin_allowlist') metrics.skipped_invalid++;
        else metrics.skipped_sensitive++;
        continue;
      }

      const mapped = mapRow(source, safeRow, key);
      if (!mapped) { metrics.skipped_invalid++; continue; }

      const fingerprint = `${mapped.businessName}|${mapped.address}|${mapped.zip}`.toLowerCase();
      if (seen.has(fingerprint)) { metrics.deduped++; continue; }
      seen.add(fingerprint);

      // Último filtrado antes de que la fila cruda viaje a disco. Que ya esté
      // limpia no quita que esta sea la frontera donde hay que comprobarlo.
      const raw = scrubRow(key, safeRow);
      assertNoForbidden(key, raw, 'raw de la fila');
      assertNoForbidden(key, mapped, 'prospecto mapeado');

      metrics.mapped++;
      out.push({ ...mapped, source: key, sourceLabel: source.label, raw });
    }

    // Se consultó al portal: la corrida gasta cuota aunque no saliera nada
    // útil. Lo que limitamos es su carga, no nuestro provecho.
    return { rows: out.length, consumed: true, out };
  }, { maxRows: MAX_ROWS_PER_RUN, ...quotaOptions });

  metrics.duration_ms = Date.now() - started;

  if (outcome.blocked) {
    metrics.quota_blocked = 1;
    return { rows: [], metrics, blocked: { reason: outcome.reason, detail: outcome.detail } };
  }
  return { rows: outcome.result.out, metrics, blocked: null };
}

export default SOURCES;
