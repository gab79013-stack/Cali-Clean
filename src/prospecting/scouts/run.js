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
import { evaluateHudRow, evaluateCdeRow, evaluateCityDevRow, evaluateAbcRow, crossKey, nameKey } from './rules.js';
import { queryArcgis } from './arcgis-client.js';
import { fetchCsvToTemp, streamCsvObjects } from '../sources/csv-client.js';
import { extractZipEntry } from '../sources/zip-client.js';

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

// ── 1. CaliClean Property & Manager Scout · HUD ──────────────
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

// ── 2. CaliClean Education & Childcare Facility Scout · CDE ──
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

// ── 3. CaliClean Commercial Development Permit Scout · City ──
async function runCityDev(scoutId, m, metrics, opts) {
  // Una sola descarga del CSV de aprobaciones emitidas del año en curso. El
  // archivo trae APN, latitud, longitud, número de cuenta fiduciaria y número de
  // plano, así que se lee en streaming desde un temporal y se borra siempre.
  const url = opts.downloadUrlOverride || m.downloadUrl;
  const permitidas = m.robots?.allowedResources || [];
  if (!opts.downloadUrlOverride && !permitidas.includes(url)) {
    throw new Error(
      `La URL "${url}" no está en los recursos permitidos de la auditoría de ${scoutId}.`,
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

    const esperados = allowedFields(scoutId);
    let cabecera = null;
    const comprobarCabecera = (cols) => {
      cabecera = cols;
      const faltan = esperados.filter((c) => !cols.includes(c));
      if (faltan.length) {
        throw new Error(
          `El esquema del CSV de ${scoutId} cambió: faltan ${faltan.join(', ')}. `
          + 'La allowlist atestiguada ya no describe este archivo, así que no se procesa.',
        );
      }
    };

    // El archivo NO viene ordenado por fecha de emisión: en una muestra de la
    // cola había permisos de enero junto a otros de octubre. Así que no se puede
    // cortar en el candidato 50 y llamarlo "los más recientes" — habría que
    // llamarlo "los primeros del archivo". Se recorre entero y se conservan los
    // 50 más recientes, con el id como desempate para que dos corridas sobre el
    // mismo archivo den exactamente la misma lista.
    const porNombre = new Map();
    const ahora = opts.clock ? opts.clock() : Date.now();

    for await (const parsed of streamCsvObjects(descarga.file, {
      delimiter: m.limits.delimiter || ',',
      onHeader: comprobarCabecera,
    })) {
      metrics.fetched++;
      if (!parsed.ok) { metrics.rejected_malformed++; continue; }

      const v = evaluateCityDevRow(parsed.row, m, { now: ahora });
      if (!v.ok) { countRejection(metrics, v.kind); continue; }

      // Recorte a la allowlist cerrada antes de construir nada.
      const { row: safe } = trimToAllowed(scoutId, parsed.row);
      assertOnlyAllowed(scoutId, safe, 'fila recortada');

      // Una empresa, una Company: el mismo titular puede tener diez permisos.
      // Gana el más reciente, y con fecha igual, el id más bajo.
      const clave = nameKey(v.businessName);
      if (!clave) { metrics.rejected_personal++; continue; }
      const previo = porNombre.get(clave);
      if (previo) {
        metrics.deduped++;
        const mejor = v.issueDate > previo.issueDate
          || (v.issueDate === previo.issueDate && Number(v.approvalId) < Number(previo.approvalId));
        if (!mejor) continue;
      }
      porNombre.set(clave, v);
      metrics.accepted = porNombre.size;
    }

    const elegidos = [...porNombre.values()]
      .sort((a, b) => (b.issueDate.localeCompare(a.issueDate))
        || (Number(a.approvalId) - Number(b.approvalId)))
      .slice(0, m.limits.maxAcceptedPerRun);
    metrics.over_cap = Math.max(0, porNombre.size - elegidos.length);
    metrics.accepted = elegidos.length;

    const verificadoEn = new Date(ahora).toISOString();
    const aceptados = elegidos.map((v) => ({
      dedupKey: `${m.dedupNamespace}:${v.approvalId}`,
      sourceId: v.approvalId,
      businessName: v.businessName,
      address: v.address,
      // La ciudad no sale de una columna —el archivo no la trae— sino del alcance
      // del conjunto de datos, y la procedencia lo dice con esas palabras.
      city: 'San Diego',
      zip: null,
      serviceArea: m.serviceArea,
      sourceUrl: m.portalPage,
      lastVerified: verificadoEn,
      evidence: {
        approvalId: v.approvalId,
        approvalType: v.approvalType,
        buildingClass: v.buildingClass,
        buildingClassCode: v.buildingClassCode,
        issueDate: v.issueDate,
        issuedDaysAgo: v.issuedDaysAgo,
        projectId: v.projectId,
        projectType: v.projectType,
        valuation: v.valuation,
        // Con qué regla entró. "Lo aceptó una heurística" no es auditable.
        acceptanceRule: v.holderTier === 1
          ? 'titular con sufijo de forma jurídica (nivel 1)'
          : 'titular con designador de actividad empresarial y sin forma de persona (nivel 2)',
        holderTier: v.holderTier,
      },
      matchKeys: { name: nameKey(v.businessName), cross: crossKey(v.businessName, v.address) },
    }));

    return {
      rows: aceptados.length,
      consumed: true,
      aceptados,
      provenance: {
        dataset: m.datasetTitle,
        portalPage: m.portalPage,
        downloadUrl: m.downloadUrl,
        downloadLabel: m.downloadLabelObserved,
        license: m.license,
        publisher: 'City of San Diego · Development Services',
        fileSha256: descarga.sha256,
        fileBytes: descarga.bytes,
        fileEtag: descarga.headers?.etag ?? null,
        fileLastModified: descarga.headers?.lastModified ?? null,
        verifiedAt: verificadoEn,
        issuedWithinDays: m.filters.issuedWithinDays,
        acceptanceRule: m.filters.holderRule,
        cityFrom: 'alcance del conjunto de datos (permisos de la Ciudad de San Diego), no una columna del archivo',
        headerColumns: cabecera ? cabecera.length : null,
        headerUnexpectedCount: cabecera ? cabecera.filter((c) => !esperados.includes(c)
          && !(m.fields?.neverRequested || []).includes(c)).length : null,
      },
    };
  } finally {
    // Siempre: el archivo trae APN, coordenadas y cuentas fiduciarias.
    descarga.dispose();
  }
}

// ── 4. CaliClean ABC Active License Scout · California ABC ───
async function runAbc(scoutId, m, metrics, opts) {
  // El volcado diario viene zipeado, así que hay un paso más que en las otras:
  // descargar el ZIP, inflar su única entrada CSV a otro temporal, y borrar los
  // dos siempre. El archivo trae nombres de titulares y su dirección postal, así
  // que ninguno de los dos se queda en disco.
  const url = opts.downloadUrlOverride || m.downloadUrl;
  const permitidas = m.robots?.allowedResources || [];
  if (!opts.downloadUrlOverride && !permitidas.includes(url)) {
    throw new Error(`La URL "${url}" no está en los recursos permitidos de la auditoría de ${scoutId}.`);
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
  let inflado = null;
  try {
    if (descarga.notModified) {
      return { rows: 0, consumed: false, aceptados: [], notModified: true, provenance: {} };
    }
    metrics.bytes += descarga.bytes;

    inflado = await extractZipEntry(descarga.file, {
      expectExtension: m.zipEntryExtension || '.csv',
      maxInflatedBytes: m.limits.maxInflatedBytes,
    });
    metrics.inflated_bytes = inflado.bytes;

    const esperados = allowedFields(scoutId);
    let cabecera = null;
    let banner = null;
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

    const porClave = new Map();
    const ahora = opts.clock ? opts.clock() : Date.now();
    const verificadoEn = new Date(ahora).toISOString();

    for await (const parsed of streamCsvObjects(inflado.file, {
      delimiter: m.limits.delimiter || ',',
      skipLeadingLines: 1,
      onSkippedLine: (cells) => { if (banner === null) banner = (cells[0] || '').trim() || null; },
      onHeader: comprobarCabecera,
    })) {
      metrics.fetched++;
      if (!parsed.ok) { metrics.rejected_malformed++; continue; }

      const v = evaluateAbcRow(parsed.row, m);
      if (!v.ok) { countRejection(metrics, v.kind); continue; }

      const { row: safe } = trimToAllowed(scoutId, parsed.row);
      assertOnlyAllowed(scoutId, safe, 'fila recortada');

      // Un negocio, una Company. El mismo local puede tener dos licencias —una
      // de cerveza y otra general— y eso no son dos clientes.
      const firma = crossKey(v.businessName, v.address) || nameKey(v.businessName);
      if (!firma) { metrics.rejected_personal++; continue; }
      const previo = porClave.get(firma);
      if (previo) {
        metrics.deduped++;
        // Gana el expediente más bajo: estable y sin depender del orden de lectura.
        if (Number(previo.fileNumber) <= Number(v.fileNumber)) continue;
      }
      porClave.set(firma, v);
    }

    const elegidos = [...porClave.values()]
      .sort((a, b) => Number(a.fileNumber) - Number(b.fileNumber))
      .slice(0, m.limits.maxAcceptedPerRun);
    metrics.over_cap = Math.max(0, porClave.size - elegidos.length);
    metrics.accepted = elegidos.length;

    const aceptados = elegidos.map((v) => ({
      dedupKey: `${m.dedupNamespace}:${v.fileNumber}`,
      sourceId: v.fileNumber,
      businessName: v.businessName,
      address: v.address,
      city: v.city,
      zip: v.zip,
      serviceArea: m.serviceArea,
      sourceUrl: m.portalPage,
      lastVerified: verificadoEn,
      evidence: {
        fileNumber: v.fileNumber,
        licenseType: v.licenseType,
        licenseTypeName: v.licenseTypeName,
        typeStatus: v.typeStatus,
        issueDate: v.issueDate,
        expirationDate: v.expirationDate,
        county: v.county,
        // Con qué regla se eligió el nombre. Importa: uno viene del nombre
        // comercial y otro de la razón social del titular.
        nameRule: v.nameRule,
      },
      matchKeys: { name: nameKey(v.businessName), cross: crossKey(v.businessName, v.address) },
    }));

    return {
      rows: aceptados.length,
      consumed: true,
      aceptados,
      provenance: {
        authority: m.authority,
        portalPage: m.portalPage,
        downloadUrl: m.downloadUrl,
        downloadLabel: m.downloadLabelObserved,
        license: m.license,
        zipSha256: descarga.sha256,
        zipBytes: descarga.bytes,
        csvSha256: inflado.sha256,
        csvBytes: inflado.bytes,
        zipEntry: inflado.entry.name,
        fileEtag: descarga.headers?.etag ?? null,
        fileLastModified: descarga.headers?.lastModified ?? null,
        // El sello que el propio archivo trae en su primera línea.
        datasetStamp: banner,
        verifiedAt: verificadoEn,
        updateCadence: m.downloadVerification?.updateCadence ?? null,
        nameRule: m.filters.nameRule,
        headerColumns: cabecera ? cabecera.length : null,
        headerUnexpectedCount: cabecera ? cabecera.filter((c) => !esperados.includes(c)
          && !(m.fields?.neverRequested || []).includes(c)).length : null,
      },
    };
  } finally {
    // Los dos, siempre: el ZIP y el CSV inflado.
    if (inflado) inflado.dispose();
    descarga.dispose();
  }
}

const EJECUTORES = {
  hud_multifamily: runHud,
  cde_schools: runCde,
  city_development_permits: runCityDev,
  ca_abc_active_licenses: runAbc,
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
      queryUrlOverride, downloadUrlOverride,
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
