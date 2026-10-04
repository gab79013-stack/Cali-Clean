/**
 * Reintentos acotados ante 429 y errores transitorios, en un solo sitio.
 *
 * Existe porque hay cuatro clientes que piden a un servidor ajeno —SODA, un CSV
 * estático, ArcGIS y CKAN— y los cuatro necesitan exactamente la misma
 * disciplina. Tres copias de esta lógica no se mantienen iguales: una se
 * arregla, las otras dos no, y el día que un portal empieza a limitar el caudal
 * resulta que solo uno de los cuatro clientes se porta bien.
 *
 * Las reglas, que son las de la política interna:
 *   · un número máximo de intentos, y se abandona diciendo cuántos hubo;
 *   · espera base que duplica, con tope;
 *   · jitter completo, para que varios procesos no reintenten a la vez;
 *   · si el servidor dice `Retry-After`, manda el servidor;
 *   · un `Retry-After` absurdo se trunca, no se obedece a ciegas.
 */

export const RETRY_DEFAULTS = Object.freeze({
  maxAttempts: 4,
  baseMs: 1000,
  capMs: 30000,
  maxRetryAfterMs: 300000,
});

/**
 * Interpreta `Retry-After` en sus dos formatos: segundos (`120`) o fecha HTTP
 * (`Wed, 21 Oct 2026 07:28:00 GMT`). Devuelve milisegundos, o null.
 */
export function parseRetryAfter(value, now = Date.now()) {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  if (/^\d+(\.\d+)?$/.test(raw)) {
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return Math.round(seconds * 1000);
  }

  // Los tres formatos de RFC 7231 empiezan por el nombre del día, y exigirlo
  // evita que `Date.parse` acepte basura como "-5" y la convierta en una espera
  // de cero: reintentar al instante contra un servidor que acaba de devolver
  // 429 es lo peor que se puede hacer.
  if (!/^[A-Za-z]{3}/.test(raw)) return null;
  const when = Date.parse(raw);
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - now);
}

/**
 * Espera del reintento número `attempt` (1 = primer reintento).
 *
 * Jitter completo: se elige al azar dentro de [0, espera], no alrededor de ella.
 * Reparte mejor los reintentos de varios procesos que el jitter parcial, a
 * cambio de que a veces se reintente antes de lo nominal.
 */
export function computeBackoff(attempt, {
  baseMs = RETRY_DEFAULTS.baseMs,
  capMs = RETRY_DEFAULTS.capMs,
  random = Math.random,
} = {}) {
  const nominal = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.min(capMs, Math.floor(random() * nominal));
}

export const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Cuánto esperar ante un 429, con el servidor por delante del backoff propio. */
export function waitForThrottle(attempt, retryAfterHeader, {
  clock = () => Date.now(),
  baseMs = RETRY_DEFAULTS.baseMs,
  capMs = RETRY_DEFAULTS.capMs,
  maxRetryAfterMs = RETRY_DEFAULTS.maxRetryAfterMs,
  random = Math.random,
} = {}) {
  const fromHeader = parseRetryAfter(retryAfterHeader, clock());
  if (fromHeader === null) {
    return { waitMs: computeBackoff(attempt, { baseMs, capMs, random }), fromHeader: null };
  }
  return { waitMs: Math.min(fromHeader, maxRetryAfterMs), fromHeader };
}

export class ThrottleExhaustedError extends Error {
  constructor(message, { status, attempts, retryAfterMs, url } = {}) {
    super(message);
    this.name = 'ThrottleExhaustedError';
    this.status = status;
    this.attempts = attempts;
    this.retryAfterMs = retryAfterMs;
    // La URL lleva parámetros de consulta, nunca credenciales.
    this.url = url;
  }
}

/**
 * Ejecuta `doRequest` con reintentos. `doRequest(attempt)` devuelve la respuesta
 * y `classify(res)` dice qué hacer con ella: `'ok'`, `'throttled'` o `'fatal'`.
 *
 * Devuelve `{ res, metrics }`. Las métricas cuentan intentos, reintentos, 429 y
 * espera acumulada por separado: un 429 obedecido y un reintento por error de
 * red no son lo mismo cuando luego hay que explicar por qué una corrida tardó.
 */
export async function requestWithRetry({
  doRequest,
  classify,
  retryAfterOf = (res) => (typeof res?.headers?.get === 'function' ? res.headers.get('retry-after') : null),
  describe = () => 'la petición',
  url = null,
  maxAttempts = RETRY_DEFAULTS.maxAttempts,
  baseMs = RETRY_DEFAULTS.baseMs,
  capMs = RETRY_DEFAULTS.capMs,
  maxRetryAfterMs = RETRY_DEFAULTS.maxRetryAfterMs,
  sleep = defaultSleep,
  clock = () => Date.now(),
  random = Math.random,
}) {
  const metrics = { attempts: 0, retries: 0, http429: 0, waitedMs: 0 };
  let lastStatus = null;
  let lastRetryAfterMs = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    metrics.attempts = attempt;
    const res = await doRequest(attempt);
    lastStatus = res?.status ?? null;

    const verdict = classify(res);
    if (verdict === 'ok') return { res, metrics };
    if (verdict !== 'throttled') return { res, metrics };

    metrics.http429++;
    const { waitMs, fromHeader } = waitForThrottle(attempt, retryAfterOf(res), {
      clock, baseMs, capMs, maxRetryAfterMs, random,
    });
    lastRetryAfterMs = fromHeader;
    if (attempt >= maxAttempts) break;

    metrics.retries++;
    metrics.waitedMs += waitMs;
    await sleep(waitMs);
  }

  throw new ThrottleExhaustedError(
    `${describe()} sigue limitada tras ${metrics.attempts} intentos`
    + (lastRetryAfterMs !== null ? ` (último Retry-After: ${Math.round(lastRetryAfterMs / 1000)}s)` : ' (sin Retry-After)')
    + '. Se abandona la corrida: insistir más solo empeora el bloqueo.',
    { status: lastStatus, attempts: metrics.attempts, retryAfterMs: lastRetryAfterMs, url },
  );
}

export default requestWithRetry;
