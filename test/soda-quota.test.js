import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Control de caudal: reintentos ante 429 y cuota persistente.
 *
 * Todos los tiempos son inyectados. Una prueba que de verdad esperase 30
 * segundos nadie la ejecutaría, y una que no comprueba los tiempos no sirve
 * para nada.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-quota-'));
process.env.SOURCE_RUNTIME_STATE_PATH = path.join(tmpDir, 'state.json');
process.env.DB_PATH = ':memory:';
process.env.APP_SECRET = 'test-quota';

const {
  sodaGet, parseRetryAfter, computeBackoff, SodaError, DEFAULTS,
} = await import('../src/prospecting/sources/soda-client.js');
const quota = await import('../src/prospecting/sources/quota.js');

test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

/** Respuesta simulada con la interfaz mínima que usa el cliente. */
const respuesta = (status, { body = '[]', headers = {} } = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (h) => headers[h.toLowerCase()] ?? null },
  json: async () => JSON.parse(body),
  text: async () => body,
});

// ── Retry-After ──────────────────────────────────────────────
test('Retry-After en segundos', () => {
  assert.equal(parseRetryAfter('120'), 120000);
  assert.equal(parseRetryAfter('0'), 0);
  assert.equal(parseRetryAfter('1.5'), 1500);
  assert.equal(parseRetryAfter('  30  '), 30000);
});

test('Retry-After como fecha HTTP', () => {
  const ahora = Date.parse('2026-10-04T05:00:00Z');
  assert.equal(parseRetryAfter('Sun, 04 Oct 2026 05:02:00 GMT', ahora), 120000);
  // Una fecha pasada significa "ya puedes", no una espera negativa.
  assert.equal(parseRetryAfter('Sun, 04 Oct 2026 04:00:00 GMT', ahora), 0);
});

test('Retry-After ilegible se ignora en vez de romper', () => {
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter(''), null);
  assert.equal(parseRetryAfter('pronto'), null);
  assert.equal(parseRetryAfter('-5'), null);
});

// ── Backoff ──────────────────────────────────────────────────
test('el backoff duplica y respeta el tope', () => {
  // random=1 devuelve el valor nominal completo.
  const r = () => 0.999999;
  assert.ok(computeBackoff(1, { random: r }) >= 999);
  assert.ok(computeBackoff(2, { random: r }) >= 1999);
  assert.ok(computeBackoff(3, { random: r }) >= 3999);
  // Con exponentes altos el tope de 30 s manda.
  assert.ok(computeBackoff(10, { random: r }) <= DEFAULTS.capMs);
  assert.ok(computeBackoff(20, { random: r }) <= DEFAULTS.capMs);
});

test('el jitter reparte dentro de la ventana, nunca por encima', () => {
  for (const valor of [0, 0.25, 0.5, 0.75, 0.999]) {
    const espera = computeBackoff(3, { random: () => valor });
    assert.ok(espera >= 0 && espera <= 4000, `fuera de rango: ${espera}`);
  }
  assert.equal(computeBackoff(3, { random: () => 0 }), 0, 'jitter completo puede dar cero');
});

// ── 429 ──────────────────────────────────────────────────────
test('un 429 con Retry-After se obedece al pie de la letra', async () => {
  const esperas = [];
  let llamadas = 0;
  const fetchImpl = async () => {
    llamadas++;
    if (llamadas === 1) return respuesta(429, { headers: { 'retry-after': '7' } });
    return respuesta(200, { body: '[{"record_id":"A"}]' });
  };

  const { rows, metrics } = await sodaGet('https://ejemplo/resource/x.json', {
    fetchImpl,
    sleep: async (ms) => esperas.push(ms),
    random: () => 0.5,
  });

  assert.equal(rows.length, 1);
  assert.equal(metrics.http429, 1);
  assert.equal(metrics.retries, 1);
  assert.deepEqual(esperas, [7000], 'si el servidor dice 7s, se esperan 7s');
});

