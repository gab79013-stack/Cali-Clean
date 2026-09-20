import { config } from '../config.js';
import { db, logEvent } from '../db.js';
import { adapters, ADAPTER_KEYS } from './crm/adapters.js';
import { detectCrm } from './crm/detect.js';

/**
 * Conector al CRM.
 *
 * Los agentes alimentan primero la base local —que ya es un CRM funcional con
 * su panel— y desde ahí empujan cada lead al CRM externo. Así, si el CRM está
 * caído o cambia, la prospección no se detiene ni se pierde un contacto: los
 * envíos fallidos quedan marcados y se reintentan.
 *
 * Los adaptadores concretos viven en `crm/adapters.js`.
 */

const TIMEOUT_MS = 15000;

/** Cliente HTTP compartido por todos los adaptadores. Se inyecta en las pruebas. */
export const http = {
  async request(url, { method = 'GET', body, headers = {}, form } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const init = { method, headers: { Accept: 'application/json', ...headers }, signal: controller.signal };
      if (form) {
        init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        init.body = new URLSearchParams(form).toString();
      } else if (body !== undefined) {
        if (!init.headers['Content-Type']) init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      const res = await fetch(url, init);
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} en ${new URL(url).host}: ${text.slice(0, 200)}`);
      try { return JSON.parse(text); } catch { return { raw: text }; }
    } finally {
      clearTimeout(timer);
    }
  },
  get(url, headers) { return http.request(url, { method: 'GET', headers }); },
  post(url, body, headers) { return http.request(url, { method: 'POST', body, headers }); },
  form(url, form, headers) { return http.request(url, { method: 'POST', form, headers }); },
};

/** Forma canónica del lead. Es lo que recibe el webhook genérico. */
export function toPayload(lead, prospect = null) {
  const safe = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
  return {
    id: lead.uid,
    created_at: lead.created_at,
    channel: lead.contact_channel || 'inbound',
    company: lead.company || null,
    contact: {
      name: lead.name || null,
      email: lead.email,
      phone: lead.phone || null,
      website: lead.website || null,
      locale: lead.locale,
    },
    location: {
      address: lead.address || null,
      city: lead.city || null,
      zip: lead.zip || null,
      in_service_area: Boolean(lead.in_service_area),
    },
    service: {
      segment: lead.segment,
      type: lead.service_type,
      frequency: lead.frequency,
      addons: safe(lead.addons, []),
      preferred_date: lead.preferred_date || null,
    },
    value: {
      quote: lead.quote_price,
      quote_low: lead.quote_low,
      quote_high: lead.quote_high,
      annual: lead.annual_value,
      currency: 'USD',
    },
    scoring: { score: lead.score, temperature: lead.temperature, reasons: safe(lead.score_reasons, []) },
    attribution: {
      source: lead.source,
      utm_source: lead.utm_source || null,
      utm_medium: lead.utm_medium || null,
      utm_campaign: lead.utm_campaign || null,
      landing_page: lead.landing_page || null,
    },
    status: lead.status,
    message: lead.message || null,
    prospecting: prospect ? {
      prospect_id: prospect.uid,
      source: prospect.source,
      signal: safe(prospect.signal_json, {}),
      icp_score: prospect.icp_score,
      evidence: safe(prospect.evidence_json, {}),
      email_source: prospect.email_source,
    } : null,
  };
}

/** Configuración del adaptador activo, leída del entorno. */
export function adapterConfig() {
  return {
    webhookUrl: config.crm.webhookUrl,
    webhookSecret: config.crm.webhookSecret,
    apiKey: config.crm.apiKey,
    apiSecret: config.crm.apiSecret,
    apiUser: config.crm.apiUser,
    baseUrl: config.crm.baseUrl,
    locationId: config.crm.locationId,
    assignedUserId: config.crm.assignedUserId,
  };
}

/** ¿Está el CRM listo para recibir? Dice también qué le falta. */
export function crmStatus() {
  const driver = config.crm.driver;
  if (driver === 'none') return { ready: false, driver, missing: [], reason: 'sin_configurar' };
  const adapter = adapters[driver];
  if (!adapter) return { ready: false, driver, missing: [], reason: `adaptador_desconocido:${driver}` };

  const cfg = adapterConfig();
  const missing = adapter.needs.filter((k) => !cfg[k]);
  return {
    ready: missing.length === 0,
    driver,
    label: adapter.label,
    missing,
    reason: missing.length ? `faltan_datos:${missing.join(',')}` : null,
  };
}

export const crmReady = () => crmStatus().ready;

/** Empuja un lead al CRM. Nunca lanza: marca el error y deja el reintento vivo. */
export async function pushLead(lead, prospect = null, { client = http } = {}) {
  const status = crmStatus();
  if (!status.ready) return { ok: false, skipped: true, reason: status.reason };

  const payload = toPayload(lead, prospect);
  try {
    const { ref } = await adapters[status.driver].push(payload, adapterConfig(), client);
    if (prospect) {
      db.prepare('UPDATE prospects SET crm_synced=1, crm_ref=?, crm_error=NULL WHERE id=?')
        .run(ref, prospect.id);
    }
    logEvent(lead.id, 'crm_synced', { driver: status.driver, ref });
    return { ok: true, ref };
  } catch (err) {
    const message = String(err.message).slice(0, 300);
    if (prospect) db.prepare('UPDATE prospects SET crm_error=? WHERE id=?').run(message, prospect.id);
    logEvent(lead.id, 'crm_sync_failed', { driver: status.driver, error: message });
    return { ok: false, error: message };
  }
}

/** Reintenta los prospectos contactados que aún no llegaron al CRM. */
export async function syncPending({ limit = 50, client = http } = {}) {
  const status = crmStatus();
  if (!status.ready) return { skipped: true, reason: status.reason };

  const rows = db.prepare(`
    SELECT p.* FROM prospects p
      JOIN leads l ON l.id = p.lead_id
     WHERE p.crm_synced = 0 AND p.lead_id IS NOT NULL
     ORDER BY p.updated_at LIMIT ?`).all(limit);

  const stats = { attempted: 0, synced: 0, failed: 0 };
  for (const prospect of rows) {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(prospect.lead_id);
    if (!lead) continue;
    stats.attempted++;
    const res = await pushLead(lead, prospect, { client });
    if (res.ok) stats.synced++; else stats.failed++;
  }
  return stats;
}

/** Empuja también los leads que entraron por el widget, no solo los prospectos. */
export async function pushInboundLead(lead, opts) {
  return pushLead(lead, null, opts);
}

export { adapters, ADAPTER_KEYS, detectCrm };
export default { pushLead, pushInboundLead, syncPending, crmReady, crmStatus, toPayload, detectCrm };
