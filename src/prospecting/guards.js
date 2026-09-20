import dns from 'node:dns/promises';
import { config } from '../config.js';
import { db } from '../db.js';

/**
 * Salvaguardas del envío outbound.
 *
 * En modo automático nadie revisa antes de que salga el correo, así que estas
 * comprobaciones son lo único que separa una campaña de una lista negra. Todas
 * se ejecutan inmediatamente antes de enviar, no al programar: entre una cosa y
 * la otra pueden pasar días y alguien puede haberse dado de baja.
 */

const domainOf = (email) => String(email || '').toLowerCase().split('@')[1] || '';

// ── Supresión ────────────────────────────────────────────────
export function suppress(value, { kind = 'email', reason = 'manual' } = {}) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return false;
  db.prepare('INSERT OR IGNORE INTO suppression (kind, value, reason) VALUES (?, ?, ?)')
    .run(kind, v, reason);
  return true;
}

export function isSuppressed(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return { suppressed: true, reason: 'empty_email' };
  const byEmail = db.prepare("SELECT reason FROM suppression WHERE kind='email' AND value=?").get(e);
  if (byEmail) return { suppressed: true, reason: `email_suppressed:${byEmail.reason}` };
  const domain = domainOf(e);
  const byDomain = db.prepare("SELECT reason FROM suppression WHERE kind='domain' AND value=?").get(domain);
  if (byDomain) return { suppressed: true, reason: `domain_suppressed:${byDomain.reason}` };
  return { suppressed: false };
}

/**
 * Quien ya pidió la baja nunca vuelve a entrar por la puerta de atrás.
 * La comparación va en minúsculas por los dos lados: un correo guardado con
 * mayúsculas no puede convertirse en un permiso para volver a escribirle.
 */
export function hasUnsubscribed(email) {
  const row = db.prepare('SELECT 1 FROM leads WHERE LOWER(email) = ? AND unsubscribed = 1 LIMIT 1')
    .get(String(email || '').trim().toLowerCase());
  return Boolean(row);
}

// ── Límite diario y calentamiento ────────────────────────────
/**
 * Un dominio nuevo que manda 200 correos el primer día acaba en spam. El tope
 * sube un escalón por día desde la fecha de arranque hasta el límite configurado.
 */
export function dailyAllowance(now = new Date()) {
  const { dailyLimit, warmupStart, warmupStep, warmupStartDate } = config.outbound;
  if (!warmupStartDate) return dailyLimit;
  const start = new Date(`${warmupStartDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return dailyLimit;
  const days = Math.max(0, Math.floor((now - start) / 86400000));
  return Math.min(dailyLimit, warmupStart + days * warmupStep);
}

export function sentToday(now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  return db.prepare('SELECT COUNT(*) AS n FROM outbound_log WHERE day = ?').get(day).n;
}

export function budgetLeft(now = new Date()) {
  return Math.max(0, dailyAllowance(now) - sentToday(now));
}

// ── Enfriamiento por dominio ─────────────────────────────────
/** Dos correos al mismo dominio en la misma semana es una queja esperando. */
export function domainRecentlyContacted(email) {
  const domain = domainOf(email);
  if (!domain) return false;
  const row = db.prepare(
    `SELECT 1 FROM outbound_log
      WHERE domain = ? AND sent_at >= datetime('now', ?) LIMIT 1`
  ).get(domain, `-${config.outbound.domainCooldownDays} days`);
  return Boolean(row);
}

// ── Validez real del buzón ───────────────────────────────────
const mxCache = new Map();

/** Sin MX no hay buzón: enviar ahí solo genera rebotes que dañan la reputación. */
export async function hasMxRecord(email) {
  const domain = domainOf(email);
  if (!domain) return false;
  if (mxCache.has(domain)) return mxCache.get(domain);
  let ok = false;
  try {
    const records = await dns.resolveMx(domain);
    ok = Array.isArray(records) && records.length > 0;
  } catch {
    ok = false;
  }
  mxCache.set(domain, ok);
  return ok;
}

// ── Verificación completa ────────────────────────────────────
/**
 * Puerta única antes de cada envío outbound. Devuelve { allowed, reason }.
 * Cualquier motivo de rechazo se registra para que el panel lo explique.
 */
export async function canSendOutbound(email, { now = new Date(), checkBudget = true } = {}) {
  if (!config.outbound.enabled) return { allowed: false, reason: 'outbound_disabled' };

  const suppressed = isSuppressed(email);
  if (suppressed.suppressed) return { allowed: false, reason: suppressed.reason };
  if (hasUnsubscribed(email)) return { allowed: false, reason: 'previously_unsubscribed' };
  if (domainRecentlyContacted(email)) return { allowed: false, reason: 'domain_cooldown' };
  if (checkBudget && budgetLeft(now) <= 0) return { allowed: false, reason: 'daily_limit_reached' };
  if (config.outbound.requireMx && !(await hasMxRecord(email))) {
    return { allowed: false, reason: 'no_mx_record' };
  }
  return { allowed: true };
}

export function recordOutbound({ email, prospectId = null, leadId = null, step = null, now = new Date() }) {
  db.prepare(
    `INSERT INTO outbound_log (sent_at, day, prospect_id, lead_id, email, domain, step)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(now.toISOString().replace('T', ' ').slice(0, 19), now.toISOString().slice(0, 10),
    prospectId, leadId, String(email).toLowerCase(), domainOf(email), step);
}

export function _resetMxCacheForTests() { mxCache.clear(); }
