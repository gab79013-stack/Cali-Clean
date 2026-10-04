import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ROOT } from '../../config.js';

/**
 * Cuota persistente por fuente.
 *
 * Dos límites, los dos de la política interna de la auditoría:
 *   · 50 filas por ejecución;
 *   · una ejecución EXITOSA por ventana móvil de 24 h.
 *
 * Tres decisiones que importan más de lo que parece:
 *
 * 1. Solo el éxito consume cuota. Si la corrida falla —429 agotado, red caída,
 *    endpoint cambiado— mañana no hay que esperar 24 h para reintentar. Un
 *    dry-run que llegó a consultar sí consume: el portal ya atendió la petición,
 *    y es su carga la que estamos limitando, no la nuestra.
 *
 * 2. La escritura es temp + fsync + rename. Un corte de luz a mitad no puede
 *    dejar un estado medio escrito que luego se lea como "nunca se ejecutó" y
 *    permita una segunda corrida el mismo día.
 *
 * 3. El lock falla cerrado. Si no se puede adquirir, no se ejecuta. Un lock
 *    abandonado por un proceso muerto caduca a los LOCK_STALE_MS, y romperlo
 *    queda registrado: es la única vía por la que se ignora un lock.
 */

export const STATE_VERSION = 1;
export const MAX_ROWS_PER_RUN = 50;
export const WINDOW_MS = 24 * 60 * 60 * 1000;
/** Un lock más viejo que esto se considera huérfano de un proceso muerto. */
export const LOCK_STALE_MS = 15 * 60 * 1000;

const statePath = () => process.env.SOURCE_RUNTIME_STATE_PATH
  || path.join(ROOT, 'data', 'source-runtime-state.json');
const lockPath = () => `${statePath()}.lock`;

// ── Estado ───────────────────────────────────────────────────
const emptyState = () => ({ version: STATE_VERSION, sources: {} });

export function readState(file = statePath()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return emptyState();
    if (parsed.version !== STATE_VERSION) {
      // Versión desconocida: no se interpreta ni se pisa. Fallar cerrado es
      // preferible a asumir un formato que quizá signifique otra cosa.
      const err = new Error(
        `El estado de cuota está en la versión ${parsed.version}, y este código entiende la ${STATE_VERSION}. ` +
        'No se ejecuta nada hasta resolverlo a mano.',
      );
      err.code = 'QUOTA_STATE_VERSION';
      throw err;
    }
    if (!parsed.sources || typeof parsed.sources !== 'object') return emptyState();
    return parsed;
  } catch (err) {
    if (err.code === 'QUOTA_STATE_VERSION') throw err;
    // Archivo ausente o corrupto: se parte de cero. Un estado ilegible no
    // puede conceder cuota, y aquí partir de cero es lo conservador porque
    // la ventana se comprueba contra marcas de tiempo, no contra un contador.
    return emptyState();
  }
}

/**
 * Escritura atómica: se escribe un temporal en el mismo directorio, se fuerza
 * a disco y se renombra. El rename dentro de un sistema de archivos es atómico,
 * así que un lector nunca ve un JSON a medias.
 */
export function writeStateAtomic(state, file = statePath()) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);

  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);

  // Sincronizar el directorio asegura que el propio rename sobrevive al corte.
  try {
    const dirFd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch {
    // En algunos sistemas de archivos no se puede fsync un directorio; el
    // rename sigue siendo atómico, que es la garantía que de verdad importa.
  }
  return state;
}

/** Limpia temporales abandonados por una escritura que no llegó a renombrar. */
export function cleanupStaleTemps(file = statePath(), { maxAgeMs = LOCK_STALE_MS, now = Date.now() } = {}) {
  const dir = path.dirname(file);
  const prefix = `.${path.basename(file)}.`;
  let removed = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return 0; }
  for (const name of entries) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
    const full = path.join(dir, name);
    try {
      if (now - fs.statSync(full).mtimeMs > maxAgeMs) { fs.unlinkSync(full); removed++; }
    } catch { /* otro proceso se adelantó */ }
  }
  return removed;
}

