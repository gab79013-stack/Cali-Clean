import { config } from '../config.js';
import { db, logEvent } from '../db.js';
import { sendTemplate } from './mailer.js';
import { canSendOutbound, recordOutbound } from '../prospecting/guards.js';

const HOUR = 60;
const DAY = 24 * 60;

/**
 * Secuencias de nurture. Los minutos son el retraso desde la creación del lead.
 * Residencial: presupuesto → recordatorio → prueba social → oferta → valor → cierre.
 * Comercial: propuesta con números y manejo de objeciones; ciclo de decisión más largo.
 */
export const SEQUENCES = {
  residential: [
    { step: 'quote', template: 'quote', delay: 0 },
    { step: 'followup_2h', template: 'followup_2h', delay: 2 * HOUR },
    { step: 'followup_d1', template: 'followup_d1', delay: 1 * DAY },
    { step: 'followup_d3', template: 'followup_d3', delay: 3 * DAY },
    { step: 'followup_d7', template: 'followup_d7', delay: 7 * DAY },
    { step: 'followup_d14', template: 'followup_d14', delay: 14 * DAY },
    { step: 'reactivation', template: 'reactivation', delay: 45 * DAY },
  ],
  commercial: [
    { step: 'quote', template: 'quote', delay: 0 },
    { step: 'commercial_d1', template: 'commercial_d1', delay: 20 * HOUR },
    { step: 'commercial_d4', template: 'commercial_d4', delay: 4 * DAY },
    { step: 'followup_d7', template: 'followup_d7', delay: 8 * DAY },
    { step: 'followup_d14', template: 'followup_d14', delay: 15 * DAY },
    { step: 'reactivation', template: 'reactivation', delay: 45 * DAY },
  ],
  // Prospección en frío: cuatro toques y se acabó. Insistir más en alguien que
  // nunca pidió nada es lo que convierte una campaña en una denuncia de spam.
  outbound: [
    { step: 'outbound_intro', template: 'outbound_intro', delay: 0 },
    { step: 'outbound_bump', template: 'outbound_bump', delay: 4 * DAY },
    { step: 'outbound_proof', template: 'outbound_proof', delay: 9 * DAY },
    { step: 'outbound_close', template: 'outbound_close', delay: 16 * DAY },
  ],
};

/** Estados en los que el lead deja de recibir automatizaciones. */
const STOPPED = new Set(['won', 'lost', 'booked', 'customer', 'spam']);

export function enrollLead(lead, sequenceName) {
  const sequence = sequenceName
    || (lead.contact_channel === 'outbound' ? 'outbound'
      : lead.segment === 'commercial' ? 'commercial' : 'residential');
  const steps = SEQUENCES[sequence];
  if (!steps) throw new Error(`Secuencia desconocida: ${sequence}`);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO sequence_steps (lead_id, sequence, step, scheduled_at, status)
     VALUES (?, ?, ?, datetime('now', ?), 'pending')`
  );
  const tx = db.transaction(() => {
    for (const s of steps) insert.run(lead.id, sequence, s.step, `+${s.delay} minutes`);
  });
  tx();
  logEvent(lead.id, 'sequence_enrolled', { sequence, steps: steps.length });
  return sequence;
}

export function cancelSequences(leadId, reason = 'manual') {
  const res = db.prepare(
    "UPDATE sequence_steps SET status='cancelled', error=? WHERE lead_id=? AND status='pending'"
  ).run(reason, leadId);
  if (res.changes) logEvent(leadId, 'sequence_cancelled', { reason, cancelled: res.changes });
  return res.changes;
}

/** ¿Estamos dentro de la franja horaria de envío del negocio? */
export function withinSendWindow(date = new Date()) {
  const hour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: config.business.tz, hour: 'numeric', hour12: false,
  }).format(date));
  const { sendFrom, sendTo } = config.sequences;
  return hour >= sendFrom && hour < sendTo;
}

const templateFor = (sequence, step) =>
  SEQUENCES[sequence]?.find((s) => s.step === step)?.template || step;

/**
 * Procesa los pasos vencidos. El paso `quote` se envía siempre de inmediato;
 * el resto espera a la franja horaria para no aterrizar a las 3 de la mañana.
 */
export async function processDueSteps({ limit = 50, now = new Date() } = {}) {
  const open = withinSendWindow(now);
  const due = db.prepare(
    `SELECT s.*, l.uid, l.email, l.status AS lead_status, l.unsubscribed
       FROM sequence_steps s JOIN leads l ON l.id = s.lead_id
      WHERE s.status = 'pending' AND s.scheduled_at <= datetime('now')
      ORDER BY s.scheduled_at LIMIT ?`
  ).all(limit);

  const result = { sent: 0, skipped: 0, failed: 0, deferred: 0 };

  for (const row of due) {
    if (row.unsubscribed || STOPPED.has(row.lead_status)) {
      db.prepare("UPDATE sequence_steps SET status='cancelled', error=? WHERE id=?")
        .run(row.unsubscribed ? 'unsubscribed' : `lead_status:${row.lead_status}`, row.id);
      result.skipped++;
      continue;
    }
    if (!open && row.step !== 'quote') { result.deferred++; continue; }

    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(row.lead_id);
    const quote = lead.quote_json ? JSON.parse(lead.quote_json) : null;

    // Los correos en frío se revisan contra las salvaguardas justo antes de
    // salir: entre programar y enviar pasan días y todo puede haber cambiado.
    let prospect = null;
    if (row.sequence === 'outbound') {
      const check = await canSendOutbound(lead.email, { now });
      if (!check.allowed) {
        if (check.reason === 'daily_limit_reached' || check.reason === 'outbound_disabled') {
          // Cupo agotado o interruptor apagado: se reintenta, no se descarta.
          db.prepare("UPDATE sequence_steps SET scheduled_at=datetime('now','+6 hours'), error=? WHERE id=?")
            .run(`deferred:${check.reason}`, row.id);
          result.deferred++;
        } else {
          db.prepare("UPDATE sequence_steps SET status='cancelled', error=? WHERE id=?")
            .run(check.reason, row.id);
          cancelSequences(lead.id, check.reason);
          result.skipped++;
        }
        continue;
      }
      prospect = lead.prospect_uid
        ? db.prepare('SELECT * FROM prospects WHERE uid = ?').get(lead.prospect_uid)
        : null;
    }

    const copy = prospect?.copy_json ? JSON.parse(prospect.copy_json) : null;
    const res = await sendTemplate({ template: templateFor(row.sequence, row.step), lead, quote, copy });

    if (res.ok && row.sequence === 'outbound') {
      recordOutbound({ email: lead.email, prospectId: prospect?.id || null, leadId: lead.id, step: row.step, now });
    }

    if (res.ok) {
      db.prepare("UPDATE sequence_steps SET status='sent', sent_at=datetime('now') WHERE id=?").run(row.id);
      logEvent(lead.id, 'email_sent', { step: row.step, subject: res.subject });
      result.sent++;
    } else {
      // Reintento único 30 minutos después; al segundo fallo se marca failed.
      const retried = row.error?.startsWith('retry:');
      if (retried) {
        db.prepare("UPDATE sequence_steps SET status='failed', error=? WHERE id=?").run(res.error, row.id);
        result.failed++;
      } else {
        db.prepare("UPDATE sequence_steps SET scheduled_at=datetime('now','+30 minutes'), error=? WHERE id=?")
          .run(`retry:${res.error}`, row.id);
        result.deferred++;
      }
    }
  }
  return result;
}

export default { enrollLead, cancelSequences, processDueSteps, withinSendWindow, SEQUENCES };
