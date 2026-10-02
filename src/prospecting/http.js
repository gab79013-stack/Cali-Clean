import robotsParser from 'robots-parser';
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from '../config.js';

/**
 * Cliente HTTP de los agentes: identificado, lento a propósito y obediente con
 * robots.txt. Un prospector que machaca los servidores de sus futuros clientes
 * no es un prospector, es una molestia.
 */

const lastHit = new Map();   // host → timestamp del último request
const robotsCache = new Map(); // host → { isAllowed, crawlDelayMs, fetchedAt }
const ROBOTS_TTL_MS = 6 * 3600 * 1000;

const hostOf = (url) => { try { return new URL(url).host; } catch { return null; } };

/**
 * Punto de inyección para las pruebas: redirige las peticiones a un servidor
 * local conservando el host original. En producción vale `null` y no se usa.
 */
let rewriter = null;
export function setRequestRewriter(fn) { rewriter = fn; }

async function politeDelay(host) {
  const last = lastHit.get(host) || 0;
  const wait = config.prospecting.crawlDelayMs - (Date.now() - last);
  if (wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
}

async function rawFetch(url, { method = 'GET', headers = {}, timeoutMs } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || config.prospecting.requestTimeoutMs);
  const target = rewriter ? rewriter(url) : { url, headers: {} };
  try {
    return await fetch(target.url, {
      method,
      redirect: 'follow',
      headers: {
        'User-Agent': config.prospecting.userAgent,
        Accept: '*/*',
        ...headers,
        ...(target.headers || {}),
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Lectura de robots.txt delegada en el parser de referencia (RFC 9309), en vez
 * de uno propio: los comodines, el anclaje `$` y la precedencia por longitud
 * son justo donde un parser casero se equivoca, y aquí equivocarse significa
 * rastrear a quien nos pidió que no.
 *
 * Las reglas se comparan contra el **mismo** User-Agent que anunciamos, así que
 * un sitio que nos nombre por nuestro nombre nos encuentra.
 */
const ALLOW_ALL = { isAllowed: () => true, crawlDelayMs: null };

export function parseRobots(text, origin = 'https://robots.invalid', agent = config.prospecting.userAgent) {
  const robots = robotsParser(new URL('/robots.txt', origin).toString(), String(text || ''));
  const delay = robots.getCrawlDelay(agent);
  return {
    // `isAllowed` devuelve undefined si la ruta no es de este host o no es
    // válida; ahí se mantiene el criterio de siempre: permitir.
    isAllowed(target) {
      try {
        return robots.isAllowed(new URL(target, origin).toString(), agent) !== false;
      } catch {
        return true;
      }
    },
    crawlDelayMs: Number.isFinite(delay) ? delay * 1000 : null,
  };
}

/** Sin reglas aplicables se rastrea: permitir es el criterio por defecto. */
export function robotsAllows(robots, target) {
  return robots?.isAllowed ? robots.isAllowed(target) : true;
}

async function loadRobots(origin) {
  const host = hostOf(origin);
  const cached = robotsCache.get(host);
  if (cached && Date.now() - cached.fetchedAt < ROBOTS_TTL_MS) return cached;

  let parsed = ALLOW_ALL;
  try {
    await politeDelay(host);
    const res = await rawFetch(new URL('/robots.txt', origin).toString(), { timeoutMs: 8000 });
    // 404 significa "sin restricciones"; un 5xx no nos autoriza a asumirlo, pero
    // tampoco debe bloquear la prospección de un sitio que quizá sí permite.
    if (res.ok) parsed = parseRobots(await res.text(), origin);
  } catch {
    // Sin robots.txt legible seguimos con las reglas por defecto (permitir).
  }
  const entry = { ...parsed, fetchedAt: Date.now() };
  robotsCache.set(host, entry);
  return entry;
}

/**
 * Descarga una página respetando robots.txt y el ritmo del host.
 * Devuelve { ok, status, html, blocked, reason }.
 */
export async function politeFetch(url, opts = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { return { ok: false, blocked: true, reason: 'invalid_url' }; }
  if (!/^https?:$/.test(parsed.protocol)) return { ok: false, blocked: true, reason: 'bad_protocol' };

  const robots = await loadRobots(parsed.origin);
  // Con la query incluida: hay reglas que solo aplican a ciertos parámetros.
  if (!robotsAllows(robots, parsed.pathname + parsed.search)) {
    return { ok: false, blocked: true, reason: 'robots_disallow' };
  }

  // Si el sitio pide ir más despacio que nuestro ritmo, mandamos nosotros hacia abajo.
  const host = parsed.host;
  if (robots.crawlDelayMs && robots.crawlDelayMs > config.prospecting.crawlDelayMs) {
    const last = lastHit.get(host) || 0;
    const wait = robots.crawlDelayMs - (Date.now() - last);
    if (wait > 0) await sleep(wait);
    lastHit.set(host, Date.now());
  } else {
    await politeDelay(host);
  }

  try {
    const res = await rawFetch(url, opts);
    const type = res.headers.get('content-type') || '';
    if (!res.ok) return { ok: false, status: res.status, reason: `http_${res.status}` };
    if (!/text\/html|text\/plain|application\/json/.test(type)) {
      return { ok: false, status: res.status, reason: 'not_html' };
    }
    // Un sitio enorme no aporta más señal que sus primeros 600 KB.
    const body = (await res.text()).slice(0, 600_000);
    // Con el reescritor activo (solo en pruebas) la URL física es la del
    // servidor local; la que vale para seguir navegando es la lógica.
    return { ok: true, status: res.status, html: body, url: rewriter ? url : (res.url || url) };
  } catch (err) {
    return { ok: false, reason: err.name === 'AbortError' ? 'timeout' : `error:${err.message}` };
  }
}

/** Peticiones a APIs de datos abiertos: sin robots.txt, pero con el mismo ritmo. */
export async function apiFetch(url, opts = {}) {
  const host = hostOf(url);
  if (host) await politeDelay(host);
  const res = await rawFetch(url, opts);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status} en ${host}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export function _resetCachesForTests() {
  lastHit.clear();
  robotsCache.clear();
}
