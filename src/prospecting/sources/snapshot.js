/**
 * Un solo ciclo de recolección.
 *
 * El problema que resuelve: si la preview consulta el portal y luego el sync
 * vuelve a consultarlo, son dos corridas. Dos corridas gastan dos cuotas, y
 * —peor— el sync acabaría escribiendo en el CRM algo que nadie revisó, porque
 * entre las dos consultas el dataset pudo cambiar.
 *
 * Así que se consulta UNA vez. Esa consulta deja un snapshot saneado en disco
 * con su hash, y el sync reutiliza exactamente ese archivo: ni una petición
 * más, ni una cuota más, y lo que se escribe es literalmente lo que se enseñó.
 *
 * Tres propiedades que el archivo tiene que cumplir:
 *
 *   · **Saneado.** Dentro solo hay filas que ya pasaron todos los filtros. No
 *     hay campos prohibidos, no hay claves desconocidas y no hay filas
 *     residenciales. El snapshot no es un volcado del portal.
 *   · **Con hash.** `sha256` sobre el contenido canónico. Si alguien edita el
 *     archivo a mano para colar una fila, el sync lo rechaza.
 *   · **Atado a su sesión.** El hash dice que el contenido no cambió; no dice
 *     que la autorización para escribirlo siga siendo la de hace tres días. Un
 *     snapshot solo se reutiliza desde la misma sesión que lo creó.
 *
 * Fuera de git: `data/snapshots/` está en .gitignore. Son datos de negocio
 * recogidos de un registro público, no código, y no tienen por qué viajar en
 * el repositorio.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const SNAPSHOT_VERSION = 1;

const ROOT = path.resolve(new URL('../../../', import.meta.url).pathname);

export const snapshotDir = () => process.env.SOURCE_SNAPSHOT_DIR
  || path.join(ROOT, 'data', 'snapshots');

/**
 * Identificador de la sesión en curso.
 *
 * `boot_id` del kernel: estable mientras el contenedor viva y distinto en el
 * siguiente. Es exactamente la vida que debe tener una autorización para
 * escribir en el CRM de un cliente. Si no se puede leer, se cae a una variable
 * de entorno explícita, y si tampoco, el snapshot queda sin sesión y no se
 * podrá reutilizar: fail-closed.
 */
export function sessionId() {
  if (process.env.SOURCE_SESSION_ID) return String(process.env.SOURCE_SESSION_ID);
  try {
    return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** Serialización canónica: claves ordenadas, sin el campo del propio hash. */
export function canonicalize(value) {
  const walk = (v) => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(walk);
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (k === 'sha256') continue;
      out[k] = walk(v[k]);
    }
    return out;
  };
  return JSON.stringify(walk(value));
}

export function computeHash(doc) {
  return `sha256:${crypto.createHash('sha256').update(canonicalize(doc), 'utf8').digest('hex')}`;
}

/**
 * Resumen semántico para enseñar: conteos y campos de negocio.
 *
 * Lo que sale de aquí se imprime y se pega en informes, así que no puede
 * llevar un dato personal ni una fila cruda. Solo nombre comercial, ciudad,
 * tipo de establecimiento, estado del permiso y un trozo del identificador del
 * registro, que es lo que permite rastrear el origen sin exponer a nadie.
 */
export function summarize(rows = []) {
  return rows.map((r) => ({
    businessName: r.businessName,
    city: r.city,
    zip: r.zip,
    businessType: r.raw?.business_type || r.description || null,
    // Cada fuente nombra distinto el estado del permiso: el condado tiene
    // `permit_status` y la ciudad `account_status`. Dejar fija la del condado
    // hacía que el informe de la ciudad imprimiera "null" en las 50 filas.
    status: r.raw?.permit_status || r.raw?.account_status || r.signal?.permitStatus || null,
    entityType: r.entityType || null,
    segment: r.segment || null,
    // Los últimos caracteres identifican mejor que los primeros: en la ciudad
    // los primeros seis son iguales en miles de filas.
    recordIdPartial: r.sourceId ? `…${String(r.sourceId).slice(-8)}` : null,
    dedupKey: r.dedupKey || null,
  }));
}

/** Escribe el snapshot de forma atómica y devuelve `{ file, hash, doc }`. */
export function writeSnapshot({ sourceId, mode, cursorIn, cursorOut, rows, metrics, now = Date.now(), dir = snapshotDir() }) {
  const doc = {
    version: SNAPSHOT_VERSION,
    sourceId,
    mode,
    createdAt: new Date(now).toISOString(),
    sessionId: sessionId(),
    cursorIn: cursorIn ?? null,
    cursorOut: cursorOut ?? null,
    rowCount: rows.length,
    metrics,
    rows,
  };
  doc.sha256 = computeHash(doc);

  fs.mkdirSync(dir, { recursive: true });
  const stamp = doc.createdAt.replace(/[:.]/g, '-');
  const file = path.join(dir, `${sourceId}-${stamp}.json`);
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, `${JSON.stringify(doc, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  return { file, hash: doc.sha256, doc };
}

/**
 * Lee y valida un snapshot.
 *
 * Devuelve `{ ok, doc, problems }`. Comprueba el hash y, salvo que se pida lo
 * contrario, que la sesión sea la misma. No comprueba si las filas siguen
 * siendo ciertas en el portal: para eso habría que volver a consultar, que es
 * justo lo que este mecanismo evita.
 */
export function readSnapshot(file, { requireSameSession = true, maxAgeMs = 6 * 3600 * 1000, now = Date.now() } = {}) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { ok: false, doc: null, problems: [`no se puede leer el snapshot: ${err.message}`] };
  }

  const problems = [];
  if (doc.version !== SNAPSHOT_VERSION) {
    problems.push(`versión ${doc.version} desconocida (esperada ${SNAPSHOT_VERSION})`);
  }
  if (!Array.isArray(doc.rows)) problems.push('el snapshot no trae filas');

  const expected = computeHash(doc);
  if (doc.sha256 !== expected) {
    problems.push(`el hash no coincide: el archivo se modificó después de crearse (esperado ${expected})`);
  }

  const age = now - new Date(doc.createdAt).getTime();
  if (!Number.isFinite(age) || age < 0) problems.push('createdAt inválido o en el futuro');
  else if (age > maxAgeMs) {
    problems.push(`el snapshot tiene ${Math.round(age / 60000)} min: caducó (máximo ${Math.round(maxAgeMs / 60000)} min)`);
  }

  if (requireSameSession) {
    const current = sessionId();
    if (!doc.sessionId) problems.push('el snapshot no registró su sesión: no se puede reutilizar');
    else if (!current) problems.push('no se puede identificar la sesión actual');
    else if (doc.sessionId !== current) {
      problems.push('el snapshot es de otra sesión: la autorización para sincronizar no se hereda');
    }
  }

  return { ok: problems.length === 0, doc, problems };
}

/** El snapshot más reciente de una fuente, o null. */
export function latestSnapshot(sourceId, { dir = snapshotDir() } = {}) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  const mine = names
    .filter((n) => n.startsWith(`${sourceId}-`) && n.endsWith('.json'))
    .sort();
  return mine.length ? path.join(dir, mine[mine.length - 1]) : null;
}

export default writeSnapshot;
