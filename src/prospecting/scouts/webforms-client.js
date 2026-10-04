/**
 * Descarga del CSV masivo de un portal ASP.NET WebForms.
 *
 * El portal de CSLB no sirve un archivo en una URL estable: sirve un formulario
 * con estado, y el CSV sale de dos postbacks. Eso obliga a una secuencia fija, y
 * **la secuencia es la autorización**: lo que se auditó fue esta descarga, no el
 * dominio. De ahí las reglas:
 *
 *   1. GET de la página del portal, solo para leer sus tokens
 *      (`__VIEWSTATE`, `__EVENTVALIDATION`, `__VIEWSTATEGENERATOR`).
 *   2. Postback seleccionando el dataset `M` (License Master).
 *   3. Postback sobre el control `lbMasterCSV`.
 *   4. La respuesta tiene que ser `text/csv` con un adjunto. Si llega HTML, se
 *      rechaza: significa que el formulario respondió otra cosa y seguir
 *      adelante sería parsear una página de error como si fueran datos.
 *
 * Y dos negativas explícitas:
 *
 *   · **Un redirect se rechaza.** La descarga verificada responde el CSV
 *     directamente. Un 302 lleva a un recurso que nadie auditó.
 *   · **No se raspea nada.** Ni buscadores de licencias individuales, ni otras
 *     páginas del portal. Solo esta secuencia.
 *
 * El archivo se descarga a un temporal, se hashea entero y **se borra siempre**:
 * el volcado trae direcciones, teléfonos y personas, y lo único que puede
 * sobrevivir es lo que la allowlist deja pasar.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { requestWithRetry } from '../sources/http-retry.js';

export const WEBFORMS_DEFAULTS = Object.freeze({
  // El volcado maestro de licencias del estado es grande; el tope deja margen
  // sin dejar de ser un tope.
  maxBytes: 512 * 1024 * 1024,
  timeoutMs: 300000,
});

export class WebFormsError extends Error {
  constructor(message, { status, code, step, bytes } = {}) {
    super(message);
    this.name = 'WebFormsError';
    this.status = status;
    this.code = code;
    this.step = step;
    this.bytes = bytes;
  }
}

const tmpRoot = () => process.env.SOURCE_CSV_TMP_DIR || os.tmpdir();

/**
 * Extrae los campos ocultos del formulario.
 *
 * Es lectura de tokens, no raspado de contenido: no se mira ni un dato de la
 * página, solo los tres valores que el postback necesita para ser válido.
 */
export function extractFormTokens(html) {
  const grab = (name) => {
    const re = new RegExp(`<input[^>]*name="${name}"[^>]*value="([^"]*)"`, 'i');
    const alt = new RegExp(`<input[^>]*value="([^"]*)"[^>]*name="${name}"`, 'i');
    return (html.match(re) || html.match(alt) || [])[1] ?? null;
  };
  const tokens = {
    __VIEWSTATE: grab('__VIEWSTATE'),
    __VIEWSTATEGENERATOR: grab('__VIEWSTATEGENERATOR'),
    __EVENTVALIDATION: grab('__EVENTVALIDATION'),
  };
  if (!tokens.__VIEWSTATE) {
    throw new WebFormsError(
      'la página del portal no trae __VIEWSTATE: el formulario no es el que se auditó',
      { code: 'NO_VIEWSTATE', step: 'tokens' },
    );
  }
  return tokens;
}

