/**
 * Descarga de un CSV estático: exactamente un GET por corrida.
 *
 * El archivo de la ciudad pesa ~19 MB y se publica a diario. Tres decisiones que
 * definen este módulo:
 *
 * 1. **Se descarga entero y se hashea entero.** Se podría cortar en cuanto haya
 *    50 candidatos, pero entonces el SHA256 del snapshot no sería del archivo,
 *    sería de un trozo, y no valdría para comprobar nada. Una vez al día, 19 MB
 *    es un precio razonable por una huella que significa algo.
 *
 * 2. **El archivo se borra siempre al terminar.** Contiene `business_owner_name`:
 *    nombres de personas físicas. Dejarlo en disco convertiría un dato que solo
 *    se puede mirar de paso en un dato almacenado. El `finally` que lo borra no
 *    es limpieza de cortesía, es parte de la política.
 *
 * 3. **Tope de bytes y de tiempo.** Un endpoint que de pronto sirva 2 GB no
 *    puede llenar el disco de la máquina, y un socket que se queda colgado no
 *    puede dejar la corrida esperando para siempre. Si el archivo pasa del
 *    tope, se aborta y se dice cuánto llegó.
 *
 * ETag y Last-Modified se envían si se tienen (`If-None-Match` /
 * `If-Modified-Since`): un 304 significa "no ha cambiado desde tu última
 * corrida", y eso es una corrida que no hace falta hacer.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { CsvParser, rowToObject } from './csv-parse.js';

export const CSV_DEFAULTS = Object.freeze({
  // 19 MB hoy; el tope deja margen de crecimiento sin dejar de ser un tope.
  maxBytes: 64 * 1024 * 1024,
  timeoutMs: 120000,
  // Trozos con los que se vuelve a leer del disco para parsear.
  readChunkBytes: 1 << 20,
});

export class CsvFetchError extends Error {
  constructor(message, { status, bytes, code } = {}) {
    super(message);
    this.name = 'CsvFetchError';
    this.status = status;
    this.bytes = bytes;
    this.code = code;
  }
}

const tmpRoot = () => process.env.SOURCE_CSV_TMP_DIR || os.tmpdir();

/**
 * Borra los temporales que quedaron de una corrida que murió a medias.
 *
 * Importa más que de costumbre: esos archivos contienen nombres de personas, así
 * que no pueden quedarse por ahí porque un proceso cayera.
 */
export function cleanupStaleCsvTemps({ dir = tmpRoot(), maxAgeMs = 3600000, now = Date.now() } = {}) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith('cc-csv-')) continue;
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > maxAgeMs) { fs.rmSync(file, { force: true }); removed++; }
    } catch { /* otro proceso se adelantó */ }
  }
  return removed;
}

/**
 * Descarga el CSV a un temporal y devuelve `{ file, bytes, sha256, headers, dispose }`.
 *
 * `dispose()` borra el archivo y hay que llamarlo siempre: quien use esto lo
 * hace en un `finally`.
 */
