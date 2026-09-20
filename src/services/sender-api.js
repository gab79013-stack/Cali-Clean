import { config } from '../config.js';

const TIMEOUT_MS = 12000;

function ready() {
  return Boolean(config.sender.token);
}

async function request(method, path, body) {
  if (!ready()) throw new Error('SENDER_API_TOKEN no configurado');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${config.sender.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.sender.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* respuesta no-JSON */ }
    if (!res.ok) {
      const detail = json?.message || json?.error || text?.slice(0, 300) || res.statusText;
      const err = new Error(`Sender API ${res.status}: ${detail}`);
      err.status = res.status;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/** Grupos de Sender a los que pertenece el lead, según segmento y temperatura. */
function groupsFor(lead) {
  const g = config.sender.groups;
  const ids = [g.all, lead.segment === 'commercial' ? g.commercial : g.residential];
  if (lead.temperature === 'hot') ids.push(g.hot);
  return ids.filter(Boolean);
}

/**
 * Alta o actualización del lead como suscriptor de Sender, con los campos
 * personalizados que permiten segmentar campañas después (presupuesto,
 * frecuencia, valor anual, zip...).
 */
export async function syncSubscriber(lead) {
  if (!ready() || !config.sender.syncSubscribers) return { skipped: true };

  const [firstname, ...rest] = String(lead.name || '').trim().split(/\s+/);
  const payload = {
    email: lead.email,
    firstname: firstname || undefined,
    lastname: rest.join(' ') || undefined,
    groups: groupsFor(lead),
    trigger_automation: true,
    fields: {
      phone: lead.phone || '',
      zip: lead.zip || '',
      segment: lead.segment,
      service_type: lead.service_type || '',
      frequency: lead.frequency || '',
      quote_price: lead.quote_price || 0,
      annual_value: lead.annual_value || 0,
      lead_score: lead.score || 0,
      temperature: lead.temperature || '',
      locale: lead.locale || 'en',
      source: lead.source || '',
      utm_campaign: lead.utm_campaign || '',
    },
  };

  try {
    return await request('POST', '/subscribers', payload);
  } catch (err) {
    // Suscriptor ya existente: se actualiza en lugar de fallar.
    if (err.status === 409 || err.status === 422) {
      const id = encodeURIComponent(lead.email);
      return request('PATCH', `/subscribers/${id}`, payload).catch(() => ({ conflict: true }));
    }
    throw err;
  }
}

export async function listGroups() {
  return request('GET', '/groups');
}

/** Envío transaccional por REST (driver MAIL_DRIVER=api). */
export async function sendTransactional({ to, subject, html, text, fromEmail, fromName, replyTo }) {
  return request('POST', config.sender.transactionalPath, {
    from: { email: fromEmail, name: fromName },
    to: [{ email: to }],
    reply_to: replyTo ? { email: replyTo } : undefined,
    subject,
    html,
    text,
  });
}

export const senderApi = { ready, syncSubscriber, listGroups, sendTransactional, request };
export default senderApi;
