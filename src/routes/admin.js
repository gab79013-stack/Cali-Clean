import crypto from 'node:crypto';
import express from 'express';
import { config } from '../config.js';
import { db, logEvent } from '../db.js';
import { cancelSequences, processDueSteps } from '../services/sequences.js';
import { verifyConnection } from '../services/mailer.js';
import senderApi from '../services/sender-api.js';
import { clean } from '../utils/validate.js';

export const router = express.Router();

const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

/** Basic Auth para todo /admin y /api/admin. */
export function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Basic ')) {
    const [user, pass] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
    if (safeEqual(user || '', config.admin.user) && safeEqual(pass || '', config.admin.pass)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Cali Clean Leads"').status(401).send('Auth required');
}

const STATUSES = ['new', 'engaged', 'contacted', 'quoted', 'booked', 'won', 'lost', 'spam'];

router.get('/leads', (req, res) => {
  const { status, temperature, segment, q, limit = 100, offset = 0 } = req.query;
  const where = [];
  const params = {};
  if (status && STATUSES.includes(status)) { where.push('status = @status'); params.status = status; }
  if (temperature) { where.push('temperature = @temperature'); params.temperature = temperature; }
  if (segment) { where.push('segment = @segment'); params.segment = segment; }
  if (q) { where.push('(name LIKE @q OR email LIKE @q OR phone LIKE @q OR zip LIKE @q)'); params.q = `%${clean(q, 60)}%`; }
  params.limit = Math.min(500, Number(limit) || 100);
  params.offset = Number(offset) || 0;

  const sql = `SELECT * FROM leads ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY score DESC, created_at DESC LIMIT @limit OFFSET @offset`;
  const leads = db.prepare(sql).all(params).map(hydrate);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM leads ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`).get(params).n;
  res.json({ ok: true, total, leads });
});

router.get('/leads/:uid', (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE uid = ?').get(req.params.uid);
  if (!lead) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({
    ok: true,
    lead: hydrate(lead),
    emails: db.prepare('SELECT * FROM emails WHERE lead_id = ? ORDER BY created_at DESC').all(lead.id),
    steps: db.prepare('SELECT * FROM sequence_steps WHERE lead_id = ? ORDER BY scheduled_at').all(lead.id),
    events: db.prepare('SELECT * FROM events WHERE lead_id = ? ORDER BY created_at DESC LIMIT 50').all(lead.id),
  });
});

router.patch('/leads/:uid', (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE uid = ?').get(req.params.uid);
  if (!lead) return res.status(404).json({ ok: false, error: 'not_found' });

  const { status, notes, owner } = req.body || {};
  if (status && !STATUSES.includes(status)) return res.status(400).json({ ok: false, error: 'invalid_status' });

  db.prepare(
    `UPDATE leads SET status = COALESCE(?, status), notes = COALESCE(?, notes),
            owner = COALESCE(?, owner), updated_at = datetime('now') WHERE id = ?`
  ).run(status || null, notes !== undefined ? clean(notes, 4000) : null, owner ? clean(owner, 80) : null, lead.id);

  if (status) {
    logEvent(lead.id, 'status_changed', { from: lead.status, to: status });
    // Cerrar el lead apaga la automatización: nadie quiere recibir la oferta
    // de bienvenida después de haber contratado.
    if (['won', 'lost', 'booked', 'spam'].includes(status)) cancelSequences(lead.id, `status:${status}`);
  }
  res.json({ ok: true, lead: hydrate(db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id)) });
});

/** Métricas del embudo: lo que se mira cada mañana. */
router.get('/stats', (req, res) => {
  const days = Math.min(365, Number(req.query.days) || 30);
  const since = `-${days} days`;
  const one = (sql, ...p) => db.prepare(sql).get(...p);

  const totals = one(
    `SELECT COUNT(*) AS leads, COALESCE(SUM(quote_price),0) AS pipeline,
            COALESCE(SUM(annual_value),0) AS annual_pipeline, COALESCE(AVG(score),0) AS avg_score
       FROM leads WHERE created_at >= datetime('now', ?)`, since);
  const won = one(
    `SELECT COUNT(*) AS n, COALESCE(SUM(quote_price),0) AS revenue
       FROM leads WHERE status='won' AND created_at >= datetime('now', ?)`, since);
  const emails = one(
    `SELECT COUNT(*) AS sent, SUM(opened_at IS NOT NULL) AS opened, SUM(clicked_at IS NOT NULL) AS clicked
       FROM emails WHERE status='sent' AND created_at >= datetime('now', ?)`, since);

  res.json({
    ok: true,
    days,
    totals: { ...totals, avg_score: Math.round(totals.avg_score) },
    won,
    emails,
    conversion: totals.leads ? Math.round((won.n / totals.leads) * 1000) / 10 : 0,
    byStatus: db.prepare(
      `SELECT status, COUNT(*) AS n FROM leads WHERE created_at >= datetime('now', ?) GROUP BY status`).all(since),
    byTemperature: db.prepare(
      `SELECT temperature, COUNT(*) AS n FROM leads WHERE created_at >= datetime('now', ?) GROUP BY temperature`).all(since),
    bySource: db.prepare(
      `SELECT COALESCE(NULLIF(utm_source,''),'direct') AS source, COUNT(*) AS n,
              COALESCE(SUM(quote_price),0) AS pipeline
         FROM leads WHERE created_at >= datetime('now', ?) GROUP BY source ORDER BY n DESC LIMIT 12`).all(since),
    byService: db.prepare(
      `SELECT segment, service_type, COUNT(*) AS n FROM leads
        WHERE created_at >= datetime('now', ?) GROUP BY segment, service_type ORDER BY n DESC`).all(since),
    daily: db.prepare(
      `SELECT date(created_at) AS day, COUNT(*) AS n FROM leads
        WHERE created_at >= datetime('now', ?) GROUP BY day ORDER BY day`).all(since),
  });
});

router.get('/export.csv', (req, res) => {
  const rows = db.prepare('SELECT * FROM leads ORDER BY created_at DESC').all();
  const cols = ['created_at', 'name', 'email', 'phone', 'zip', 'segment', 'service_type', 'frequency',
    'quote_price', 'annual_value', 'score', 'temperature', 'status', 'utm_source', 'utm_campaign', 'preferred_date', 'message'];
  const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => escape(r[c])).join(','))].join('\n');
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="cali-clean-leads.csv"' })
    .send(`﻿${csv}`);
});

/** Diagnóstico: valida SMTP/API sin tener que leer logs. */
router.get('/health', async (req, res) => {
  const out = { driver: config.mail.driver, sender_api: senderApi.ready() };
  try { await verifyConnection(); out.mail = 'ok'; }
  catch (err) { out.mail = 'error'; out.mail_error = err.message; }
  out.pending_steps = db.prepare("SELECT COUNT(*) AS n FROM sequence_steps WHERE status='pending'").get().n;
  out.failed_emails = db.prepare("SELECT COUNT(*) AS n FROM emails WHERE status='failed'").get().n;
  res.json(out);
});

/** Empuja manualmente la cola de secuencias (útil para probar sin esperar al cron). */
router.post('/run-sequences', async (req, res) => {
  res.json({ ok: true, result: await processDueSteps({ limit: 100 }) });
});

function hydrate(lead) {
  return {
    ...lead,
    addons: safeParse(lead.addons, []),
    quote: safeParse(lead.quote_json, null),
    score_reasons: safeParse(lead.score_reasons, []),
  };
}
const safeParse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };

export default router;
