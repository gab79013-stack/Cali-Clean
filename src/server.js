import path from 'node:path';
import express from 'express';
import { config, ROOT } from './config.js';
import './db.js';
import leadsRouter from './routes/leads.js';
import trackRouter from './routes/track.js';
import adminRouter, { requireAdmin } from './routes/admin.js';
import prospectingRouter from './routes/prospecting.js';
import { processDueSteps } from './services/sequences.js';
import { cleanupRateLimits } from './utils/ratelimit.js';

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '128kb' }));
app.use(express.urlencoded({ extended: true, limit: '128kb' }));

/** CORS abierto solo a los dominios donde vive el widget. */
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowed = config.security.corsOrigins;
  if (origin && (!allowed.length || allowed.includes(origin))) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
  } else if (!allowed.length) {
    res.set('Access-Control-Allow-Origin', '*');
  }
  res.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.get('/health', (req, res) => res.json({ ok: true, service: 'cali-clean-leadgen', env: config.env }));

app.use('/api', leadsRouter);
app.use('/', trackRouter);
app.use('/api/admin', requireAdmin, adminRouter);
app.use('/api/prospecting', requireAdmin, prospectingRouter);
app.get('/admin', requireAdmin, (req, res) => res.sendFile(path.join(ROOT, 'public', 'admin.html')));
app.get('/admin/', requireAdmin, (req, res) => res.sendFile(path.join(ROOT, 'public', 'admin.html')));
app.get('/prospects', requireAdmin, (req, res) => res.sendFile(path.join(ROOT, 'public', 'prospects.html')));

app.use(express.static(path.join(ROOT, 'public'), { maxAge: config.env === 'production' ? '1h' : 0 }));

app.use((req, res) => res.status(404).json({ ok: false, error: 'not_found' }));
app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json({ ok: false, error: 'server_error' });
});

// Worker integrado: con un solo proceso basta para el volumen de una pyme.
// Para escalar, pon WORKER_DISABLED=1 aquí y lanza `npm run worker` aparte.
if (process.env.WORKER_DISABLED !== '1') {
  const everyMs = Math.max(1, config.sequences.tickMinutes) * 60000;
  setInterval(() => {
    processDueSteps({ limit: 40 }).catch((e) => console.error('[sequences]', e));
    cleanupRateLimits();
  }, everyMs).unref();
}

app.listen(config.port, () => {
  console.log(`\n  ${config.business.name} · Lead Machine`);
  console.log(`  ▸ API        http://localhost:${config.port}/api`);
  console.log(`  ▸ Landing    http://localhost:${config.port}/`);
  console.log(`  ▸ Panel      http://localhost:${config.port}/admin`);
  console.log(`  ▸ Widget     ${config.appUrl}/embed.js`);
  console.log(`  ▸ Email      driver=${config.mail.driver} host=${config.mail.smtp.host}\n`);
});

export default app;
