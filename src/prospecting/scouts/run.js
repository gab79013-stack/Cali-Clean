/**
 * Ejecutar un scout: de la fuente oficial a un staging sellado, y nada más.
 *
 * El orden de los controles es el único correcto, y ninguno se puede saltar
 * desde el llamante:
 *
 *   guard duro del outbound → puerta del scout → cuota durable (CRM, inyectada)
 *   → cuota local y lock → petición acotada → filtrado por allowlist cerrada
 *   → reglas de aceptación → deduplicación interna → staging sellado
 *
 * Lo que este módulo NO hace, y es deliberado: no importa el adaptador de Twenty.
 * Un scout no sabe que existe un CRM. El índice del CRM, si hace falta para
 * deduplicar, llega como un parámetro ya cargado por la capa central.
 */

import { config } from '../../config.js';
import { withQuota } from '../sources/quota.js';
import { checkDurableQuota } from '../sources/durable-quota.js';
import {
  assertScoutAllowed, assertOutboundDisabled, manifestFor,
  emptyScoutMetrics, countRejection, allowedFields,
} from './registry.js';
import { writeStaging, newRunId } from './staging.js';
import { evaluateCslbRow, evaluateHudRow, evaluateCdeRow, crossKey, nameKey } from './rules.js';
import { downloadMasterCsv } from './webforms-client.js';
import { queryArcgis } from './arcgis-client.js';
import { fetchCsvToTemp, streamCsvObjects } from '../sources/csv-client.js';

/** Recorta una fila a la allowlist cerrada del scout. */
export function trimToAllowed(scoutId, row) {
  const permitidos = new Set(allowedFields(scoutId).map((f) => f.toLowerCase()));
  const out = {};
  const descartados = [];
  for (const [k, v] of Object.entries(row || {})) {
    if (permitidos.has(k.toLowerCase())) out[k] = v;
    else descartados.push(k);
  }
  return { row: out, descartados };
}

/**
 * Comprueba que un objeto no lleva ni una clave fuera de la allowlist.
 *
 * Es la aserción que corre justo antes de que algo entre en el staging. Que la
 * fila ya esté recortada no quita que esta sea la frontera donde hay que
 * comprobarlo, y quien añada mañana otro productor de candidatos no tiene por
 * qué saberlo.
 */
export function assertOnlyAllowed(scoutId, obj, where = 'objeto') {
  const permitidos = new Set(allowedFields(scoutId).map((f) => f.toLowerCase()));
  for (const k of Object.keys(obj || {})) {
    if (!permitidos.has(k.toLowerCase())) {
      throw new Error(`Clave no permitida "${k}" en ${where} de ${scoutId}`);
    }
  }
  return true;
}

