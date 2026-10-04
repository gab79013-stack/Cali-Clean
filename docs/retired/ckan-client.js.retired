/**
 * Cliente de la API CKAN de un portal de datos abiertos.
 *
 * Tres decisiones que definen este archivo:
 *
 *   · **Solo el host exacto y solo sus endpoints de API.** Si una respuesta
 *     intenta llevarnos a otro sitio —típicamente el S3 donde vive el archivo
 *     completo— se rechaza. Ese recurso no es el que se auditó, no lleva el
 *     esquema que aquí se valida, y el permiso es sobre el endpoint, no sobre el
 *     dato.
 *   · **El `resource_id` atestiguado manda.** Un DataStore rota su recurso
 *     cuando el publicador lo reemplaza. Si el que responde no es el que la
 *     evidencia declara, se falla cerrado: el esquema podría ser otro y la
 *     allowlist de campos dejaría de significar lo mismo.
 *   · **El SQL se construye aquí, con los valores escapados.** Nunca se
 *     interpola texto ajeno sin escapar: una comilla en un nombre de condado no
 *     puede convertirse en SQL.
 */

import { requestWithRetry } from '../sources/http-retry.js';

export const CKAN_DEFAULTS = Object.freeze({
  pageSize: 200,
  maxPages: 25,
  timeoutMs: 60000,
});

export class CkanError extends Error {
  constructor(message, { status, url, code } = {}) {
    super(message);
    this.name = 'CkanError';
    this.status = status;
    this.url = url;
    this.code = code;
  }
}

/** Escapa un literal de cadena de SQL duplicando la comilla simple. */
export function sqlLiteral(value) {
  return String(value ?? '').replace(/'/g, "''");
}

/** Comprueba que un identificador (campo o recurso) es seguro de interpolar. */
export function assertIdentifier(name) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(name ?? ''))) {
    throw new CkanError(`"${name}" no es un identificador válido para una consulta`, { code: 'BAD_IDENTIFIER' });
  }
  return name;
}

/**
 * Construye el SQL de una página.
 *
 * Los campos se citan con comillas dobles porque el esquema usa mayúsculas, y se
 * validan antes: un nombre de campo con algo raro no llega a la consulta.
 */
export function buildSql({ resourceId, fields, filters = {}, orderBy, limit, offset }) {
  assertIdentifier(resourceId);
  if (!Array.isArray(fields) || !fields.length) {
    throw new CkanError('Sin lista de campos no se consulta: un SELECT * traería columnas sin auditar.', {
      code: 'NO_FIELDS',
    });
  }
  const cols = fields.map((f) => `"${assertIdentifier(f)}"`).join(', ');
  const where = Object.entries(filters)
    .map(([k, v]) => `"${assertIdentifier(k)}" = '${sqlLiteral(v)}'`)
    .join(' AND ');
  const order = orderBy ? ` ORDER BY "${assertIdentifier(orderBy)}" ASC` : '';
  return `SELECT ${cols} FROM "${resourceId}"${where ? ` WHERE ${where}` : ''}${order}`
    + ` LIMIT ${Number(limit)} OFFSET ${Number(offset)}`;
}

async function pedir(url, { fetchImpl, timeoutMs, userAgent, sleep, clock, random, metrics, describe }) {
  const { res, metrics: httpMetrics } = await requestWithRetry({
    url,
    describe,
    sleep,
    clock,
    random,
    doRequest: async () => {
      metrics.requests++;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetchImpl(url, {
          method: 'GET',
          headers: { Accept: 'application/json', ...(userAgent ? { 'User-Agent': userAgent } : {}) },
          signal: controller.signal,
          // Un redirect se rechaza en lugar de seguirse: el destino típico es el
          // S3 del archivo completo, que no es el recurso auditado.
          redirect: 'manual',
        });
      } finally {
        clearTimeout(timer);
      }
    },
    classify: (r) => {
      if (r.status === 429) return 'throttled';
      return r.ok ? 'ok' : 'fatal';
    },
  });

  if (res.status >= 300 && res.status < 400) {
    throw new CkanError(
      `la API respondió un redirect (HTTP ${res.status}) y no se sigue: el destino no es el recurso auditado`,
      { status: res.status, url, code: 'REDIRECT_REJECTED' },
    );
  }
  if (!res.ok) {
    throw new CkanError(`la API respondió HTTP ${res.status}`, { status: res.status, url, code: 'HTTP_ERROR' });
  }

  const text = await res.text();
  metrics.bytes += Buffer.byteLength(text);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new CkanError('la API devolvió algo que no es JSON', { url, code: 'BAD_JSON' });
  }
  // CKAN informa de sus errores dentro de un 200, con success:false.
  if (body.success !== true) {
    throw new CkanError(
      `la API devolvió success:false (${String(body.error?.message || body.error?.__type || 'sin detalle')})`,
      { url, code: 'CKAN_ERROR' },
    );
  }
  return body;
}

/**
 * Recorre el DataStore con SQL paginado y devuelve `{ rows, metrics, fields }`.
 *
 * `expectedResourceId` es el de la evidencia. No es un parámetro de comodidad:
 * si el recurso ha rotado, esto es lo que lo detecta.
 */
export async function queryDatastore({
  sqlEndpoint,
  resourceId,
  expectedResourceId = null,
  fields,
  filters = {},
  orderBy = null,
  pageSize = CKAN_DEFAULTS.pageSize,
  maxPages = CKAN_DEFAULTS.maxPages,
  timeoutMs = CKAN_DEFAULTS.timeoutMs,
  fetchImpl = fetch,
  sleep,
  clock,
  random,
  userAgent = null,
  onPage = null,
} = {}) {
  if (expectedResourceId && resourceId !== expectedResourceId) {
    throw new CkanError(
      `el recurso del DataStore cambió: se esperaba ${expectedResourceId} y se iba a pedir ${resourceId}. `
      + 'El esquema podría ser otro, así que no se consulta.',
      { code: 'RESOURCE_ROTATED' },
    );
  }

  const metrics = { requests: 0, pages: 0, bytes: 0, rows: 0, retries: 0, http429: 0 };
  const rows = [];
  let offset = 0;
  let fieldsSeen = null;

  for (let page = 0; page < maxPages; page++) {
    const sql = buildSql({ resourceId, fields, filters, orderBy, limit: pageSize, offset });
    const url = `${sqlEndpoint}?sql=${encodeURIComponent(sql)}`;
    const body = await pedir(url, {
      fetchImpl, timeoutMs, userAgent, sleep, clock, random, metrics,
      describe: () => 'la consulta al DataStore',
    });

    const records = Array.isArray(body.result?.records) ? body.result.records : [];
    if (!fieldsSeen && Array.isArray(body.result?.fields)) {
      fieldsSeen = body.result.fields.map((f) => f.id);
    }
    metrics.pages++;
    if (!records.length) break;

    for (const r of records) {
      metrics.rows++;
      rows.push(r);
    }
    if (onPage && onPage({ rows, page: metrics.pages }) === 'stop') break;
    if (records.length < pageSize) break;
    offset += records.length;
  }

  return { rows, metrics, fields: fieldsSeen };
}

export default queryDatastore;
