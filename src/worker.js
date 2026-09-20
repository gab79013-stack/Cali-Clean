import { config } from './config.js';
import './db.js';
import { processDueSteps } from './services/sequences.js';
import { cleanupRateLimits } from './utils/ratelimit.js';

const everyMs = Math.max(1, config.sequences.tickMinutes) * 60000;

async function tick() {
  try {
    const result = await processDueSteps({ limit: 60 });
    if (result.sent || result.failed) console.log('[worker]', new Date().toISOString(), result);
    cleanupRateLimits();
  } catch (err) {
    console.error('[worker:error]', err);
  }
}

console.log(`[worker] activo · cada ${config.sequences.tickMinutes} min · ventana ${config.sequences.sendFrom}:00-${config.sequences.sendTo}:00 ${config.business.tz}`);
tick();
setInterval(tick, everyMs);