// ── 1. CaliClean State License Scout · CSLB ──────────────────
async function runCslb(scoutId, m, metrics, opts) {
  const descarga = await downloadMasterCsv({
    portalUrl: opts.portalUrlOverride || m.portalPage,
    control: m.download.control,
    datasetField: m.download.datasetField,
    datasetChoice: m.download.datasetChoice,
    expectedAttachment: m.download.expectedAttachment,
    fetchImpl: opts.fetchImpl,
    sleep: opts.sleep,
    clock: opts.clock,
    random: opts.random,
    userAgent: opts.userAgent,
    maxBytes: m.limits.maxBytes,
    timeoutMs: m.limits.timeoutMs,
  });
  metrics.requests += descarga.metrics.requests;
  metrics.retries += descarga.metrics.retries;
  metrics.http429 += descarga.metrics.http429;
  metrics.bytes += descarga.bytes;

  try {
    const aceptados = [];
    const vistos = new Set();
    for await (const parsed of streamCsvObjects(descarga.file)) {
      metrics.fetched++;
      if (!parsed.ok) { metrics.rejected_malformed++; continue; }

      // Las reglas se evalúan sobre la fila CRUDA, porque algunas miran columnas
      // que el recorte no conserva (County, SecondaryStatus).
      const v = evaluateCslbRow(parsed.row, m);
      if (!v.ok) { countRejection(metrics, v.kind); continue; }

      const dedupKey = `${m.dedupNamespace}:${v.licenseNo}`;
      if (vistos.has(dedupKey)) { metrics.deduped++; continue; }
      vistos.add(dedupKey);

      // El recorte, y la comprobación de que no quedó nada de más.
      const { row: safe } = trimToAllowed(scoutId, parsed.row);
      assertOnlyAllowed(scoutId, safe, 'fila recortada');

      aceptados.push({
        dedupKey,
        sourceId: v.licenseNo,
        businessName: v.businessName,
        // Esta fuente NO conserva dirección a propósito.
        address: null,
        city: null,
        zip: null,
        serviceArea: m.serviceArea,
        sourceUrl: m.portalPage,
        evidence: {
          licenseNo: v.licenseNo,
          businessType: v.businessType,
          primaryStatus: v.primaryStatus,
          secondaryStatus: v.secondaryStatus,
          classifications: v.classifications,
          lastUpdate: v.lastUpdate,
        },
        matchKeys: { name: nameKey(v.businessName), cross: null },
      });
      metrics.accepted++;
      if (aceptados.length >= m.limits.maxAcceptedPerRun) break;
    }
    return {
      aceptados,
      provenance: {
        portalPage: m.portalPage,
        license: m.license,
        csvSha256: descarga.sha256,
        csvBytes: descarga.bytes,
        downloadSteps: m.download.steps,
      },
    };
  } finally {
    // El volcado trae direcciones, teléfonos y personas. No se queda en disco.
    descarga.dispose();
  }
}

// ── 2. CaliClean Property & Manager Scout · HUD ──────────────
async function runHud(scoutId, m, metrics, opts) {
  const fields = allowedFields(scoutId);
  const where = `STD_ST = '${String(m.filters.state).replace(/'/g, "''")}'`
    + ` AND TOTAL_UNIT_COUNT >= ${Number(m.filters.minUnits)}`;

  const { rows, metrics: q } = await queryArcgis(opts.queryUrlOverride || m.queryUrl, {
    where,
    outFields: fields,
    orderBy: 'PROPERTY_ID ASC',
    pageSize: m.limits.pageSize,
    maxPages: m.limits.maxPages,
    timeoutMs: m.limits.timeoutMs,
    fetchImpl: opts.fetchImpl,
    sleep: opts.sleep,
    clock: opts.clock,
    random: opts.random,
    userAgent: opts.userAgent,
  });
  metrics.requests += q.requests;
  metrics.bytes += q.bytes;
  metrics.retries += q.retries;
  metrics.http429 += q.http429;

  const aceptados = [];
  const vistos = new Set();
  for (const row of rows) {
    metrics.fetched++;
    const v = evaluateHudRow(row, m, { cities: opts.cities, zips: opts.zips });
    if (!v.ok) { countRejection(metrics, v.kind); continue; }

    const dedupKey = `${m.dedupNamespace}:${v.propertyId}`;
    if (vistos.has(dedupKey)) { metrics.deduped++; continue; }
    vistos.add(dedupKey);

    const { row: safe } = trimToAllowed(scoutId, row);
    assertOnlyAllowed(scoutId, safe, 'fila recortada');

    aceptados.push({
      dedupKey,
      sourceId: v.propertyId,
      businessName: v.businessName,
      address: v.address,
      city: v.city,
      zip: v.zip,
      serviceArea: m.serviceArea,
      sourceUrl: m.metadataUrl,
      evidence: {
        propertyId: v.propertyId,
        units: v.units,
        category: v.category,
        // El gestor viaja en el staging por si una decisión futura lo necesita, y
        // marcado como NO escribible: no hay campo seguro en el CRM y añadirlo
        // sería cambiar el esquema del cliente.
        managementAgent: v.managementAgent,
        managementAgentWritable: false,
      },
      matchKeys: { name: nameKey(v.businessName), cross: crossKey(v.businessName, v.address) },
    });
    metrics.accepted++;
    if (aceptados.length >= m.limits.maxAcceptedPerRun) break;
  }
  return {
    aceptados,
    provenance: { queryUrl: m.queryUrl, metadataUrl: m.metadataUrl, license: m.license, where },
  };
}