// ── Lock ─────────────────────────────────────────────────────
export function acquireLock({ file = lockPath(), now = Date.now(), staleMs = LOCK_STALE_MS } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date(now).toISOString() });

  try {
    // 'wx' falla si ya existe: así la adquisición es atómica.
    fs.writeFileSync(file, payload, { flag: 'wx' });
    return { acquired: true, file, brokeStale: false };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  let age = Infinity;
  let holder = null;
  try {
    const stat = fs.statSync(file);
    age = now - stat.mtimeMs;
    holder = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* el lock desapareció mientras lo mirábamos */ }

  if (age < staleMs) {
    return {
      acquired: false,
      reason: 'lock_ocupado',
      detail: `otro proceso tiene la cuota tomada desde hace ${Math.round(age / 1000)}s` +
        (holder?.pid ? ` (pid ${holder.pid})` : ''),
    };
  }

  // Lock caducado: se rompe, pero dejando constancia. Es la única excepción.
  try {
    fs.unlinkSync(file);
    fs.writeFileSync(file, payload, { flag: 'wx' });
    return { acquired: true, file, brokeStale: true, staleAgeMs: age };
  } catch {
    return { acquired: false, reason: 'lock_ocupado', detail: 'otro proceso se adelantó al romper el lock caducado' };
  }
}

export function releaseLock({ file = lockPath() } = {}) {
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

// ── Ventana de 24 h ──────────────────────────────────────────
export function lastSuccessAt(sourceId, state = readState()) {
  const at = state.sources?.[sourceId]?.lastSuccessAt;
  const t = at ? Date.parse(at) : NaN;
  return Number.isFinite(t) ? t : null;
}

export function checkQuota(sourceId, { now = Date.now(), state = readState(), windowMs = WINDOW_MS } = {}) {
  const last = lastSuccessAt(sourceId, state);
  if (last === null) return { allowed: true, remainingMs: 0 };
  const elapsed = now - last;
  if (elapsed >= windowMs) return { allowed: true, remainingMs: 0 };
  return {
    allowed: false,
    reason: 'cuota_24h',
    remainingMs: windowMs - elapsed,
    lastSuccessAt: new Date(last).toISOString(),
  };
}

export function recordSuccess(sourceId, { now = Date.now(), rows = 0, cursor = null, file = statePath() } = {}) {
  const state = readState(file);
  const prev = state.sources[sourceId] || { runs: 0, rowsTotal: 0 };
  state.sources[sourceId] = {
    lastSuccessAt: new Date(now).toISOString(),
    runs: (prev.runs || 0) + 1,
    rowsTotal: (prev.rowsTotal || 0) + rows,
    lastRows: rows,
    // El cursor viaja aquí por comodidad en el mismo contenedor. NO es su
    // custodia: este archivo muere con el contenedor y el cursor durable se
    // deriva del CRM (ver cursor.js). Si falta, no se pierde nada.
    cursor: cursor ?? prev.cursor ?? null,
  };
  writeStateAtomic(state, file);
  return state.sources[sourceId];
}

/**
 * Ejecuta `fn` bajo cuota y lock.
 *
 * `fn` recibe `{ maxRows }` y debe devolver `{ rows, consumed }`. Solo se anota
 * el éxito si `consumed` es true: así una corrida que ni llegó a consultar no
 * gasta la ventana del día.
 */
export async function withQuota(sourceId, fn, {
  now = () => Date.now(),
  maxRows = MAX_ROWS_PER_RUN,
  windowMs = WINDOW_MS,
  stateFile = statePath(),
  lockFile = lockPath(),
} = {}) {
  cleanupStaleTemps(stateFile, { now: now() });

  const lock = acquireLock({ file: lockFile, now: now() });
  if (!lock.acquired) {
    return { ran: false, blocked: true, reason: lock.reason, detail: lock.detail };
  }

  try {
    const quota = checkQuota(sourceId, { now: now(), state: readState(stateFile), windowMs });
    if (!quota.allowed) {
      return {
        ran: false,
        blocked: true,
        reason: quota.reason,
        detail: `última corrida con éxito ${quota.lastSuccessAt}; faltan ${Math.ceil(quota.remainingMs / 60000)} min`,
        remainingMs: quota.remainingMs,
      };
    }

    const result = await fn({ maxRows });
    const consumed = result?.consumed === true;
    if (consumed) {
      recordSuccess(sourceId, {
        now: now(), rows: result?.rows ?? 0, cursor: result?.cursor ?? null, file: stateFile,
      });
    }
    return { ran: true, blocked: false, consumed, brokeStaleLock: lock.brokeStale === true, result };
  } finally {
    releaseLock({ file: lockFile });
  }
}

export const paths = { statePath, lockPath };
