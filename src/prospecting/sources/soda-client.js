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

import {
  RETRY_DEFAULTS, parseRetryAfter, computeBackoff, waitForThrottle, defaultSleep,
} from './http-retry.js';

// La disciplina de reintentos vive en http-retry.js, compartida con los demás
// clientes. Aquí se re-exporta para no romper a quien ya la importaba de este
// módulo, y porque es donde una prueba de SODA espera encontrarla.
export { parseRetryAfter, computeBackoff };
export const DEFAULTS = RETRY_DEFAULTS;

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
      lastRetryAfterMs = parseRetryAfter(headerValue, clock());

      if (attempt >= maxAttempts) break;

      // El servidor manda si dice cuánto esperar; si no, backoff con jitter.
      const { waitMs } = waitForThrottle(attempt, headerValue, { clock, baseMs, capMs, random });

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