test('sin Retry-After se usa el backoff con jitter', async () => {
  const esperas = [];
  let llamadas = 0;
  const fetchImpl = async () => {
    llamadas++;
    if (llamadas <= 2) return respuesta(429);
    return respuesta(200, { body: '[]' });
  };

  const { metrics } = await sodaGet('https://ejemplo/resource/x.json', {
    fetchImpl,
    sleep: async (ms) => esperas.push(ms),
    random: () => 0.999999,
  });

  assert.equal(metrics.http429, 2);
  assert.equal(metrics.retries, 2);
  assert.equal(esperas.length, 2);
  assert.ok(esperas[0] >= 999 && esperas[0] <= 1000, `primer intento ~1s, fue ${esperas[0]}`);
  assert.ok(esperas[1] >= 1999 && esperas[1] <= 2000, `segundo ~2s, fue ${esperas[1]}`);
});

test('un Retry-After absurdo se trunca en vez de obedecerse', async () => {
  const esperas = [];
  let llamadas = 0;
  const fetchImpl = async () => {
    llamadas++;
    if (llamadas === 1) return respuesta(429, { headers: { 'retry-after': '86400' } });
    return respuesta(200, { body: '[]' });
  };
  await sodaGet('https://ejemplo/resource/x.json', {
    fetchImpl, sleep: async (ms) => esperas.push(ms), random: () => 0.5,
  });
  assert.equal(esperas[0], DEFAULTS.maxRetryAfterMs, 'un día de espera no se obedece a ciegas');
});

test('cuatro intentos y se abandona con un error que lo explica', async () => {
  let llamadas = 0;
  const esperas = [];
  const fetchImpl = async () => { llamadas++; return respuesta(429, { headers: { 'retry-after': '2' } }); };

  await assert.rejects(
    () => sodaGet('https://ejemplo/resource/x.json', {
      fetchImpl, sleep: async (ms) => esperas.push(ms), random: () => 0.5,
    }),
    (err) => {
      assert.ok(err instanceof SodaError);
      assert.equal(err.status, 429);
      assert.equal(err.attempts, 4);
      assert.match(err.message, /tras 4 intentos/);
      assert.match(err.message, /insistir más solo empeora/);
      return true;
    },
  );

  assert.equal(llamadas, 4, 'cuatro intentos en total, no cuatro reintentos');
  assert.equal(esperas.length, 3, 'tres esperas entre los cuatro intentos');
});

test('un error que no es 429 no se reintenta', async () => {
  let llamadas = 0;
  const fetchImpl = async () => { llamadas++; return respuesta(500, { body: 'boom' }); };
  await assert.rejects(
    () => sodaGet('https://ejemplo/resource/x.json', { fetchImpl, sleep: async () => {} }),
    /SODA HTTP 500/,
  );
  assert.equal(llamadas, 1, 'un 500 no mejora por insistir');
});

// ── Cuota de 24 h ────────────────────────────────────────────
const nuevoEstado = () => {
  const f = path.join(tmpDir, `s-${Math.random().toString(36).slice(2)}.json`);
  return { stateFile: f, lockFile: `${f}.lock` };
};

test('la primera corrida pasa y la segunda queda bloqueada 24 h', async () => {
  const { stateFile, lockFile } = nuevoEstado();
  const t0 = Date.parse('2026-10-04T10:00:00Z');

  const uno = await quota.withQuota('fuente', async () => ({ rows: 5, consumed: true }),
    { now: () => t0, stateFile, lockFile });
  assert.equal(uno.ran, true);
  assert.equal(uno.consumed, true);

  const dos = await quota.withQuota('fuente', async () => ({ rows: 5, consumed: true }),
    { now: () => t0 + 3600000, stateFile, lockFile });
  assert.equal(dos.ran, false);
  assert.equal(dos.blocked, true);
  assert.equal(dos.reason, 'cuota_24h');
  assert.match(dos.detail, /faltan \d+ min/);

  // Justo antes de cumplirse la ventana, sigue bloqueada.
  const casi = await quota.withQuota('fuente', async () => ({ rows: 1, consumed: true }),
    { now: () => t0 + 24 * 3600000 - 1000, stateFile, lockFile });
  assert.equal(casi.blocked, true);

  // Cumplida la ventana, vuelve a pasar.
  const tres = await quota.withQuota('fuente', async () => ({ rows: 1, consumed: true }),
    { now: () => t0 + 24 * 3600000, stateFile, lockFile });
  assert.equal(tres.ran, true);
});

