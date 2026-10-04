/**
 * Cliente SODA con control de caudal.
 *
 * Socrata no publica sus límites: avisa con un 429 y, a veces, con un
 * `Retry-After`. Un cliente que ignore eso acaba bloqueado por el portal, y el
 * bloqueo no se nota hasta que lleva días sin traer datos.
 *
 * Reglas, fijadas por la política interna de la auditoría:
 *   · máximo 4 intentos en total (el primero más 3 reintentos);
 *   · espera base 1 s, duplicando, con tope de 30 s;
 *   · jitter completo, para que varios procesos no reintenten a la vez;
 *   · si el servidor dice `Retry-After`, manda el servidor;
 *   · al agotar los intentos, error explícito que dice cuántos hubo.
 *
 * `clock`, `sleep` y `random` se inyectan: así las pruebas comprueban los
 * tiempos sin esperarlos de verdad.
 */

export const DEFAULTS = Object.freeze({
  maxAttempts: 4,
  baseMs: 1000,
  capMs: 30000,
  // Un Retry-After absurdo no se obedece a ciegas: se trunca y se reporta.
  maxRetryAfterMs: 300000,
});

export class SodaError extends Error {
  constructor(message, { status, attempts, retryAfterMs, url } = {}) {
    super(message);
    this.name = 'SodaError';
    this.status = status;
    this.attempts = attempts;
    this.retryAfterMs = retryAfterMs;
    // La URL lleva el $where y el $select, nunca credenciales.
    this.url = url;
  }
}

/**
 * Interpreta `Retry-After` en sus dos formatos: segundos (`120`) o fecha HTTP
 * (`Wed, 21 Oct 2026 07:28:00 GMT`). Devuelve milisegundos, o null si no se
 * puede interpretar.
 */
export function parseRetryAfter(value, now = Date.now()) {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  // Formato de segundos: solo dígitos, con decimales opcionales.
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return Math.round(seconds * 1000);
  }

  // Formato de fecha HTTP. Los tres formatos que admite RFC 7231 empiezan por
  // el nombre del día, y exigirlo evita que `Date.parse` acepte basura como
  // "-5" y la convierta en una espera de cero: reintentar al instante contra un
  // servidor que acaba de devolver 429 es lo peor que se puede hacer.
  if (!/^[A-Za-z]{3}/.test(raw)) return null;
  const when = Date.parse(raw);
  if (Number.isNaN(when)) return null;
  // Una fecha en el pasado significa "ya puedes": espera cero, no negativa.
  return Math.max(0, when - now);
}

/**
 * Espera del reintento número `attempt` (1 = primer reintento).
 *
 * Jitter completo: se elige al azar dentro de [0, espera], no alrededor de
 * ella. Reparte mejor los reintentos de varios procesos que el jitter parcial,
 * a cambio de que a veces se reintente antes de lo nominal.
 */
export function computeBackoff(attempt, { baseMs = DEFAULTS.baseMs, capMs = DEFAULTS.capMs, random = Math.random } = {}) {
  const nominal = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const jittered = Math.floor(random() * nominal);
  return Math.min(capMs, jittered);
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GET contra SODA con reintentos ante 429.
 *
 * Devuelve `{ rows, metrics }`. Las métricas cuentan reintentos y 429 por
 * separado: un 429 obedecido y un reintento por error de red no son lo mismo
 * cuando luego hay que explicar por qué una corrida tardó.
 */
export async function sodaGet(url, {
  fetchImpl = fetch,
  sleep = defaultSleep,
  clock = () => Date.now(),
  random = Math.random,
  maxAttempts = DEFAULTS.maxAttempts,
  baseMs = DEFAULTS.baseMs,
  capMs = DEFAULTS.capMs,
  headers = {},
  timeoutMs = 20000,
} = {}) {
  const metrics = { attempts: 0, retries: 0, http429: 0, waitedMs: 0 };
  let lastStatus = null;
  let lastRetryAfterMs = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    metrics.attempts = attempt;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json', ...headers },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    lastStatus = res.status;

    if (res.status === 429) {
      metrics.http429++;
      const headerValue = typeof res.headers?.get === 'function' ? res.headers.get('retry-after') : null;
      const fromHeader = parseRetryAfter(headerValue, clock());
      lastRetryAfterMs = fromHeader;

      if (attempt >= maxAttempts) break;

      // El servidor manda si dice cuánto esperar; si no, backoff con jitter.
      let waitMs = fromHeader ?? computeBackoff(attempt, { baseMs, capMs, random });
      if (fromHeader !== null && fromHeader > DEFAULTS.maxRetryAfterMs) {
        waitMs = DEFAULTS.maxRetryAfterMs;
      }

      metrics.retries++;
      metrics.waitedMs += waitMs;
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new SodaError(`SODA HTTP ${res.status}: ${body.slice(0, 200)}`, {
        status: res.status, attempts: attempt, url,
      });
    }

    const rows = await res.json();
    return { rows: Array.isArray(rows) ? rows : [], metrics };
  }

  throw new SodaError(
    `SODA sigue devolviendo 429 tras ${metrics.attempts} intentos` +
    (lastRetryAfterMs !== null ? ` (último Retry-After: ${Math.round(lastRetryAfterMs / 1000)}s)` : ' (sin Retry-After)') +
    '. Se abandona la corrida: insistir más solo empeora el bloqueo.',
    { status: lastStatus, attempts: metrics.attempts, retryAfterMs: lastRetryAfterMs, url },
  );
}

export default sodaGet;
