/**
 * Extrae UNA entrada de un ZIP que ya está en disco, sin dependencias.
 *
 * El volcado diario de ABC se publica zipeado, así que entre la descarga y el
 * parser hace falta un paso más. Tres decisiones que definen este módulo:
 *
 * 1. **Se lee el directorio central, no el encabezado local.** El encabezado
 *    local puede traer tamaños a cero y un descriptor al final de los datos
 *    (bit 3 de `flags`), y entonces no se sabe cuánto hay que inflar hasta
 *    haberlo inflado. El directorio central, que vive al final del archivo,
 *    siempre trae los tamaños reales. Es la fuente fiable.
 *
 * 2. **Se infla a un temporal y se borra siempre.** Lo mismo que con el CSV: el
 *    volcado de ABC trae nombres de titulares, y un archivo inflado en disco es
 *    un dato almacenado, no un dato mirado de paso.
 *
 * 3. **Tope del inflado, no solo del comprimido.** Un ZIP de 7 MB puede
 *    anunciar 40 GB al inflarse. El tope se comprueba contra lo que el
 *    directorio central declara Y contra lo que realmente va saliendo, porque un
 *    archivo malicioso puede declarar poco y soltar mucho.
 *
 * No se admite cifrado, ni entradas múltiples sin nombrar la que se quiere, ni
 * métodos distintos de "almacenado" y "deflate": son los dos que usa cualquier
 * publicador, y admitir más sin un caso real es ampliar la superficie por nada.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

export const ZIP_DEFAULTS = Object.freeze({
  maxInflatedBytes: 512 * 1024 * 1024,
  readChunkBytes: 1 << 20,
});

const FIRMA_EOCD = 0x06054b50;
const FIRMA_CD = 0x02014b50;
const FIRMA_LOCAL = 0x04034b50;

export class ZipError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'ZipError';
    this.code = code;
  }
}

/**
 * Localiza el End of Central Directory recorriendo el final del archivo hacia
 * atrás. El comentario del ZIP puede ocupar hasta 64 KiB, así que se mira ese
 * último trozo y no más: si no está ahí, el archivo no es un ZIP válido.
 */
function leerEocd(fd, tamaño) {
  const maximo = Math.min(tamaño, 65557);
  const buf = Buffer.alloc(maximo);
  fs.readSync(fd, buf, 0, maximo, tamaño - maximo);
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) !== FIRMA_EOCD) continue;
    const entradas = buf.readUInt16LE(i + 10);
    const tamañoCd = buf.readUInt32LE(i + 12);
    const offsetCd = buf.readUInt32LE(i + 16);
    if (entradas === 0xffff || offsetCd === 0xffffffff) {
      throw new ZipError('el ZIP usa ZIP64 y este lector no lo implementa', { code: 'ZIP64' });
    }
    return { entradas, tamañoCd, offsetCd };
  }
  throw new ZipError('no se encontró el End of Central Directory: esto no es un ZIP', { code: 'NOT_ZIP' });
}

