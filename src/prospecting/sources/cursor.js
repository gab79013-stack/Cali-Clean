/**
 * De dónde sale el cursor, y por qué no de un archivo.
 *
 * El contenedor donde corre la Routine es efímero: `data/source-runtime-state.json`
 * desaparece entre ejecuciones. Un cursor guardado ahí no es un cursor, es una
 * ilusión de uno, y la consecuencia práctica es que cada corrida volvería a
 * empezar por el principio del dataset.
 *
 * Hay exactamente una cosa en este sistema que SÍ es durable y que ya sabe qué
 * se ha ingerido: el propio CRM. Si la clave de deduplicación se deriva del
 * `record_id` del condado con un namespace estable —y así es—, entonces
 *
 *     el cursor = el record_id más bajo ya presente en Companies
 *
 * y se recupera con un GET de una sola fila. No hace falta inventar
 * persistencia, no hace falta escribir nada en ningún sitio, y no hay estado
 * que se pueda desincronizar de la realidad: el estado ES la realidad.
 *
 * Tres orígenes, en este orden:
 *
 *   1. `local`  — el archivo de estado del contenedor. Rápido y correcto
 *                 mientras el contenedor viva; se usa si está.
 *   2. `crm`    — derivado del CRM con un GET. Es el durable.
 *   3. ninguno  — primera vez de verdad: bootstrap.
 *
 * Y una regla que no se negocia: si el CRM está configurado pero no se puede
 * leer, NO se hace bootstrap. Un bootstrap a ciegas recorrería otra vez la
 * cabeza del dataset, y aunque la deduplicación lo absorbiera, estaríamos
 * gastando la única corrida del día en releer lo que ya teníamos. Se para y se
 * dice por qué.
 */

import { readState } from './quota.js';

export const CURSOR_ORIGINS = Object.freeze(['local', 'crm', 'none']);

/**
 * Cursor guardado en el estado local del contenedor, si lo hay.
 * Devuelve `null` cuando no hay ninguno (incluido el caso del archivo ausente).
 */
export function localCursor(sourceId, { stateFile } = {}) {
  const state = stateFile ? readState(stateFile) : readState();
  const entry = state?.sources?.[sourceId];
  const value = entry?.cursor;
  return value ? String(value) : null;
}

/**
 * Cursor derivado del CRM.
 *
 * `lookup` recibe el prefijo del namespace y devuelve la clave de
 * deduplicación más baja ya existente, o null si no hay ninguna. Se inyecta
 * para que esto se pueda probar sin red y para que este archivo no dependa de
 * ningún adaptador concreto.
 */
export async function crmCursor(namespace, lookup) {
  if (typeof lookup !== 'function') return { ok: false, reason: 'sin_lookup' };
  const prefix = `${namespace}:`;
  const lowest = await lookup(prefix);
  if (!lowest) return { ok: true, cursor: null, empty: true };

  const key = String(lowest);
  if (!key.startsWith(prefix)) {
    // Una clave de otro namespace no puede usarse como cursor de este: sería
    // comparar identificadores de dos registros distintos.
    return { ok: false, reason: 'namespace_inesperado', detail: key.slice(0, 40) };
  }
  return { ok: true, cursor: key.slice(prefix.length), empty: false };
}

/**
 * Decide el modo de la corrida.
 *
 * Devuelve `{ mode, cursor, origin, reason, detail }` con `mode` en
 * `bootstrap` | `incremental` | `blocked`.
 *
 * `allowBootstrapWithoutCrm` existe para la preview: mirar qué traería el
 * bootstrap es inocuo y no necesita CRM. Para sincronizar es otra cosa, y ahí
 * el valor por defecto (false) obliga a tener un destino durable.
 */
export async function resolveCursor(sourceId, {
  namespace,
  stateFile,
  crmLookup = null,
  crmConfigured = false,
  allowBootstrapWithoutCrm = false,
} = {}) {
  const local = localCursor(sourceId, { stateFile });
  if (local) {
    return { mode: 'incremental', cursor: local, origin: 'local', reason: null };
  }

  if (crmConfigured) {
    let derived;
    try {
      derived = await crmCursor(namespace, crmLookup);
    } catch (err) {
      return {
        mode: 'blocked', cursor: null, origin: 'crm',
        reason: 'cursor_indeterminado',
        detail: `el CRM está configurado pero no se pudo leer el cursor: ${err.message}`,
      };
    }
    if (!derived.ok) {
      return {
        mode: 'blocked', cursor: null, origin: 'crm',
        reason: 'cursor_indeterminado',
        detail: derived.detail ? `${derived.reason} (${derived.detail})` : derived.reason,
      };
    }
    if (derived.empty) {
      return {
        mode: 'bootstrap', cursor: null, origin: 'crm',
        reason: null,
        detail: 'el CRM no tiene ninguna empresa de esta fuente: primera corrida de verdad',
      };
    }
    return { mode: 'incremental', cursor: derived.cursor, origin: 'crm', reason: null };
  }

  if (allowBootstrapWithoutCrm) {
    return {
      mode: 'bootstrap', cursor: null, origin: 'none', reason: null,
      detail: 'sin CRM configurado: bootstrap solo para mirar, el avance no se puede recordar',
    };
  }

  return {
    mode: 'blocked', cursor: null, origin: 'none',
    reason: 'sin_persistencia_durable',
    detail: 'no hay cursor local ni CRM configurado del que derivarlo. '
      + 'Una corrida que no puede recordar dónde se quedó volvería a empezar cada día.',
  };
}

export default resolveCursor;
