import { setTimeout as sleep } from 'node:timers/promises';
import { config } from '../config.js';

/**
 * Cliente HTTP de los agentes: identificado, lento a propósito y obediente con
 * robots.txt. Un prospector que machaca los servidores de sus futuros clientes
 * no es un prospector, es una molestia.
 */

const lastHit = new Map();   // host → timestamp del último request
const robotsCache = new Map(); // host → { rules, fetchedAt, crawlDelayMs }
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

async function rawFetch(url, { method = 'GET', headers = {}, body, timeoutMs } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || config.prospecting.requestTimeoutMs);
  const target = rewriter ? rewriter(url) : { url, headers: {} };
  try {
    return await fetch(target.url, {
      method,
      body,
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

/** Parser mínimo de robots.txt: solo lo que necesitamos, Allow/Disallow y Crawl-delay. */
export function parseRobots(text, agent = 'caliclean') {
  const lines = String(text || '').split(/\r?\n/);
  const groups = [];
  let current = null;

  for (const raw of lines) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      // Varios User-agent seguidos comparten el mismo bloque de reglas.
      if (!current || current.rules.length) { current = { agents: [], rules: [], crawlDelay: null }; groups.push(current); }
      current.agents.push(value.toLowerCase());
    } else if (current && (field === 'allow' || field === 'disallow')) {
      current.rules.push({ type: field, path: value });
    } else if (current && field === 'crawl-delay') {
      const n = Number(value);
      if (!Number.isNaN(n)) current.crawlDelay = n * 1000;
    }
  }

  const ua = agent.toLowerCase();
  const specific = groups.find((g) => g.agents.some((a) => a !== '*' && ua.includes(a)));
  const wildcard = groups.find((g) => g.agents.includes('*'));
  const group = specific || wildcard;
  return { rules: group?.rules || [], crawlDelayMs: group?.crawlDelay ?? null };
}

/** La regla más larga gana; con la misma longitud, Allow gana sobre Disallow. */
export function robotsAllows(rules, pathname) {
  let best = null;
  for (const rule of rules) {
    if (rule.path === '') continue;
    const pattern = rule.path;
    const matches = pattern.endsWith('$')
      ? pathname === pattern.slice(0, -1)
      : pathname.startsWith(pattern.replace(/\*.*$/, ''));
    if (!matches) continue;
    if (!best || pattern.length > best.path.length
      || (pattern.length === best.path.length && rule.type === 'allow')) {
      best = rule;
    }
  }
  if (!best) return true;
  return best.type === 'allow';
}

async function loadRobots(origin) {
  const host = hostOf(origin);
  const cached = robotsCache.get(host);
  if (cached && Date.now() - cached.fetchedAt < ROBOTS_TTL_MS) return cached;

  let parsed = { rules: [], crawlDelayMs: null };
  try {
    await politeDelay(host);
    const res = await rawFetch(new URL('/robots.txt', origin).toString(), { timeoutMs: 8000 });
    // 404 significa "sin restricciones"; un 5xx no nos autoriza a asumirlo, pero
    // tampoco debe bloquear la prospección de un sitio que quizá sí permite.
    if (res.ok) parsed = parseRobots(await res.text(), 'caliclean');
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
  if (!robotsAllows(robots.rules, parsed.pathname)) {
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

/**
 * Descarga un fichero de datos como texto (CSV). Mismo ritmo que apiFetch, pero
 * sin exigir JSON y con un tope de tamaño: el listado de negocios de San Diego
 * son decenas de megas y no hay motivo para quedarse sin memoria por una fuente
 * que un día crezca de más.
 */
export async function apiFetchText(url, { maxBytes = 64 * 1024 * 1024, ...opts } = {}) {
  const host = hostOf(url);
  if (host) await politeDelay(host);
  const res = await rawFetch(url, { timeoutMs: 120_000, ...opts });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} en ${host}`);
    err.status = res.status;
    throw err;
  }
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared && declared > maxBytes) {
    throw new Error(`Fichero demasiado grande en ${host}: ${declared} bytes`);
  }
  const text = await res.text();
  return text.length > maxBytes ? text.slice(0, maxBytes) : text;
}

export function _resetCachesForTests() {
  lastHit.clear();
  robotsCache.clear();
}