/** Lee el directorio central y devuelve las entradas con sus tamaños reales. */
export function listZipEntries(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const { tamaño } = { tamaño: fs.fstatSync(fd).size };
    const { entradas, tamañoCd, offsetCd } = leerEocd(fd, tamaño);
    const cd = Buffer.alloc(tamañoCd);
    fs.readSync(fd, cd, 0, tamañoCd, offsetCd);

    const out = [];
    let p = 0;
    for (let n = 0; n < entradas; n++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== FIRMA_CD) {
        throw new ZipError('el directorio central está corrupto', { code: 'BAD_CENTRAL_DIR' });
      }
      const flags = cd.readUInt16LE(p + 8);
      const metodo = cd.readUInt16LE(p + 10);
      const comprimido = cd.readUInt32LE(p + 20);
      const inflado = cd.readUInt32LE(p + 24);
      const lenNombre = cd.readUInt16LE(p + 28);
      const lenExtra = cd.readUInt16LE(p + 30);
      const lenComentario = cd.readUInt16LE(p + 32);
      const offsetLocal = cd.readUInt32LE(p + 42);
      const nombre = cd.toString('utf8', p + 46, p + 46 + lenNombre);
      out.push({ nombre, metodo, flags, comprimido, inflado, offsetLocal });
      p += 46 + lenNombre + lenExtra + lenComentario;
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Infla una entrada del ZIP a un archivo temporal y devuelve
 * `{ file, bytes, sha256, entry, dispose }`.
 *
 * `dispose()` borra el inflado y hay que llamarlo siempre, en un `finally`.
 */
export async function extractZipEntry(file, {
  entryName = null,
  expectExtension = null,
  dir = path.dirname(file),
  maxInflatedBytes = ZIP_DEFAULTS.maxInflatedBytes,
} = {}) {
  const entradas = listZipEntries(file).filter((e) => !e.nombre.endsWith('/'));
  if (entradas.length === 0) throw new ZipError('el ZIP no contiene ningún archivo', { code: 'EMPTY_ZIP' });

  let entrada;
  if (entryName) {
    entrada = entradas.find((e) => e.nombre === entryName);
    if (!entrada) {
      throw new ZipError(
        `el ZIP no contiene "${entryName}"; trae ${entradas.length} entrada(s)`,
        { code: 'ENTRY_NOT_FOUND' },
      );
    }
  } else if (entradas.length === 1) {
    [entrada] = entradas;
  } else {
    // Varias entradas y nadie dijo cuál: elegir por nosotros sería adivinar qué
    // archivo es el dato.
    throw new ZipError(
      `el ZIP trae ${entradas.length} archivos y no se dijo cuál se quiere`,
      { code: 'AMBIGUOUS_ZIP' },
    );
  }

  if (expectExtension && !entrada.nombre.toLowerCase().endsWith(expectExtension.toLowerCase())) {
    throw new ZipError(
      `la entrada del ZIP no termina en "${expectExtension}": el contenido no es el auditado`,
      { code: 'WRONG_EXTENSION' },
    );
  }
  if (entrada.flags & 0x1) {
    throw new ZipError('la entrada está cifrada', { code: 'ENCRYPTED' });
  }
  if (entrada.metodo !== 0 && entrada.metodo !== 8) {
    throw new ZipError(`método de compresión ${entrada.metodo} no soportado`, { code: 'UNSUPPORTED_METHOD' });
  }
  if (entrada.inflado > maxInflatedBytes) {
    throw new ZipError(
      `la entrada declara ${entrada.inflado} bytes al inflarse y el tope es ${maxInflatedBytes}`,
      { code: 'TOO_LARGE' },
    );
  }

  // El encabezado local da el desplazamiento real de los datos: su longitud
  // varía con el nombre y los campos extra, que no tienen por qué coincidir con
  // los del directorio central.
  const fd = fs.openSync(file, 'r');
  const salida = path.join(dir, `cc-unzip-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`);
  const dispose = () => { try { fs.rmSync(salida, { force: true }); } catch { /* ya no está */ } };
  const hash = crypto.createHash('sha256');
  let escritos = 0;
  let fdSalida;

  try {
    const cabecera = Buffer.alloc(30);
    fs.readSync(fd, cabecera, 0, 30, entrada.offsetLocal);
    if (cabecera.readUInt32LE(0) !== FIRMA_LOCAL) {
      throw new ZipError('el encabezado local no coincide con el directorio central', { code: 'BAD_LOCAL_HEADER' });
    }
    const inicioDatos = entrada.offsetLocal + 30 + cabecera.readUInt16LE(26) + cabecera.readUInt16LE(28);

    fdSalida = fs.openSync(salida, 'wx');
    const escribir = (buf) => {
      escritos += buf.length;
      if (escritos > maxInflatedBytes) {
        throw new ZipError(
          `la entrada pasó de ${maxInflatedBytes} bytes al inflarse (${escritos} y subiendo): se aborta`,
          { code: 'TOO_LARGE' },
        );
      }
      hash.update(buf);
      fs.writeFileSync(fdSalida, buf);
    };

    if (entrada.metodo === 0) {
      let restan = entrada.comprimido;
      let pos = inicioDatos;
      const buf = Buffer.alloc(ZIP_DEFAULTS.readChunkBytes);
      while (restan > 0) {
        const leidos = fs.readSync(fd, buf, 0, Math.min(buf.length, restan), pos);
        if (leidos === 0) break;
        escribir(buf.subarray(0, leidos));
        pos += leidos; restan -= leidos;
      }
    } else {
      await new Promise((resolve, reject) => {
        const inflate = zlib.createInflateRaw();
        inflate.on('data', (chunk) => {
          try { escribir(chunk); } catch (err) { inflate.destroy(err); }
        });
        inflate.on('end', resolve);
        inflate.on('error', reject);

        let restan = entrada.comprimido;
        let pos = inicioDatos;
        const buf = Buffer.alloc(ZIP_DEFAULTS.readChunkBytes);
        const empujar = () => {
          try {
            while (restan > 0) {
              const leidos = fs.readSync(fd, buf, 0, Math.min(buf.length, restan), pos);
              if (leidos === 0) break;
              pos += leidos; restan -= leidos;
              if (!inflate.write(Buffer.from(buf.subarray(0, leidos)))) {
                inflate.once('drain', empujar);
                return;
              }
            }
            inflate.end();
          } catch (err) { inflate.destroy(err); }
        };
        empujar();
      });
    }

    if (fdSalida !== undefined) { fs.fsyncSync(fdSalida); }
    if (escritos === 0) throw new ZipError('la entrada se infló a cero bytes', { code: 'EMPTY_ENTRY' });

    return {
      file: salida,
      bytes: escritos,
      sha256: hash.digest('hex'),
      entry: { name: entrada.nombre, declaredInflatedBytes: entrada.inflado, compressedBytes: entrada.comprimido },
      dispose,
    };
  } catch (err) {
    dispose();
    throw err instanceof ZipError ? err : new ZipError(`no se pudo inflar la entrada: ${err.message}`, { code: 'INFLATE_FAILED' });
  } finally {
    if (fdSalida !== undefined) { try { fs.closeSync(fdSalida); } catch { /* ya cerrado */ } }
    fs.closeSync(fd);
  }
}

export default extractZipEntry;
