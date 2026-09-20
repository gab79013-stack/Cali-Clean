import crypto from 'node:crypto';
import { config } from '../config.js';
import { db, logEvent } from '../db.js';

/**
 * Conector al CRM.
 *
 * Los agentes alimentan primero la base local —que ya es un CRM funcional con
 * su panel— y desde ahí empujan cada lead al CRM externo. Así, si el CRM está
 * caído o cambia, la prospección no se detiene ni se pierde un solo contacto:
 * los envíos fallidos quedan marcados y se reintentan.
 *
 * `webhook` sirve para cualquier CRM que acepte un POST (incluido n8n, Make o
 * Zapier). `hubspot` y `gohighlevel` están listos para cuando se confirme cuál
 * hay detrás de cali-clean.net.
 */

const TIMEOUT_MS = 12000;

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
    location: { address: lead.address || null, zip: lead.zip || null, in_service_area: Boolean(lead.in_service_area) },
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

async function post(url, body, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch { return { raw: text }; }
  } finally {
    clearTimeout(timer);
  }
}

const drivers = {
  /** Webhook genérico, firmado con HMAC para que el receptor pueda verificarlo. */
  async webhook(payload) {
    if (!config.crm.webhookUrl) throw new Error('CRM_WEBHOOK_URL no configurado');
    const headers = {};
    if (config.crm.webhookSecret) {
      const signature = crypto.createHmac('sha256', config.crm.webhookSecret)
        .update(JSON.stringify(payload)).digest('hex');
      headers['X-CaliClean-Signature'] = `sha256=${signature}`;
    }
    const res = await post(config.crm.webhookUrl, payload, headers);
    return { ref: res?.id || res?.contact_id || null, raw: res };
  },

  async hubspot(payload) {
    if (!config.crm.apiKey) throw new Error('CRM_API_KEY no configurado');
    const base = config.crm.baseUrl || 'https://api.hubapi.com';
    const res = await post(`${base}/crm/v3/objects/contacts`, {
      properties: {
        email: payload.contact.email,
        firstname: (payload.contact.name || '').split(' ')[0] || undefined,
        lastname: (payload.contact.name || '').split(' ').slice(1).join(' ') || undefined,
        phone: payload.contact.phone || undefined,
        company: payload.company || undefined,
        website: payload.contact.website || undefined,
        zip: payload.location.zip || undefined,
        hs_lead_status: payload.status,
        lifecyclestage: 'lead',
      },
    }, { Authorization: `Bearer ${config.crm.apiKey}` });
    return { ref: res?.id || null, raw: res };
  },

  async gohighlevel(payload) {
    if (!config.crm.apiKey) throw new Error('CRM_API_KEY no configurado');
    const base = config.crm.baseUrl || 'https://services.leadconnectorhq.com';
    const res = await post(`${base}/contacts/`, {
      locationId: config.crm.locationId || undefined,
      email: payload.contact.email,
      phone: payload.contact.phone || undefined,
      name: payload.contact.name || payload.company || undefined,
      companyName: payload.company || undefined,
      website: payload.contact.website || undefined,
      postalCode: payload.location.zip || undefined,
      source: payload.attribution.source,
      tags: [payload.channel, payload.service.segment, payload.scoring.temperature].filter(Boolean),
    }, {
      Authorization: `Bearer ${config.crm.apiKey}`,
      Version: '2021-07-28',
    });
    return { ref: res?.contact?.id || res?.id || null, raw: res };
  },
};

export function crmReady() {
  const d = config.crm.driver;
  if (d === 'none' || !drivers[d]) return false;
  if (d === 'webhook') return Boolean(config.crm.webhookUrl);
  return Boolean(config.crm.apiKey);
}

/** Empuja un lead al CRM. Nunca lanza: marca el error y deja el reintento vivo. */
export async function pushLead(lead, prospect = null) {
  if (!crmReady()) return { ok: false, skipped: true, reason: 'crm_not_configured' };

  const payload = toPayload(lead, prospect);
  try {
    const { ref } = await drivers[config.crm.driver](payload);
    if (prospect) {
      db.prepare('UPDATE prospects SET crm_synced=1, crm_ref=?, crm_error=NULL WHERE id=?')
        .run(ref, prospect.id);
    }
    logEvent(lead.id, 'crm_synced', { driver: config.crm.driver, ref });
    return { ok: true, ref };
  } catch (err) {
    const message = String(err.message).slice(0, 300);
    if (prospect) db.prepare('UPDATE prospects SET crm_error=? WHERE id=?').run(message, prospect.id);
    logEvent(lead.id, 'crm_sync_failed', { driver: config.crm.driver, error: message });
    return { ok: false, error: message };
  }
}

/** Reintenta los prospectos contactados que aún no llegaron al CRM. */
export async function syncPending({ limit = 50 } = {}) {
  if (!crmReady()) return { skipped: true, reason: 'crm_not_configured' };

  const rows = db.prepare(`
    SELECT p.*, l.id AS l_id FROM prospects p
      JOIN leads l ON l.id = p.lead_id
     WHERE p.crm_synced = 0 AND p.lead_id IS NOT NULL
     ORDER BY p.updated_at LIMIT ?`).all(limit);

  const stats = { attempted: 0, synced: 0, failed: 0 };
  for (const prospect of rows) {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(prospect.lead_id);
    if (!lead) continue;
    stats.attempted++;
    const res = await pushLead(lead, prospect);
    if (res.ok) stats.synced++; else stats.failed++;
  }
  return stats;
}

export default { pushLead, syncPending, crmReady, toPayload };