// ── 3. CaliClean Education & Childcare Facility Scout · CDE ──
async function runCde(scoutId, m, metrics, opts) {
  // El volcado del directorio es un archivo estático delimitado por tabuladores.
  // Se descarga una vez, se hashea entero y se borra: trae el nombre y el
  // apellido del administrador de cada centro, su teléfono, su fax y las
  // coordenadas, y nada de eso se queda en disco.
  const url = opts.downloadUrlOverride || m.downloadUrl;
  const permitidas = m.robots?.allowedResources || [];
  if (!opts.downloadUrlOverride && !permitidas.includes(url)) {
    throw new Error(
      `La URL "${url}" no está en los recursos permitidos de la auditoría de ${scoutId}. `
      + 'Mientras el robots y los términos no se hayan leído, esa lista está vacía a propósito.',
    );
  }

  metrics.requests = 1;
  const descarga = await fetchCsvToTemp(url, {
    fetchImpl: opts.fetchImpl,
    etag: opts.etag,
    lastModified: opts.lastModified,
    userAgent: opts.userAgent,
    maxBytes: m.limits.maxBytes,
    timeoutMs: m.limits.timeoutMs,
  });
  try {
    if (descarga.notModified) {
      return { rows: 0, consumed: false, aceptados: [], notModified: true, provenance: {} };
    }
    metrics.bytes += descarga.bytes;

    // La cabecera real contra el esquema atestiguado. Que falte una columna de
    // la allowlist NO es un detalle: la allowlist dejaría de significar lo que
    // dice la constancia, así que la corrida se para. Una columna de más no para
    // nada —la allowlist es cerrada y se cae sola—, pero se cuenta.
    const esperados = allowedFields(scoutId);
    let cabecera = null;
    const comprobarCabecera = (cols) => {
      cabecera = cols;
      const faltan = esperados.filter((c) => !cols.includes(c));
      if (faltan.length) {
        throw new Error(
          `El esquema del volcado de ${scoutId} cambió: faltan ${faltan.join(', ')}. `
          + 'La allowlist atestiguada ya no describe este archivo, así que no se procesa.',
        );
      }
    };

    const aceptados = [];
    const vistos = new Set();
    for await (const parsed of streamCsvObjects(descarga.file, {
      delimiter: m.limits.delimiter || '\t',
      onHeader: comprobarCabecera,
    })) {
      metrics.fetched++;
      if (!parsed.ok) { metrics.rejected_malformed++; continue; }

      const v = evaluateCdeRow(parsed.row, m);
      if (!v.ok) { countRejection(metrics, v.kind); continue; }

      const dedupKey = `${m.dedupNamespace}:${v.cdsCode}`;
      if (vistos.has(dedupKey)) { metrics.deduped++; continue; }
      vistos.add(dedupKey);

      // Recorte a la allowlist declarada y comprobación de que no quedó nada.
      const { row: safe } = trimToAllowed(scoutId, parsed.row);
      assertOnlyAllowed(scoutId, safe, 'fila recortada');

      aceptados.push({
        dedupKey,
        sourceId: v.cdsCode,
        businessName: v.businessName,
        address: v.address,
        city: v.city,
        zip: v.zip,
        serviceArea: m.serviceArea,
        sourceUrl: m.portalPage,
        evidence: {
          cdsCode: v.cdsCode,
          district: v.district,
          schoolType: v.socType,
          districtType: v.docType,
          level: v.eilName,
          charter: v.charter,
          gradesOffered: v.gradesOffered,
          openDate: v.openDate,
          // Sitio oficial tal como lo publica la fuente. No se visita.
          website: v.website,
        },
        matchKeys: { name: nameKey(v.businessName), cross: crossKey(v.businessName, v.address) },
      });
      metrics.accepted++;
      if (aceptados.length >= m.limits.maxAcceptedPerRun) break;
    }

    return {
      rows: aceptados.length,
      consumed: true,
      aceptados,
      provenance: {
        portalPage: m.portalPage,
        downloadUrl: m.downloadUrl,
        license: m.license,
        fileSha256: descarga.sha256,
        fileBytes: descarga.bytes,
        delimiter: 'tab',
        // Cuántas columnas traía y cuántas no estaban en el esquema atestiguado.
        // Solo la CUENTA: el nombre de una columna sale del archivo igual que su
        // contenido, y un volcado con la cabecera corrida metería texto
        // arbitrario en la procedencia. La cuenta basta para ver que algo cambió.
        headerColumns: cabecera ? cabecera.length : null,
        headerUnexpectedCount: cabecera ? cabecera.filter((c) => !esperados.includes(c)
          && !(m.fields?.neverRequested || []).includes(c)).length : null,
      },
    };
  } finally {
    // Siempre: el volcado trae correos de administradores.
    descarga.dispose();
  }
}

