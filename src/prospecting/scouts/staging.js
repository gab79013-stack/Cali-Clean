/**
 * Staging sellado: lo único que produce un scout.
 *
 * Un scout no escribe en el CRM. No puede: no importa el adaptador de Twenty y
 * una prueba lo comprueba. Lo que produce es un archivo de staging, y ese
 * archivo es el contrato con la capa central.
 *
 * Qué significa "sellado", y cada parte está por un motivo:
 *
 *   · **hash** — SHA256 sobre el contenido canónico. Si alguien edita el archivo
 *     para colar una fila, la capa central lo rechaza.
 *   · **runId** — identifica la corrida. Dos corridas del mismo scout el mismo
 *     día producen archivos distinguibles, y un informe puede citar cuál se usó.
 *   · **createdAt + expiresAt** — un staging caduca. Lo que se vio hace tres días
 *     no es lo que hay hoy, y escribir en un CRM desde datos caducados es cómo se
 *     resucita una instalación que ya cerró.
 *   · **sessionId** — un staging solo se reutiliza desde la sesión que lo creó. El
 *     hash dice que el contenido no cambió; no dice que la autorización siga
 *     vigente.
 *
 * Fuera de git: son datos de negocio recogidos de registros públicos, no código.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT } from '../../config.js';

export const STAGING_VERSION = 1;
export const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

export const stagingDir = () => process.env.SCOUT_STAGING_DIR
  || path.join(ROOT, 'data', 'staging');

export function sessionId() {
  if (process.env.SOURCE_SESSION_ID) return String(process.env.SOURCE_SESSION_ID);
  try {
    return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function newRunId() {
  return `run_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`;
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

/** Escribe el staging de forma atómica y devuelve `{ file, hash, doc }`. */
export function writeStaging({
  scoutId,
  displayName,
  candidates,
  metrics,
  provenance,
  now = Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  runId = newRunId(),
  dir = stagingDir(),
}) {
  const doc = {
    version: STAGING_VERSION,
    scoutId,
    displayName,
    runId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
    sessionId: sessionId(),
    // De dónde salió: URLs oficiales, licencia, hash del artefacto si lo hubo.
    provenance,
    candidateCount: candidates.length,
    metrics,
    candidates,
  };
  doc.sha256 = computeHash(doc);

  fs.mkdirSync(dir, { recursive: true });
  const stamp = doc.createdAt.replace(/[:.]/g, '-');
  const file = path.join(dir, `${scoutId}-${stamp}-${runId}.json`);
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
 * Lee y valida un staging. Devuelve `{ ok, doc, problems }`.
 *
 * No comprueba si los candidatos siguen siendo ciertos en el portal: para eso
 * habría que volver a consultar, que es justo lo que este mecanismo evita.
 */
export function readStaging(file, { requireSameSession = true, now = Date.now() } = {}) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { ok: false, doc: null, problems: [`no se puede leer el staging: ${err.message}`] };
  }

  const problems = [];
  if (doc.version !== STAGING_VERSION) {
    problems.push(`versión ${doc.version} desconocida (esperada ${STAGING_VERSION})`);
  }
  if (!Array.isArray(doc.candidates)) problems.push('el staging no trae candidatos');
  if (!doc.runId) problems.push('el staging no trae runId');

  const expected = computeHash(doc);
  if (doc.sha256 !== expected) {
    problems.push(`el hash no coincide: el archivo se modificó después de crearse (esperado ${expected})`);
  }

  const creado = new Date(doc.createdAt).getTime();
  const caduca = new Date(doc.expiresAt).getTime();
  if (!Number.isFinite(creado) || creado > now) problems.push('createdAt inválido o en el futuro');
  if (!Number.isFinite(caduca)) problems.push('expiresAt inválido');
  else if (now > caduca) {
    problems.push(`el staging caducó el ${doc.expiresAt}: lo que se vio entonces no es lo que hay ahora`);
  }

  if (requireSameSession) {
    const actual = sessionId();
    if (!doc.sessionId) problems.push('el staging no registró su sesión: no se puede reutilizar');
    else if (!actual) problems.push('no se puede identificar la sesión actual');
    else if (doc.sessionId !== actual) {
      problems.push('el staging es de otra sesión: la autorización no se hereda');
    }
  }

  return { ok: problems.length === 0, doc, problems };
}

/** Los staging más recientes, uno por scout. */
export function latestStagingPerScout({ dir = stagingDir(), scoutIds = [] } = {}) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return {}; }
  const out = {};
  for (const id of scoutIds) {
    const mios = names.filter((n) => n.startsWith(`${id}-`) && n.endsWith('.json')).sort();
    if (mios.length) out[id] = path.join(dir, mios[mios.length - 1]);
  }
  return out;
}

export default writeStaging;