test('la cuota es por fuente, no global', async () => {
  const { stateFile, lockFile } = nuevoEstado();
  const t0 = Date.now();
  await quota.withQuota('a', async () => ({ rows: 1, consumed: true }), { now: () => t0, stateFile, lockFile });
  const otra = await quota.withQuota('b', async () => ({ rows: 1, consumed: true }), { now: () => t0, stateFile, lockFile });
  assert.equal(otra.ran, true, 'una fuente no puede gastar la cuota de otra');
});

test('un fallo no consume cuota', async () => {
  const { stateFile, lockFile } = nuevoEstado();
  const t0 = Date.now();

  await assert.rejects(() => quota.withQuota('fuente', async () => { throw new Error('429 agotado'); },
    { now: () => t0, stateFile, lockFile }));

  // Y el lock quedó liberado pese a la excepción.
  const despues = await quota.withQuota('fuente', async () => ({ rows: 3, consumed: true }),
    { now: () => t0 + 1000, stateFile, lockFile });
  assert.equal(despues.ran, true, 'un fallo no puede castigar 24 h');
  assert.equal(despues.consumed, true);
});

test('una corrida que no llega a consultar tampoco consume', async () => {
  const { stateFile, lockFile } = nuevoEstado();
  const t0 = Date.now();
  const sinConsulta = await quota.withQuota('fuente', async () => ({ rows: 0, consumed: false }),
    { now: () => t0, stateFile, lockFile });
  assert.equal(sinConsulta.consumed, false);

  const siguiente = await quota.withQuota('fuente', async () => ({ rows: 1, consumed: true }),
    { now: () => t0 + 1000, stateFile, lockFile });
  assert.equal(siguiente.ran, true);
});

test('un dry-run que sí consulta consume cuota', async () => {
  const { stateFile, lockFile } = nuevoEstado();
  const t0 = Date.now();
  // Es carga para el portal aunque nosotros no escribamos nada.
  await quota.withQuota('fuente', async () => ({ rows: 3, consumed: true }),
    { now: () => t0, stateFile, lockFile });
  const segunda = await quota.withQuota('fuente', async () => ({ rows: 3, consumed: true }),
    { now: () => t0 + 60000, stateFile, lockFile });
  assert.equal(segunda.blocked, true);
});

test('el tope de filas por corrida llega a la función', async () => {
  const { stateFile, lockFile } = nuevoEstado();
  let visto = null;
  await quota.withQuota('fuente', async ({ maxRows }) => { visto = maxRows; return { rows: 0, consumed: false }; },
    { stateFile, lockFile });
  assert.equal(visto, quota.MAX_ROWS_PER_RUN);
  assert.equal(quota.MAX_ROWS_PER_RUN, 50);
});

// ── Lock ─────────────────────────────────────────────────────
test('un lock ocupado bloquea la ejecución, no la encola', async () => {
  const { stateFile, lockFile } = nuevoEstado();
  const tomado = quota.acquireLock({ file: lockFile });
  assert.equal(tomado.acquired, true);

  try {
    let ejecutado = false;
    const r = await quota.withQuota('fuente', async () => { ejecutado = true; return { rows: 1, consumed: true }; },
      { stateFile, lockFile });
    assert.equal(r.blocked, true);
    assert.equal(r.reason, 'lock_ocupado');
    assert.equal(ejecutado, false, 'no puede ejecutarse con el lock tomado');
  } finally {
    quota.releaseLock({ file: lockFile });
  }
});

