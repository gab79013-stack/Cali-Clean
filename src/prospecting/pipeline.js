import { db } from '../db.js';
import { discover } from './agents/discover.js';
import { enrich } from './agents/enrich.js';
import { qualify } from './agents/qualify.js';
import { outreach } from './agents/outreach.js';
import { syncPending } from '../services/crm.js';

/**
 * Orquestador del pipeline de agentes.
 *
 * descubrir → enriquecer → cualificar → contactar → sincronizar con el CRM
 *
 * Cada etapa es independiente y deja su resultado en la base, así que una
 * corrida interrumpida a la mitad se retoma sola en la siguiente: los
 * prospectos siguen en la etapa donde se quedaron.
 */

const STAGES = {
  discover: (opts) => discover(opts),
  enrich: (opts) => enrich(opts),
  qualify: (opts) => qualify(opts),
  outreach: (opts) => outreach(opts),
  crm: (opts) => syncPending(opts),
};

function startRun(agent) {
  return db.prepare("INSERT INTO agent_runs (agent, status) VALUES (?, 'running')").run(agent).lastInsertRowid;
}

function finishRun(id, status, stats, error = null) {
  db.prepare(
    "UPDATE agent_runs SET finished_at=datetime('now'), status=?, stats_json=?, error=? WHERE id=?"
  ).run(status, JSON.stringify(stats || {}), error, id);
}

/** Ejecuta una sola etapa, con su registro de corrida. */
export async function runStage(stage, opts = {}) {
  const fn = STAGES[stage];
  if (!fn) throw new Error(`Etapa desconocida: ${stage}`);
  const runId = startRun(stage);
  try {
    const stats = await fn(opts);
    finishRun(runId, 'ok', stats);
    return stats;
  } catch (err) {
    finishRun(runId, 'error', null, String(err.message).slice(0, 500));
    throw err;
  }
}

/**
 * Corrida completa. `stages` permite ejecutar solo una parte, útil para probar
 * la prospección sin que salga ningún correo.
 */
export async function runPipeline({ stages = ['discover', 'enrich', 'qualify', 'outreach', 'crm'], ...opts } = {}) {
  const results = {};
  for (const stage of stages) {
    try {
      results[stage] = await runStage(stage, opts[stage] || {});
    } catch (err) {
      results[stage] = { error: String(err.message) };
      // Una fuente caída no debe impedir que se contacte a quien ya está listo.
    }
  }
  return results;
}

/** Foto del embudo de prospección para el panel. */
export function funnelStats() {
  const byStage = db.prepare('SELECT stage, COUNT(*) AS n FROM prospects GROUP BY stage').all();
  const rejects = db.prepare(`
    SELECT COALESCE(substr(reject_reason, 1, instr(reject_reason || ':', ':') - 1), reject_reason) AS reason,
           COUNT(*) AS n
      FROM prospects WHERE stage = 'rejected' GROUP BY reason ORDER BY n DESC LIMIT 12`).all();
  const bySegment = db.prepare(`
    SELECT segment, COUNT(*) AS n, COALESCE(SUM(est_annual_value), 0) AS annual
      FROM prospects WHERE stage IN ('qualified','contacted') GROUP BY segment ORDER BY n DESC`).all();
  const bySource = db.prepare(`
    SELECT source, COUNT(*) AS n, SUM(stage = 'contacted') AS contacted
      FROM prospects GROUP BY source ORDER BY n DESC`).all();
  const runs = db.prepare('SELECT * FROM agent_runs ORDER BY started_at DESC LIMIT 12').all();

  return { byStage, rejects, bySegment, bySource, runs };
}

export default runPipeline;
