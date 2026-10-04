/**
 * Cliente de consulta ArcGIS REST, paginado y con los campos acotados.
 *
 * Dos cosas que este cliente hace y que no son opcionales:
 *
 *   · **Pide solo los campos de la allowlist.** `outFields` se construye con
 *     ellos, así que los campos de contacto y de persona no se filtran después:
 *     es que no se solicitan. Y `returnGeometry=false`, porque la geometría de
 *     una propiedad es su ubicación exacta y no hace falta para nada de esto.
 *   · **Pagina con un tope.** `resultOffset` + `resultRecordCount` hasta que el
 *     servidor deja de decir `exceededTransferLimit`, con un máximo de páginas.
 *     Un servicio que de pronto devuelva un millón de filas no puede dejar la
 *     corrida paginando para siempre.
 *
 * Si el servidor devuelve un campo que no se pidió, se cae igual en el filtrado
 * posterior: pedirlo bien es la primera red, no la única.
 */

import { requestWithRetry } from '../sources/http-retry.js';

export const ARCGIS_DEFAULTS = Object.freeze({
  pageSize: 200,
  maxPages: 25,
  timeoutMs: 60000,
});

export class ArcgisError extends Error {
  constructor(message, { status, url, code } = {}) {
    super(message);
    this.name = 'ArcgisError';
    this.status = status;
    this.url = url;
    this.code = code;
  }
}

/** Parámetros de una página. `where` ya viene construido por quien llama. */
export function buildQueryParams({ where, outFields, pageSize, offset, orderBy }) {
  if (!Array.isArray(outFields) || !outFields.length) {
    throw new ArcgisError('Sin lista de campos no se consulta: pedir "*" traería contacto y geometría.', {
      code: 'NO_FIELDS',
    });
  }
  const params = new URLSearchParams({
    f: 'json',
    where,
    outFields: outFields.join(','),
    // La geometría es la ubicación exacta de la propiedad. No se pide.
    returnGeometry: 'false',
    resultRecordCount: String(pageSize),
    resultOffset: String(offset),
  });
  if (orderBy) params.set('orderByFields', orderBy);
  return params;
}

/**
 * Recorre las páginas y devuelve `{ rows, metrics }`.
 *
 * `onPage` puede devolver `'stop'` para dejar de paginar en cuanto haya
 * suficientes candidatos aceptados: el tope es de candidatos válidos, no de
 * filas leídas, y seguir paginando después de alcanzarlo solo molesta al
 * servidor.
 */
export async function queryArcgis(baseUrl, {
  where,
  outFields,
  orderBy = null,
  pageSize = ARCGIS_DEFAULTS.pageSize,
  maxPages = ARCGIS_DEFAULTS.maxPages,
  timeoutMs = ARCGIS_DEFAULTS.timeoutMs,
  fetchImpl = fetch,
  sleep,
  clock,
  random,
  userAgent = null,
  onPage = null,
} = {}) {
  const metrics = { requests: 0, pages: 0, bytes: 0, rows: 0, retries: 0, http429: 0 };
  const rows = [];
  let offset = 0;

  for (let page = 0; page < maxPages; page++) {
    const params = buildQueryParams({ where, outFields, pageSize, offset, orderBy });
    const url = `${baseUrl}?${params.toString()}`;

    const { res, metrics: httpMetrics } = await requestWithRetry({
      url,
      describe: () => 'la consulta ArcGIS',
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
            redirect: 'follow',
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
    metrics.retries += httpMetrics.retries;
    metrics.http429 += httpMetrics.http429;

    if (!res.ok) {
      throw new ArcgisError(`ArcGIS respondió HTTP ${res.status}`, { status: res.status, url, code: 'HTTP_ERROR' });
    }

    const text = await res.text();
    metrics.bytes += Buffer.byteLength(text);
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ArcgisError('ArcGIS devolvió algo que no es JSON', { url, code: 'BAD_JSON' });
    }
    // ArcGIS informa de sus errores dentro de un 200. Ignorarlo sería tratar un
    // fallo como una página vacía.
    if (body.error) {
      throw new ArcgisError(
        `ArcGIS devolvió un error: ${String(body.error.message || body.error.code || 'sin detalle')}`,
        { url, code: 'ARCGIS_ERROR' },
      );
    }
    const features = Array.isArray(body.features) ? body.features : [];
    metrics.pages++;

    // Una página sin `features` pero con `exceededTransferLimit` sería una
    // respuesta incoherente: se corta en lugar de seguir pidiendo.
    if (!features.length) break;

    for (const f of features) {
      metrics.rows++;
      rows.push(f.attributes || {});
    }
    if (onPage && onPage({ rows, page: metrics.pages }) === 'stop') break;

    if (!body.exceededTransferLimit) break;
    offset += features.length;
  }

  return { rows, metrics };
}

export default queryArcgis;