test('un lock caducado se rompe dejando constancia', async () => {
  const { stateFile, lockFile } = nuevoEstado();
  const hace20min = Date.now() - 20 * 60 * 1000;
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, at: new Date(hace20min).toISOString() }));
  fs.utimesSync(lockFile, new Date(hace20min), new Date(hace20min));

  const r = await quota.withQuota('fuente', async () => ({ rows: 2, consumed: true }), { stateFile, lockFile });
  assert.equal(r.ran, true, 'un proceso muerto no puede bloquear para siempre');
  assert.equal(r.brokeStaleLock, true, 'romper un lock tiene que quedar anotado');
});

test('el lock se libera aunque la función lance', async () => {
  const { stateFile, lockFile } = nuevoEstado();
  await assert.rejects(() => quota.withQuota('fuente', async () => { throw new Error('fallo'); },
    { stateFile, lockFile }));
  assert.equal(fs.existsSync(lockFile), false, 'el lock quedó huérfano tras una excepción');
});

// ── Escritura crash-safe ─────────────────────────────────────
test('la escritura es atómica: temp, fsync y rename', () => {
  const file = path.join(tmpDir, 'atomic.json');
  quota.writeStateAtomic({ version: 1, sources: { a: { lastSuccessAt: '2026-10-04T00:00:00.000Z' } } }, file);
  const leido = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(leido.sources.a.lastSuccessAt, '2026-10-04T00:00:00.000Z');
  // No queda ningún temporal del proceso.
  const restos = fs.readdirSync(tmpDir).filter((f) => f.includes('.tmp'));
  assert.deepEqual(restos, []);
});

test('un estado corrupto no concede cuota de más ni revienta', () => {
  const file = path.join(tmpDir, 'corrupto.json');
  fs.writeFileSync(file, '{ esto no es json');
  const estado = quota.readState(file);
  assert.equal(estado.version, quota.STATE_VERSION);
  assert.deepEqual(estado.sources, {});
});

test('un estado de versión desconocida detiene todo en vez de interpretarse', () => {
  const file = path.join(tmpDir, 'futuro.json');
  fs.writeFileSync(file, JSON.stringify({ version: 99, sources: {} }));
  assert.throws(() => quota.readState(file), /versión 99/);
});

test('los temporales abandonados se limpian', () => {
  const file = path.join(tmpDir, 'conbasura.json');
  quota.writeStateAtomic({ version: 1, sources: {} }, file);
  const viejo = path.join(tmpDir, `.conbasura.json.123.456.tmp`);
  fs.writeFileSync(viejo, '{}');
  const hace30min = new Date(Date.now() - 30 * 60 * 1000);
  fs.utimesSync(viejo, hace30min, hace30min);

  const limpiados = quota.cleanupStaleTemps(file);
  assert.ok(limpiados >= 1);
  assert.equal(fs.existsSync(viejo), false);
});

test('el estado persistido no contiene secretos', () => {
  const { stateFile } = nuevoEstado();
  quota.recordSuccess('fuente', { rows: 7, file: stateFile });
  const texto = fs.readFileSync(stateFile, 'utf8');
  for (const aguja of ['token', 'secret', 'password', 'authorization', 'apikey', 'api_key']) {
    assert.ok(!texto.toLowerCase().includes(aguja), `el estado contiene "${aguja}"`);
  }
  const estado = JSON.parse(texto);
  assert.deepEqual(Object.keys(estado).sort(), ['sources', 'version']);
  assert.deepEqual(Object.keys(estado.sources.fuente).sort(), ['lastRows', 'lastSuccessAt', 'rowsTotal', 'runs']);
});
