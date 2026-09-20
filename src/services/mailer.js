import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { db } from '../db.js';
import { renderTemplate } from '../templates/emails.js';
import { sign } from '../utils/tokens.js';
import senderApi from './sender-api.js';

let transporter = null;
function smtp() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.mail.smtp.host,
      port: config.mail.smtp.port,
      secure: config.mail.smtp.secure,
      auth: config.mail.smtp.user ? { user: config.mail.smtp.user, pass: config.mail.smtp.pass } : undefined,
      pool: true,
      maxConnections: 3,
    });
  }
  return transporter;
}

/** Enlaces personalizados del lead: reserva con tracking, baja, píxel de apertura. */
export function linksFor(lead, template) {
  const token = lead?.uid ? sign({ uid: lead.uid }) : '';
  const base = config.appUrl;
  const booking = lead?.uid
    ? `${base}/r?t=${encodeURIComponent(token)}&e=${encodeURIComponent(template || '')}`
    : config.business.bookingUrl;
  return {
    booking,
    unsubscribe: lead?.uid ? `${base}/unsubscribe?t=${encodeURIComponent(token)}` : '',
    pixel: lead?.uid ? `${base}/px.gif?t=${encodeURIComponent(token)}&e=${encodeURIComponent(template || '')}` : '',
    admin: `${base}/admin/#lead-${lead?.id || ''}`,
  };
}

/**
 * Envía una plantilla. Nunca lanza: registra el fallo en la tabla emails para
 * que un problema de SMTP no tumbe la captura del lead.
 */
export async function sendTemplate({ template, lead, quote, to, locale }) {
  const recipient = to || lead?.email;
  const links = linksFor(lead, template);
  const rendered = renderTemplate(template, { lead, quote, links, locale: locale || lead?.locale });
  const from = `"${config.mail.fromName}" <${config.mail.fromEmail}>`;

  const row = db.prepare(
    'INSERT INTO emails (lead_id, template, to_email, subject, driver, status) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(lead?.id || null, template, recipient, rendered.subject, config.mail.driver, 'pending');
  const emailId = row.lastInsertRowid;

  try {
    let messageId = null;
    if (config.mail.driver === 'smtp') {
      const info = await smtp().sendMail({
        from, to: recipient, replyTo: config.mail.replyTo || undefined,
        subject: rendered.subject, html: rendered.html, text: rendered.text,
        headers: links.unsubscribe
          ? { 'List-Unsubscribe': `<${links.unsubscribe}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
          : undefined,
      });
      messageId = info?.messageId || null;
    } else if (config.mail.driver === 'api') {
      const res = await senderApi.sendTransactional({
        to: recipient, subject: rendered.subject, html: rendered.html, text: rendered.text,
        fromEmail: config.mail.fromEmail, fromName: config.mail.fromName, replyTo: config.mail.replyTo,
      });
      messageId = res?.id || res?.data?.id || null;
    } else {
      console.log(`[mail:log] → ${recipient} · ${template} · ${rendered.subject}`);
    }

    db.prepare("UPDATE emails SET status='sent', message_id=? WHERE id=?").run(messageId, emailId);
    return { ok: true, emailId, subject: rendered.subject };
  } catch (err) {
    db.prepare("UPDATE emails SET status='failed', error=? WHERE id=?").run(String(err.message).slice(0, 500), emailId);
    console.error(`[mail:error] ${template} → ${recipient}: ${err.message}`);
    return { ok: false, emailId, error: err.message };
  }
}

/** Aviso interno al equipo, uno por destinatario configurado. */
export async function notifyTeam({ lead, quote }) {
  const results = [];
  for (const to of config.mail.notifyTo) {
    results.push(await sendTemplate({ template: 'internal_new_lead', lead, quote, to, locale: 'es' }));
  }
  return results;
}

export async function verifyConnection() {
  if (config.mail.driver === 'smtp') return smtp().verify();
  if (config.mail.driver === 'api') return senderApi.listGroups().then(() => true);
  return true;
}

export default { sendTemplate, notifyTeam, verifyConnection, linksFor };
