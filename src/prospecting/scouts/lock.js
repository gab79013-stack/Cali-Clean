/**
 * Lock global de la fase 3.
 *
 * Los tres scouts comparten cuota de atención de portales públicos y, sobre todo,
 * comparten la capa central. Dos orquestaciones a la vez leerían el mismo índice
 * del CRM, validarían los mismos staging y podrían planificar dos veces la misma
 * creación. El lock es por fase, no por scout: las cuotas ya son por scout, y lo
 * que aquí se protege es el ciclo completo.
 *
 * Crash-safe por la misma razón que el de las cuotas: se crea con `wx` —así solo
 * gana quien lo crea— y caduca, porque un proceso que muere sin soltar el lock no
 * puede dejar la fase bloqueada para siempre.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../../config.js';

export const LOCK_STALE_MS = 30 * 60 * 1000;

export const lockPath = () => process.env.PHASE3_LOCK_PATH
  || path.join(ROOT, 'data', 'phase3.lock');

export function acquirePhaseLock({ file = lockPath(), now = Date.now(), staleMs = LOCK_STALE_MS } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const contenido = JSON.stringify({ pid: process.pid, at: new Date(now).toISOString() });

  try {
    fs.writeFileSync(file, contenido, { flag: 'wx' });
    return { acquired: true, brokeStale: false };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  // Hay lock. ¿Es de alguien vivo o de un proceso que murió?
  let edadMs = Infinity;
  let dueño = null;
  try {
    const st = fs.statSync(file);
    edadMs = now - st.mtimeMs;
    dueño = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* se borró entre medias */ }

  if (edadMs < staleMs) {
    return {
      acquired: false,
      reason: 'fase_en_curso',
      detail: `hay otra orquestación en marcha desde ${dueño?.at || 'hace poco'} (pid ${dueño?.pid ?? '?'})`,
    };
  }

  // Caducado: se rompe, pero se dice. Un lock roto en silencio esconde que algo
  // murió a medias, y eso es lo que hay que investigar.
  try {
    fs.rmSync(file, { force: true });
    fs.writeFileSync(file, contenido, { flag: 'wx' });
    return {
      acquired: true,
      brokeStale: true,
      detail: `se rompió un lock de hace ${Math.round(edadMs / 60000)} min (pid ${dueño?.pid ?? '?'}): `
        + 'algo murió sin soltarlo',
    };
  } catch {
    return { acquired: false, reason: 'carrera_por_el_lock', detail: 'otro proceso se adelantó' };
  }
}

export function releasePhaseLock({ file = lockPath() } = {}) {
  try { fs.rmSync(file, { force: true }); return true; } catch { return false; }
}

/** Ejecuta `fn` con el lock tomado, y lo suelta pase lo que pase. */
export async function withPhaseLock(fn, opts = {}) {
  const lock = acquirePhaseLock(opts);
  if (!lock.acquired) return { ran: false, blocked: true, ...lock };
  try {
    const result = await fn();
    return { ran: true, blocked: false, brokeStale: lock.brokeStale === true, detail: lock.detail, result };
  } finally {
    releasePhaseLock(opts);
  }
}

export default withPhaseLock;
