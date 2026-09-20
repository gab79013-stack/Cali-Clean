import express from 'express';
import { config } from '../config.js';
import { db } from '../db.js';
import { runPipeline, runStage, funnelStats } from '../prospecting/pipeline.js';
import { SEGMENTS } from '../prospecting/icp.js';
import { SOURCES } from '../prospecting/sources/index.js';
import { budgetLeft, dailyAllowance, sentToday, suppress } from '../prospecting/guards.js';
import { crmReady, syncPending, toPayload } from '../services/crm.js';
import { clean } from '../utils/validate.js';

export const router = express.Router();

const safeParse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
const hydrate = (p) => ({
  ...p,
  signal: safeParse(p.signal_json, {}),
  evidence: safeParse(p.evidence_json, {}),
  copy: safeParse(p.copy_json, null),
  raw_json: undefined,
});

/** Estado de la máquina: lo que hay que mirar antes de tocar nada. */
router.get('/status', (req, res) => {
  res.json({
    outbound: {
      enabled: config.outbound.enabled,
      sentToday: sentToday(),
      allowanceToday: dailyAllowance(),
      budgetLeft: budgetLeft(),
      minIcpScore: config.outbound.minIcpScore,
      requireMx: config.outbound.requireMx,
      domainCooldownDays: config.outbound.domainCooldownDays,
    },
    ai: { enabled: config.ai.enabled && Boolean(config.ai.apiKey), model: config.ai.model },
    crm: { driver: config.crm.driver, ready: crmReady() },
    sources: Object.entries(SOURCES).map(([key, s]) => ({
      key, label: s.label, active: config.prospecting.sources.includes(key),
    })),
    segments: Object.entries(SEGMENTS).map(([key, s]) => ({ key, label: s.label.es })),
    funnel: funnelStats(),
    suppressed: db.prepare('SELECT COUNT(*) AS n FROM suppression').get().n,
  });
});

router.get('/prospects', (req, res) => {
  const { stage, segment, source, q, limit = 100, offset = 0 } = req.query;
  const where = [];
  const params = {};
  if (stage) { where.push('stage = @stage'); params.stage = stage; }
  if (segment) { where.push('segment = @segment'); params.segment = segment; }
  if (source) { where.push('source = @source'); params.source = source; }
  if (q) {
    where.push('(business_name LIKE @q OR email LIKE @q OR website LIKE @q OR zip LIKE @q)');
    params.q = `%${clean(q, 60)}%`;
  }
  params.limit = Math.min(500, Number(limit) || 100);
  params.offset = Number(offset) || 0;

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(
    `SELECT * FROM prospects ${clause} ORDER BY icp_score DESC, created_at DESC LIMIT @limit OFFSET @offset`
  ).all(params);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM prospects ${clause}`).get(params).n;
  res.json({ ok: true, total, prospects: rows.map(hydrate) });
});

router.get('/prospects/:uid', (req, res) => {
  const p = db.prepare('SELECT * FROM prospects WHERE uid = ?').get(req.params.uid);
  if (!p) return res.status(404).json({ ok: false, error: 'not_found' });
  const lead = p.lead_id ? db.prepare('SELECT * FROM leads WHERE id = ?').get(p.lead_id) : null;
  res.json({
    ok: true,
    prospect: { ...hydrate(p), raw: safeParse(p.raw_json, null) },
    lead,
    emails: lead ? db.prepare('SELECT * FROM emails WHERE lead_id = ? ORDER BY created_at DESC').all(lead.id) : [],
    steps: lead ? db.prepare('SELECT * FROM sequence_steps WHERE lead_id = ? ORDER BY scheduled_at').all(lead.id) : [],
    crmPayload: lead ? toPayload(lead, p) : null,
  });
});

/** Lanza el pipeline o una etapa suelta, a mano. */
router.post('/run', async (req, res) => {
  const { stages, ...opts } = req.body || {};
  try {
    const results = await runPipeline({ stages: Array.isArray(stages) && stages.length ? stages : undefined, ...opts });
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message) });
  }
});

router.post('/run/:stage', async (req, res) => {
  try {
    res.json({ ok: true, stats: await runStage(req.params.stage, req.body || {}) });
  } catch (err) {
    res.status(400).json({ ok: false, error: String(err.message) });
  }
});

/** Interruptor general en caliente, sin reiniciar el servicio. */
router.post('/outbound/:action', (req, res) => {
  const { action } = req.params;
  if (!['enable', 'disable'].includes(action)) return res.status(400).json({ ok: false, error: 'invalid_action' });
  config.outbound.enabled = action === 'enable';
  res.json({ ok: true, enabled: config.outbound.enabled });
});

router.get('/suppression', (req, res) => {
  res.json({ ok: true, entries: db.prepare('SELECT * FROM suppression ORDER BY created_at DESC LIMIT 500').all() });
});

router.post('/suppression', (req, res) => {
  const { value, kind = 'email', reason = 'manual' } = req.body || {};
  if (!clean(value)) return res.status(400).json({ ok: false, error: 'value_required' });
  suppress(value, { kind: kind === 'domain' ? 'domain' : 'email', reason: clean(reason, 120) });
  res.status(201).json({ ok: true });
});

router.post('/crm/sync', async (req, res) => {
  res.json({ ok: true, stats: await syncPending({ limit: Number(req.body?.limit) || 50 }) });
});

export default router;
