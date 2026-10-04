/**
 * Cuota de 24 h que sobrevive al contenedor.
 *
 * La brecha que cierra: `data/source-runtime-state.json` muere con el
 * contenedor, así que dos contenedores del mismo día no se ven entre sí. Cada
 * uno cree ser el primero y los dos consultan el portal. La cuota local no está
 * mal, es que no puede saber lo que no vivió.
 *
 * La autoridad durable es el CRM, y no hace falta crear ningún registro de
 * control para preguntárselo. Cada empresa ingerida de esta fuente lleva su
 * `lastVerified`, que es la marca del snapshot con el que se escribió. Así que
 *
 *     última corrida con éxito = max(lastVerified) entre las Companies ACTIVAS
 *                                cuya clave empieza por `sdcounty-ffp:`
 *
 * Un GET, una fila, cero escrituras, cero registros inventados.
 *
 * Qué se excluye a propósito, y por qué:
 *   · las empresas en **borrado blando** — alguien las retiró, y su marca no
 *     puede seguir gobernando lo que el sistema hace hoy;
 *   · las empresas de **otras procedencias** — los leads que el administrador
 *     creó a mano tienen su propia clave y su propio `lastVerified`, y no
 *     dicen nada sobre cuándo se consultó este portal.
 *
 * Tres reglas, en este orden:
 *   1. Hay marca y han pasado menos de 24 h → BLOQUEADO. No se toca el portal.
 *   2. Hay empresas del prefijo pero el CRM no se puede leer o su marca no es
 *      válida → BLOQUEADO. Fail-closed: no saber cuándo se corrió no es
 *      permiso para correr.
 *   3. No hay ninguna empresa del prefijo → bootstrap permitido. Es la primera
 *      vez de verdad.
 *
 * A las 24 h exactas se permite: el límite es "una cada 24 h", no "una cada
 * 24 h y un segundo".
 */

export const DURABLE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * @param {object} opts
 * @param {string} opts.namespace  prefijo de la clave, sin los dos puntos
 * @param {Function} opts.lookup   (prefix) => { dedupKey, lastVerified } | null
 * @param {boolean} opts.required  si false y no hay lookup, no se comprueba
 */
export async function checkDurableQuota({
  namespace,
  lookup,
  now = Date.now(),
  windowMs = DURABLE_WINDOW_MS,
  required = true,
} = {}) {
  if (!namespace) {
    return { allowed: true, authority: 'ninguna', reason: null, detail: 'la fuente no declara namespace' };
  }
  const prefix = `${namespace}:`;

  if (typeof lookup !== 'function') {
    if (!required) {
      return { allowed: true, authority: 'ninguna', reason: null, detail: 'sin CRM: la cuota durable no se puede comprobar' };
    }
    return {
      allowed: false, authority: 'crm', reason: 'cuota_durable_indeterminada',
      detail: 'no hay forma de preguntar al CRM cuándo fue la última corrida.',
    };
  }

  let row;
  try {
    row = await lookup(prefix);
  } catch (err) {
    return {
      allowed: false, authority: 'crm', reason: 'cuota_durable_indeterminada',
      detail: `el CRM no se pudo leer: ${err.message}`,
    };
  }

  // Ninguna empresa de esta fuente: primera vez de verdad.
  if (!row) {
    return {
      allowed: true, authority: 'crm', reason: null, lastVerifiedAt: null,
      detail: 'el CRM no tiene ninguna empresa de esta fuente',
    };
  }

  // La fila tiene que ser de ESTA fuente. Si el filtro del CRM devolviera algo
  // de otro prefijo, la marca no significaría lo que creemos: se bloquea en vez
  // de interpretarla.
  const key = String(row.dedupKey ?? '');
  if (!key.startsWith(prefix)) {
    return {
      allowed: false, authority: 'crm', reason: 'cuota_durable_indeterminada',
      detail: `el CRM devolvió una clave de otro namespace: "${key.slice(0, 40)}"`,
    };
  }

  // Hay empresa pero sin marca: se ingirió algo y no se sabe cuándo.
  if (row.lastVerified === null || row.lastVerified === undefined || row.lastVerified === '') {
    return {
      allowed: false, authority: 'crm', reason: 'cuota_durable_indeterminada',
      detail: 'hay empresas de esta fuente pero ninguna con Last Verified: no se sabe cuándo fue la última corrida.',
    };
  }

  const at = new Date(String(row.lastVerified)).getTime();
  if (!Number.isFinite(at)) {
    return {
      allowed: false, authority: 'crm', reason: 'cuota_durable_indeterminada',
      detail: `Last Verified ilegible: "${String(row.lastVerified).slice(0, 40)}"`,
    };
  }

  const elapsed = now - at;
  if (elapsed < 0) {
    // Una marca en el futuro significa un reloj mal puesto en algún sitio. No
    // se descarta como si no existiera: se bloquea, que es el lado seguro.
    return {
      allowed: false, authority: 'crm', reason: 'cuota_durable_indeterminada',
      detail: `Last Verified en el futuro (${new Date(at).toISOString()}): hay un reloj mal puesto.`,
      lastVerifiedAt: new Date(at).toISOString(),
    };
  }

  if (elapsed < windowMs) {
    const remainingMs = windowMs - elapsed;
    return {
      allowed: false, authority: 'crm', reason: 'cuota_24h_durable',
      lastVerifiedAt: new Date(at).toISOString(),
      remainingMs,
      detail: `última ingestión visible en el CRM ${new Date(at).toISOString()}; `
        + `faltan ${Math.ceil(remainingMs / 60000)} min`,
    };
  }

  return {
    allowed: true, authority: 'crm', reason: null,
    lastVerifiedAt: new Date(at).toISOString(),
    detail: `última ingestión hace ${Math.floor(elapsed / 3600000)} h`,
  };
}

export default checkDurableQuota;