/** Comprueba que la respuesta es el CSV adjunto que se espera, y no otra cosa. */
export function assertCsvResponse(res, { expectedAttachment }) {
  if (res.status >= 300 && res.status < 400) {
    throw new WebFormsError(
      `el portal respondió un redirect (HTTP ${res.status}) y no se sigue: la descarga verificada entrega el `
      + 'CSV directamente, así que un redirect lleva a un recurso que nadie auditó',
      { status: res.status, code: 'REDIRECT_REJECTED', step: 'csv' },
    );
  }
  if (!res.ok) {
    throw new WebFormsError(`el portal respondió HTTP ${res.status} al pedir el CSV`, {
      status: res.status, code: 'HTTP_ERROR', step: 'csv',
    });
  }
  const type = String(res.headers?.get?.('content-type') ?? '');
  if (!/text\/csv|application\/octet-stream|application\/csv/i.test(type)) {
    throw new WebFormsError(
      `el portal devolvió content-type "${type || '(ninguno)'}" en lugar de text/csv: `
      + 'probablemente sea una página de error, y parsearla como datos sería inventar filas',
      { code: 'NOT_CSV', step: 'csv' },
    );
  }
  const disp = String(res.headers?.get?.('content-disposition') ?? '');
  if (expectedAttachment && !disp.toLowerCase().includes(String(expectedAttachment).toLowerCase())) {
    throw new WebFormsError(
      `el adjunto no es "${expectedAttachment}" (content-disposition: ${disp || '(ninguno)'})`,
      { code: 'WRONG_ATTACHMENT', step: 'csv' },
    );
  }
  return true;
}

/**
 * Hace la secuencia completa y devuelve `{ file, bytes, sha256, dispose }`.
 *
 * `dispose()` borra el archivo y hay que llamarlo siempre, en un `finally`.
 */
