import express from 'express';
import { db, logEvent } from '../db.js';
import { config } from '../config.js';
import { verify } from '../utils/tokens.js';
import { cancelSequences } from '../services/sequences.js';

export const router = express.Router();

const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

const leadFromToken = (token) => {
  const payload = verify(token);
  if (!payload?.uid) return null;
  return db.prepare('SELECT * FROM leads WHERE uid = ?').get(payload.uid) || null;
};

/** Píxel de apertura. Siempre devuelve imagen, aunque el token no sea válido. */
router.get('/px.gif', (req, res) => {
  const lead = leadFromToken(req.query.t);
  if (lead) {
    const template = String(req.query.e || '');
    db.prepare(
      `UPDATE emails SET opened_at = COALESCE(opened_at, datetime('now'))
        WHERE lead_id = ? AND template = ? AND opened_at IS NULL`
    ).run(lead.id, template);
    logEvent(lead.id, 'email_opened', { template });
  }
  res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, max-age=0' }).send(PIXEL);
});

/** Redirección con tracking de clic: marca el lead como interesado. */
router.get('/r', (req, res) => {
  const lead = leadFromToken(req.query.t);
  const target = config.business.bookingUrl;
  if (lead) {
    const template = String(req.query.e || '');
    db.prepare(
      `UPDATE emails SET clicked_at = COALESCE(clicked_at, datetime('now'))
        WHERE lead_id = ? AND template = ? AND clicked_at IS NULL`
    ).run(lead.id, template);
    logEvent(lead.id, 'email_clicked', { template });
    // Un clic en el CTA es la señal de intención más fuerte del embudo.
    if (lead.status === 'new') {
      db.prepare("UPDATE leads SET status='engaged', updated_at=datetime('now') WHERE id=?").run(lead.id);
    }
  }
  // Una BOOKING_URL mal configurada no debe romper el clic del lead.
  let destination = target;
  try {
    const url = new URL(target);
    if (lead) url.searchParams.set('lead', lead.uid);
    destination = url.toString();
  } catch {
    destination = config.business.site;
  }
  res.redirect(302, destination);
});

router.get('/unsubscribe', (req, res) => {
  const lead = leadFromToken(req.query.t);
  const es = (lead?.locale || 'en') === 'es';
  if (lead) {
    db.prepare("UPDATE leads SET unsubscribed=1, updated_at=datetime('now') WHERE id=?").run(lead.id);
    cancelSequences(lead.id, 'unsubscribed');
    logEvent(lead.id, 'unsubscribed');
  }
  res.set('Content-Type', 'text/html; charset=utf-8').send(`<!doctype html>
<html lang="${es ? 'es' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${es ? 'Baja confirmada' : 'Unsubscribed'}</title></head>
<body style="font-family:system-ui,sans-serif;background:#f4f6f8;margin:0;padding:60px 20px;text-align:center;color:#334155;">
<div style="max-width:440px;margin:0 auto;background:#fff;border-radius:14px;padding:38px 28px;">
<h1 style="color:#0f172a;font-size:21px;margin:0 0 12px;">${lead ? (es ? 'Listo, te dimos de baja' : "You're unsubscribed") : (es ? 'Enlace no válido' : 'Invalid link')}</h1>
<p style="margin:0 0 20px;line-height:1.6;">${lead
  ? (es ? 'No volverás a recibir correos automáticos nuestros. Si fue un error, escríbenos y lo revertimos.' : "You won't get automated emails from us again. If this was a mistake, just reply to any email.")
  : (es ? 'No pudimos identificar tu suscripción.' : 'We could not identify your subscription.')}</p>
<a href="${config.business.site}" style="color:#0f766e;">${config.business.name}</a>
</div></body></html>`);
});

/** POST de List-Unsubscribe one-click (RFC 8058). */
router.post('/unsubscribe', (req, res) => {
  const lead = leadFromToken(req.query.t);
  if (lead) {
    db.prepare("UPDATE leads SET unsubscribed=1, updated_at=datetime('now') WHERE id=?").run(lead.id);
    cancelSequences(lead.id, 'unsubscribed');
    logEvent(lead.id, 'unsubscribed_one_click');
  }
  res.status(200).end();
});

export default router;