const EJECUTORES = {
  cslb_contractors: runCslb,
  hud_multifamily: runHud,
  cde_schools: runCde,
};

/**
 * Corre un scout completo. Devuelve `{ staging, metrics, blocked }`.
 *
 * Si algo lo bloquea, `blocked` dice qué y no se ha tocado la red.
 */
export async function runScout(scoutId, {
  fetchImpl,
  sleep,
  clock,
  random,
  userAgent = config.prospecting?.userAgent || null,
  quotaOptions = {},
  durableQuotaOptions = null,
  cities = [],
  zips = [],
  runId = newRunId(),
  ttlMs,
  now = () => Date.now(),
  // Solo para pruebas: apuntar un cliente a un servidor simulado.
  portalUrlOverride = null,
  queryUrlOverride = null,
  downloadUrlOverride = null,
  etag = null,
  lastModified = null,
} = {}) {
  const started = Date.now();
  const metrics = emptyScoutMetrics();

  // Guard duro, antes de cualquier otra cosa.
  assertOutboundDisabled(config);

  const m = manifestFor(scoutId);
  if (!m) return { staging: null, metrics, blocked: { reason: 'scout_desconocido' } };
  assertScoutAllowed(scoutId);

  // Cuota durable entre contenedores, derivada del CRM e inyectada: el scout no
  // habla con el CRM, solo recibe la respuesta.
  if (durableQuotaOptions) {
    const durable = await checkDurableQuota({ namespace: m.dedupNamespace, ...durableQuotaOptions });
    if (!durable.allowed) {
      metrics.quota_blocked = 1;
      metrics.duration_ms = Date.now() - started;
      return {
        staging: null, metrics, durableQuota: durable,
        blocked: { reason: durable.reason, detail: durable.detail, authority: durable.authority },
      };
    }
  }

  const ejecutor = EJECUTORES[scoutId];
  const outcome = await withQuota(scoutId, async () => {
    const r = await ejecutor(scoutId, m, metrics, {
      fetchImpl, sleep, clock, random, userAgent, cities, zips, etag, lastModified,
      portalUrlOverride, queryUrlOverride, downloadUrlOverride,
    });
    if (r.notModified) return { rows: 0, consumed: false, ...r };
    return { rows: r.aceptados.length, consumed: true, ...r };
  }, { maxRows: m.limits.maxAcceptedPerRun, ...quotaOptions });

  metrics.duration_ms = Date.now() - started;

  if (outcome.blocked) {
    metrics.quota_blocked = 1;
    return { staging: null, metrics, blocked: { reason: outcome.reason, detail: outcome.detail } };
  }

  if (outcome.result?.notModified) {
    // El publicador dice que el archivo no ha cambiado: no hay staging nuevo y
    // no se gasta la ventana del día.
    return {
      staging: null, metrics, notModified: true,
      blocked: { reason: 'sin_cambios_304', detail: 'el volcado no ha cambiado desde la última corrida.' },
    };
  }

  const staging = writeStaging({
    scoutId,
    displayName: m.displayName,
    candidates: outcome.result.aceptados,
    metrics,
    provenance: {
      scoutId,
      displayName: m.displayName,
      egressHost: m.egressHost,
      serviceArea: m.serviceArea,
      collectedAt: new Date(now()).toISOString(),
      ...outcome.result.provenance,
    },
    runId,
    ttlMs,
    now: now(),
  });

  return { staging, metrics, blocked: null };
}

export default runScout;
