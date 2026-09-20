import { config } from './config.js';
import './db.js';
import { processDueSteps, withinSendWindow } from './services/sequences.js';
import { runPipeline } from './prospecting/pipeline.js';
import { cleanupRateLimits } from './utils/ratelimit.js';

/**
 * Proceso de fondo.
 *
 * Dos ritmos distintos: la cola de correos se revisa cada pocos minutos, y los
 * agentes de prospección salen a buscar una vez por hora. No tiene sentido
 * consultar los registros públicos cada cinco minutos: se actualizan a diario.
 */

const mailEveryMs = Math.max(1, config.sequences.tickMinutes) * 60000;
const prospectEveryMs = Math.max(15, Number(process.env.PROSPECT_TICK_MINUTES) || 60) * 60000;

async function mailTick() {
  try {
    const result = await processDueSteps({ limit: 60 });
    if (result.sent || result.failed) console.log('[worker:mail]', new Date().toISOString(), result);
    cleanupRateLimits();
  } catch (err) {
    console.error('[worker:mail:error]', err);
  }
}

async function prospectTick() {
  // Fuera de la franja horaria no se contacta a nadie, pero sí se sigue
  // llenando el embudo: descubrir y enriquecer no molesta a ningún humano.
  const stages = withinSendWindow()
    ? ['discover', 'enrich', 'qualify', 'outreach', 'crm']
    : ['discover', 'enrich', 'qualify'];
  try {
    const results = await runPipeline({ stages });
    console.log('[worker:prospect]', new Date().toISOString(), JSON.stringify(results));
  } catch (err) {
    console.error('[worker:prospect:error]', err);
  }
}

console.log(`[worker] correo cada ${config.sequences.tickMinutes} min · prospección cada ${prospectEveryMs / 60000} min`);
console.log(`[worker] franja de envío ${config.sequences.sendFrom}:00-${config.sequences.sendTo}:00 ${config.business.tz}`);
console.log(`[worker] outbound ${config.outbound.enabled ? 'ACTIVO' : 'apagado'} · cupo diario ${config.outbound.dailyLimit}`);

mailTick();
setInterval(mailTick, mailEveryMs);

if (config.outbound.enabled || process.env.PROSPECT_ALWAYS === '1') {
  prospectTick();
  setInterval(prospectTick, prospectEveryMs);
} else {
  console.log('[worker] prospección en pausa: OUTBOUND_ENABLED=false');
}