export async function downloadMasterCsv({
  portalUrl,
  control = 'lbMasterCSV',
  datasetChoice = 'M',
  datasetField = 'ddlDataType',
  expectedAttachment = 'MasterLicenseData.csv',
  fetchImpl = fetch,
  sleep,
  clock,
  random,
  userAgent = null,
  maxBytes = WEBFORMS_DEFAULTS.maxBytes,
  timeoutMs = WEBFORMS_DEFAULTS.timeoutMs,
  dir = tmpRoot(),
} = {}) {
  const metrics = { requests: 0, bytes: 0, retries: 0, http429: 0 };
  const cabeceras = (extra = {}) => ({
    Accept: 'text/html,application/xhtml+xml,text/csv',
    ...(userAgent ? { 'User-Agent': userAgent } : {}),
    ...extra,
  });

  const pedir = async (url, init, describe, step) => {
    let salida;
    try {
      salida = await requestWithRetry({
      url,
      describe: () => describe,
      sleep,
      clock,
      random,
      doRequest: async () => {
        metrics.requests++;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          // `manual` en los tres pasos: la secuencia auditada no redirige.
          return await fetchImpl(url, { ...init, signal: controller.signal, redirect: 'manual' });
        } finally {
          clearTimeout(timer);
        }
      },
      classify: (r) => {
        if (r.status === 429) return 'throttled';
        return r.ok || (r.status >= 300 && r.status < 400) ? 'ok' : 'fatal';
      },
      });
    } catch (err) {
      if (err instanceof WebFormsError) throw err;
      // Un fallo de red salía como TypeError("fetch failed") y en un log eso no
      // dice nada: ni qué paso de la secuencia murió, ni si la conexión se cortó
      // a mitad. Se envuelve diciéndolo.
      throw new WebFormsError(
        `${describe} no se completó (sin conexión, o cortada a medias): ${err.message}`,
        { code: 'FETCH_FAILED', step },
      );
    }
    metrics.retries += salida.metrics.retries;
    metrics.http429 += salida.metrics.http429;
    return salida.res;
  };

  // ── Paso 1: tokens del formulario ──
  const paso1 = await pedir(portalUrl, { method: 'GET', headers: cabeceras() }, 'la página del portal', 'tokens');
  if (paso1.status >= 300 && paso1.status < 400) {
    throw new WebFormsError(`la página del portal redirige (HTTP ${paso1.status}) y no se sigue`, {
      status: paso1.status, code: 'REDIRECT_REJECTED', step: 'tokens',
    });
  }
  if (!paso1.ok) {
    throw new WebFormsError(`la página del portal respondió HTTP ${paso1.status}`, {
      status: paso1.status, code: 'HTTP_ERROR', step: 'tokens',
    });
  }
  const html = await paso1.text();
  metrics.bytes += Buffer.byteLength(html);
  const tokens = extractFormTokens(html);

  const form = (eventTarget, extra = {}) => {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(tokens)) if (v !== null) body.set(k, v);
    body.set('__EVENTTARGET', eventTarget);
    body.set('__EVENTARGUMENT', '');
    for (const [k, v] of Object.entries(extra)) body.set(k, v);
    return body;
  };

  // ── Paso 2: seleccionar License Master ──
  const paso2 = await pedir(portalUrl, {
    method: 'POST',
    headers: cabeceras({ 'Content-Type': 'application/x-www-form-urlencoded' }),
    body: form(datasetField, { [datasetField]: datasetChoice }).toString(),
  }, 'el postback de selección', 'select');
  if (paso2.status >= 300 && paso2.status < 400) {
    throw new WebFormsError(`el postback de selección redirige (HTTP ${paso2.status}) y no se sigue`, {
      status: paso2.status, code: 'REDIRECT_REJECTED', step: 'select',
    });
  }
  if (!paso2.ok) {
    throw new WebFormsError(`el postback de selección respondió HTTP ${paso2.status}`, {
      status: paso2.status, code: 'HTTP_ERROR', step: 'select',
    });
  }
  const html2 = await paso2.text();
  metrics.bytes += Buffer.byteLength(html2);
  // Los tokens se renuevan en cada postback: usar los viejos haría fallar el
  // segundo, y el portal respondería una página de error en lugar del CSV.
  const tokens2 = extractFormTokens(html2);
  Object.assign(tokens, tokens2);

  // ── Paso 3: el CSV ──
  const paso3 = await pedir(portalUrl, {
    method: 'POST',
    headers: cabeceras({ 'Content-Type': 'application/x-www-form-urlencoded' }),
    body: form(control, { [datasetField]: datasetChoice }).toString(),
  }, 'la descarga del CSV', 'csv');
  assertCsvResponse(paso3, { expectedAttachment });

  const anunciado = Number(paso3.headers?.get?.('content-length')) || null;
  if (anunciado && anunciado > maxBytes) {
    throw new WebFormsError(`el CSV anuncia ${anunciado} bytes y el tope es ${maxBytes}`, {
      code: 'TOO_LARGE', step: 'csv', bytes: anunciado,
    });
  }

  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `cc-csv-cslb-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`);
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  let fd;
  const dispose = () => { try { fs.rmSync(file, { force: true }); } catch { /* ya no está */ } };

  if (!paso3.body) {
    throw new WebFormsError('la respuesta del CSV no trae cuerpo', { code: 'NO_BODY', step: 'csv' });
  }
  try {
    fd = fs.openSync(file, 'wx');
    for await (const chunk of paso3.body) {
      const buf = Buffer.from(chunk);
      bytes += buf.length;
      if (bytes > maxBytes) {
        throw new WebFormsError(
          `el CSV pasó de ${maxBytes} bytes mientras se descargaba (${bytes} y subiendo): se aborta`,
          { code: 'TOO_LARGE', step: 'csv', bytes },
        );
      }
      hash.update(buf);
      fs.writeFileSync(fd, buf);
    }
    fs.fsyncSync(fd);
  } catch (err) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ya cerrado */ } fd = undefined; }
    dispose();
    if (err instanceof WebFormsError) throw err;
    throw new WebFormsError(`la descarga se interrumpió tras ${bytes} bytes: ${err.message}`, {
      code: 'INTERRUPTED', step: 'csv', bytes,
    });
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ya cerrado */ } }
  }

  if (bytes === 0) {
    dispose();
    throw new WebFormsError('el CSV llegó vacío', { code: 'EMPTY', step: 'csv', bytes: 0 });
  }

  metrics.bytes += bytes;
  return { file, bytes, sha256: hash.digest('hex'), metrics, dispose };
}

export default downloadMasterCsv;