export async function fetchCsvToTemp(url, {
  fetchImpl = fetch,
  etag = null,
  lastModified = null,
  maxBytes = CSV_DEFAULTS.maxBytes,
  timeoutMs = CSV_DEFAULTS.timeoutMs,
  userAgent = null,
  dir = tmpRoot(),
} = {}) {
  cleanupStaleCsvTemps({ dir });

  const headers = { Accept: 'text/csv,*/*' };
  if (userAgent) headers['User-Agent'] = userAgent;
  if (etag) headers['If-None-Match'] = etag;
  if (lastModified) headers['If-Modified-Since'] = lastModified;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal, redirect: 'follow' });
  } catch (err) {
    clearTimeout(timer);
    // Aquí caen tanto "no se pudo conectar" como "la conexión se cortó antes de
    // entregar la respuesta". Desde fuera no se distinguen, y decir solo "fetch
    // failed" deja a quien lea el log sin saber qué mirar.
    throw new CsvFetchError(
      `la descarga del CSV no se completó (sin conexión, o cortada a medias): ${err.message}`,
      { code: 'FETCH_FAILED' },
    );
  }

  const head = {
    status: res.status,
    etag: res.headers?.get?.('etag') ?? null,
    lastModified: res.headers?.get?.('last-modified') ?? null,
    contentLength: Number(res.headers?.get?.('content-length')) || null,
    contentType: res.headers?.get?.('content-type') ?? null,
  };

  if (res.status === 304) {
    clearTimeout(timer);
    return { notModified: true, bytes: 0, sha256: null, headers: head, file: null, dispose: () => {} };
  }
  if (!res.ok) {
    clearTimeout(timer);
    throw new CsvFetchError(`el CSV respondió HTTP ${res.status}`, { status: res.status, code: 'HTTP_ERROR' });
  }
  // Si el servidor ya anuncia más de lo que admitimos, no se empieza.
  if (head.contentLength && head.contentLength > maxBytes) {
    clearTimeout(timer);
    throw new CsvFetchError(
      `el CSV anuncia ${head.contentLength} bytes y el tope es ${maxBytes}`,
      { bytes: head.contentLength, code: 'TOO_LARGE' },
    );
  }

  const file = path.join(dir, `cc-csv-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`);
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  let fd;
  const dispose = () => { try { fs.rmSync(file, { force: true }); } catch { /* ya no está */ } };

  try {
    fd = fs.openSync(file, 'wx');
    for await (const chunk of res.body) {
      const buf = Buffer.from(chunk);
      bytes += buf.length;
      if (bytes > maxBytes) {
        throw new CsvFetchError(
          `el CSV pasó de ${maxBytes} bytes mientras se descargaba (${bytes} y subiendo): se aborta`,
          { bytes, code: 'TOO_LARGE' },
        );
      }
      hash.update(buf);
      fs.writeFileSync(fd, buf);
    }
    fs.fsyncSync(fd);
  } catch (err) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ya cerrado */ } fd = undefined; }
    dispose();
    if (err instanceof CsvFetchError) throw err;
    // Una descarga cortada a medias es un error, no media verdad.
    throw new CsvFetchError(`la descarga se interrumpió tras ${bytes} bytes: ${err.message}`, {
      bytes, code: 'INTERRUPTED',
    });
  } finally {
    clearTimeout(timer);
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ya cerrado */ } }
  }

  if (bytes === 0) {
    dispose();
    throw new CsvFetchError('el CSV llegó vacío', { bytes: 0, code: 'EMPTY' });
  }

  return {
    notModified: false,
    file,
    bytes,
    sha256: hash.digest('hex'),
    headers: head,
    dispose,
  };
}

/**
 * Recorre un CSV del disco entregando objetos, y para en cuanto `onRow`
 * devuelve `'stop'`.
 *
 * Parar temprano es deliberado: con el tope de 50 candidatos no hace falta
 * convertir 40 000 filas en objetos para quedarse con 50. El hash ya está hecho
 * sobre el archivo entero, así que pararse aquí no le quita valor.
 */
export async function* streamCsvObjects(file, {
  chunkBytes = CSV_DEFAULTS.readChunkBytes,
  delimiter = ',',
  onHeader = null,
  // Algunos publicadores ponen un sello antes de la cabecera. El de ABC trae
  // "Updated Sunday 4th of October 2026…" en la línea 1, pese a que su página
  // dice que la primera línea son los nombres de campo. Se salta de forma
  // explícita y se entrega a quien llama, porque es la fecha que el dato declara
  // de sí mismo y vale como procedencia.
  skipLeadingLines = 0,
  onSkippedLine = null,
} = {}) {
  const parser = new CsvParser({ delimiter });
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(chunkBytes);
  let header = null;
  let lineNo = 0;
  let saltadas = 0;
  let primerTrozo = true;

  try {
    for (;;) {
      const read = fs.readSync(fd, buf, 0, chunkBytes, null);
      let texto = read === 0 ? '' : buf.toString('utf8', 0, read);
      // El BOM del primer trozo se quita antes de parsear. No es un detalle
      // estético: con el BOM delante, el parser ve un carácter y después una
      // comilla en medio de un campo sin entrecomillar, y la primera línea del
      // archivo se vuelve un error de formato. El volcado de ABC llega así.
      if (primerTrozo && texto.charCodeAt(0) === 0xFEFF) texto = texto.slice(1);
      primerTrozo = false;
      const rows = read === 0 ? parser.end() : parser.push(texto);
      for (const cells of rows) {
        lineNo++;
        if (saltadas < skipLeadingLines) {
          saltadas++;
          if (onSkippedLine) onSkippedLine(cells);
          continue;
        }
        if (!header) {
          header = cells.map((c) => c.trim());
          // La cabecera se entrega antes de la primera fila, para que quien
          // llama pueda contrastarla con el esquema que atestiguó y parar si no
          // coincide. Si `onHeader` lanza, el `finally` cierra el descriptor.
          if (onHeader) onHeader(header);
          continue;
        }
        // Una línea en blanco al final no es una fila.
        if (cells.length === 1 && cells[0] === '') continue;
        yield { lineNo, ...rowToObject(header, cells) };
      }
      if (read === 0) break;
    }
  } finally {
    fs.closeSync(fd);
  }
}

export default fetchCsvToTemp;
