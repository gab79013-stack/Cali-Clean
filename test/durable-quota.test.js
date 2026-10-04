import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

/**
 * Cuota de 24 h entre contenedores.
 *
 * La brecha que se cierra: `data/source-runtime-state.json` muere con el
 * contenedor, así que dos contenedores del mismo día no se ven entre sí y los
 * dos consultan el portal creyendo ser el primero. La autoridad durable es el
 * CRM, sin registros de control: cada empresa ingerida lleva su `lastVerified`,
 * y la más reciente dice cuándo se consultó el portal por última vez.
 *
 * Todas las pruebas de bloqueo levantan un servidor que hace de portal del
 * Condado y comprueban que **no recibió ni una petición**. No se mira una
 * bandera: se mira si el socket se abrió.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-durable-'));
process.env.SOURCE_RUNTIME_STATE_PATH = path.join(tmpDir, 'state.json');
process.env.SOURCE_SNAPSHOT_DIR = path.join(tmpDir, 'snapshots');
process.env.SOURCE_SESSION_ID = 'sesion-durable';
process.env.DB_PATH = ':memory:';
process.env.APP_SECRET = 'test-durable';
process.env.SERVICE_ZIPS = '92101,92103';

const { fetchFromSource } = await import('../src/prospecting/sources/index.js');
const { checkDurableQuota, DURABLE_WINDOW_MS } = await import('../src/prospecting/sources/durable-quota.js');
const { createFakeTwenty, EXISTING_COMPANY } = await import('./fixtures/fake-twenty.js');
const { createClient, latestVerifiedWithPrefix } = await import('../src/services/crm/twenty.js');

const FUENTE = 'sdcounty_food_facility_permits';
const NS = 'sdcounty-ffp';
const AHORA = Date.parse('2026-10-05T12:00:00.000Z');
const CARGA = '2026-10-04T06:49:55.122Z';

test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const nuevoEstado = () => {
  const f = path.join(tmpDir, `q-${Math.random().toString(36).slice(2)}.json`);
  return { stateFile: f, lockFile: `${f}.lock` };
};

/**
 * Portal del Condado simulado que cuenta las peticiones que recibe.
 * Si una ruta bloqueada lo tocara, `peticiones` dejaría de ser 0.
 */
async function portalVigilado() {
  const peticiones = [];
  const server = http.createServer((req, res) => {
    peticiones.push({ method: req.method, url: req.url });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('[]');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    server,
    peticiones,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => server.close(),
  };
}

/** Una Company tal como la devuelve la API, con la clave y la marca que importan. */
const empresaDelCondado = (recordId, lastVerified, extra = {}) => ({
  ...EXISTING_COMPANY,
  id: `id-${recordId}`,
  name: `Negocio ${recordId}`,
  dedupKey: `${NS}:${recordId}`,
  lastVerified,
  deletedAt: null,
  ...extra,
});

// ── La decisión, en frío ─────────────────────────────────────
test('con una carga de hace 3 h, bloquea', async () => {
  const r = await checkDurableQuota({
    namespace: NS, now: AHORA,
    lookup: async () => ({ dedupKey: `${NS}:X`, lastVerified: new Date(AHORA - 3 * 3600000).toISOString() }),
  });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'cuota_24h_durable');
  assert.equal(r.authority, 'crm');
  assert.equal(Math.round(r.remainingMs / 3600000), 21);
});

test('a las 24 h exactas permite: el límite es 24 h, no 24 h y un segundo', async () => {
  const justo = await checkDurableQuota({
    namespace: NS, now: AHORA,
    lookup: async () => ({ dedupKey: `${NS}:X`, lastVerified: new Date(AHORA - DURABLE_WINDOW_MS).toISOString() }),
  });
  assert.equal(justo.allowed, true, 'a las 24 h exactas tiene que permitir');

  const unMsAntes = await checkDurableQuota({
    namespace: NS, now: AHORA,
    lookup: async () => ({ dedupKey: `${NS}:X`, lastVerified: new Date(AHORA - DURABLE_WINDOW_MS + 1).toISOString() }),
  });
  assert.equal(unMsAntes.allowed, false, 'un milisegundo antes todavía no');
});

test('sin ninguna empresa de la fuente, permite el bootstrap', async () => {
  const r = await checkDurableQuota({ namespace: NS, now: AHORA, lookup: async () => null });
  assert.equal(r.allowed, true);
  assert.equal(r.lastVerifiedAt, null);
  assert.match(r.detail, /no tiene ninguna empresa/);
});

test('un CRM ilegible bloquea, no permite', async () => {
  const r = await checkDurableQuota({
    namespace: NS, now: AHORA,
    lookup: async () => { throw new Error('503 service unavailable'); },
  });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'cuota_durable_indeterminada');
  assert.match(r.detail, /503/);
});

test('datos inválidos bloquean: sin marca, ilegible, en el futuro o de otro namespace', async () => {
  const casos = [
    ['sin marca', { dedupKey: `${NS}:X`, lastVerified: null }],
    ['marca vacía', { dedupKey: `${NS}:X`, lastVerified: '' }],
    ['marca ilegible', { dedupKey: `${NS}:X`, lastVerified: 'ayer por la tarde' }],
    ['marca en el futuro', { dedupKey: `${NS}:X`, lastVerified: new Date(AHORA + 7200000).toISOString() }],
    ['otro namespace', { dedupKey: 'otra-fuente:X', lastVerified: new Date(AHORA - 48 * 3600000).toISOString() }],
  ];
  for (const [nombre, fila] of casos) {
    const r = await checkDurableQuota({ namespace: NS, now: AHORA, lookup: async () => fila });
    assert.equal(r.allowed, false, `"${nombre}" debería bloquear`);
    assert.equal(r.reason, 'cuota_durable_indeterminada', `"${nombre}"`);
  }
});

test('sin forma de preguntar al CRM se bloquea cuando se exige', async () => {
  const exigido = await checkDurableQuota({ namespace: NS, now: AHORA, lookup: null, required: true });
  assert.equal(exigido.allowed, false);
  assert.equal(exigido.reason, 'cuota_durable_indeterminada');

  // Y sin exigirlo se permite, pero diciendo que no se comprobó.
  const sinExigir = await checkDurableQuota({ namespace: NS, now: AHORA, lookup: null, required: false });
  assert.equal(sinExigir.allowed, true);
  assert.equal(sinExigir.authority, 'ninguna');
  assert.match(sinExigir.detail, /no se puede comprobar/);
});

// ── Contenedor nuevo, sin estado local ───────────────────────
test('contenedor nuevo sin estado local: el CRM bloquea igual', async () => {
  const { stateFile, lockFile } = nuevoEstado();
  assert.equal(fs.existsSync(stateFile), false, 'el contenedor tiene que empezar sin estado');

  const portal = await portalVigilado();
  const crm = await createFakeTwenty({ seed: [empresaDelCondado('DEH-900', CARGA)] });
  try {
    const client = createClient({ baseUrl: crm.baseUrl });
    const r = await fetchFromSource(FUENTE, {
      baseOverride: portal.baseUrl,
      quotaOptions: { stateFile, lockFile },
      durableQuotaOptions: {
        lookup: (prefix) => latestVerifiedWithPrefix(client, prefix),
        now: Date.parse(CARGA) + 3 * 3600000,
      },
    });

    assert.equal(r.blocked.reason, 'cuota_24h_durable');
    assert.equal(r.blocked.authority, 'crm');
    assert.equal(r.metrics.quota_blocked, 1);
    assert.equal(r.metrics.fetched, 0);
    assert.equal(r.metrics.crm_writes, 0);
    assert.equal(r.metrics.outbound, 0);
    assert.equal(r.rows.length, 0);

    // Lo que de verdad importa: el portal no se tocó.
    assert.deepEqual(portal.peticiones, [], 'se consultó al Condado estando bloqueado');
    assert.deepEqual(crm.writes(), [], 'se escribió en el CRM');
    assert.ok(crm.requests.every((q) => q.method === 'GET'));
  } finally {
    portal.close();
    crm.server.close();
  }
});

test('contenedor nuevo a las 24 h y pico: el CRM permite y sí consulta', async () => {
  const { stateFile, lockFile } = nuevoEstado();
  const portal = await portalVigilado();
  const crm = await createFakeTwenty({ seed: [empresaDelCondado('DEH-900', CARGA)] });
  try {
    const client = createClient({ baseUrl: crm.baseUrl });
    const r = await fetchFromSource(FUENTE, {
      baseOverride: portal.baseUrl,
      quotaOptions: { stateFile, lockFile },
      durableQuotaOptions: {
        lookup: (prefix) => latestVerifiedWithPrefix(client, prefix),
        now: Date.parse(CARGA) + DURABLE_WINDOW_MS,
      },
    });

    assert.equal(r.blocked, null, 'a las 24 h exactas tenía que pasar');
    assert.equal(r.durableQuota.allowed, true);
    assert.equal(r.metrics.quota_blocked, 0);
    assert.equal(r.metrics.attempted, 1);
    assert.equal(portal.peticiones.length, 1, 'tenía que consultar una vez');
    assert.equal(portal.peticiones[0].method, 'GET');
    assert.deepEqual(crm.writes(), []);
  } finally {
    portal.close();
    crm.server.close();
  }
});

test('contenedor nuevo con CRM caído: fail-closed antes de la fuente', async () => {
  const { stateFile, lockFile } = nuevoEstado();
  const portal = await portalVigilado();
  try {
    const r = await fetchFromSource(FUENTE, {
      baseOverride: portal.baseUrl,
      quotaOptions: { stateFile, lockFile },
      durableQuotaOptions: {
        lookup: async () => { throw new Error('ECONNREFUSED'); },
      },
    });
    assert.equal(r.blocked.reason, 'cuota_durable_indeterminada');
    assert.equal(r.metrics.quota_blocked, 1);
    assert.equal(r.metrics.fetched, 0);
    assert.deepEqual(portal.peticiones, [], 'no saber cuándo se corrió no es permiso para correr');
  } finally {
    portal.close();
  }
});

test('contenedor nuevo sin registros del Condado: bootstrap permitido', async () => {
  const { stateFile, lockFile } = nuevoEstado();
  const portal = await portalVigilado();
  // El CRM solo tiene los 3 leads manuales y 5 demos retiradas: ninguno es de
  // esta fuente, así que no dicen nada sobre cuándo se consultó el portal.
  const crm = await createFakeTwenty({
    seed: [
      { ...EXISTING_COMPANY, id: 'm1', name: 'Cal-Prop Management', dedupKey: 'cal-prop.com', lastVerified: '2026-10-03T23:02:00.000Z', deletedAt: null },
      { ...EXISTING_COMPANY, id: 'm2', name: 'Hawks Construction', dedupKey: 'hawksconstructionsd.com', lastVerified: '2026-10-03T23:10:00.000Z', deletedAt: null },
      { ...EXISTING_COMPANY, id: 'd1', name: 'Stripe', dedupKey: '', lastVerified: null, deletedAt: '2026-10-04T06:31:30.143Z' },
    ],
  });
  try {
    const client = createClient({ baseUrl: crm.baseUrl });
    const r = await fetchFromSource(FUENTE, {
      baseOverride: portal.baseUrl,
      quotaOptions: { stateFile, lockFile },
      durableQuotaOptions: {
        lookup: (prefix) => latestVerifiedWithPrefix(client, prefix),
        now: AHORA,
      },
    });
    assert.equal(r.blocked, null, 'sin registros de la fuente hay que permitir el bootstrap');
    assert.equal(r.durableQuota.lastVerifiedAt, null);
    assert.equal(portal.peticiones.length, 1);
    assert.deepEqual(crm.writes(), []);
  } finally {
    portal.close();
    crm.server.close();
  }
});

// ── Lo que no cuenta como autoridad ──────────────────────────
test('una empresa retirada no gobierna la cuota de hoy', async () => {
  // La consulta al CRM excluye las borradas en blando. Si no lo hiciera, la
  // marca de algo que alguien retiró seguiría bloqueando corridas.
  const crm = await createFakeTwenty({
    seed: [empresaDelCondado('DEH-900', new Date(AHORA - 3600000).toISOString(), {
      deletedAt: '2026-10-04T06:31:30.143Z',
    })],
  });
  try {
    const client = createClient({ baseUrl: crm.baseUrl });
    const pedida = [];
    const espia = {
      get: (p, q) => { pedida.push(q); return client.get(p, q); },
    };
    await latestVerifiedWithPrefix(espia, `${NS}:`);
    assert.match(pedida[0].filter, /deletedAt\[is\]:NULL/,
      'la consulta tiene que excluir las retiradas');
    assert.match(pedida[0].filter, /dedupKey\[startsWith\]:sdcounty-ffp:/);
    assert.match(pedida[0].order_by, /lastVerified\[DescNullsLast\]/);
    assert.equal(pedida[0].limit, 1, 'una fila basta: se pregunta por la más reciente');
  } finally {
    crm.server.close();
  }
});

test('la consulta de la cuota durable no escribe nada', async () => {
  const crm = await createFakeTwenty({ seed: [empresaDelCondado('DEH-900', CARGA)] });
  try {
    const client = createClient({ baseUrl: crm.baseUrl });
    const fila = await latestVerifiedWithPrefix(client, `${NS}:`);
    assert.equal(fila.dedupKey, `${NS}:DEH-900`);
    assert.equal(fila.lastVerified, CARGA);
    assert.deepEqual(crm.writes(), []);
    assert.ok(crm.requests.every((q) => q.method === 'GET'));
  } finally {
    crm.server.close();
  }
});

test('la cuota local sigue en pie como segunda defensa', async () => {
  const { stateFile, lockFile } = nuevoEstado();
  const portal = await portalVigilado();
  const crm = await createFakeTwenty({ seed: [] });   // CRM sin nada: el durable permite
  try {
    const client = createClient({ baseUrl: crm.baseUrl });
    const opciones = {
      baseOverride: portal.baseUrl,
      quotaOptions: { stateFile, lockFile },
      durableQuotaOptions: {
        lookup: (prefix) => latestVerifiedWithPrefix(client, prefix),
        now: AHORA,
      },
    };
    const primera = await fetchFromSource(FUENTE, opciones);
    assert.equal(primera.blocked, null);
    assert.equal(portal.peticiones.length, 1);

    // El CRM sigue vacío (esta fase no escribe), así que el durable volvería a
    // permitir. La cuota local es la que para la segunda corrida.
    const segunda = await fetchFromSource(FUENTE, opciones);
    assert.equal(segunda.blocked.reason, 'cuota_24h');
    assert.equal(segunda.metrics.quota_blocked, 1);
    assert.equal(portal.peticiones.length, 1, 'la segunda corrida llegó al portal');
  } finally {
    portal.close();
    crm.server.close();
  }
});

// ── Alcance ──────────────────────────────────────────────────
test('ninguna ruta de este archivo enciende el outbound', async () => {
  const { config } = await import('../src/config.js');
  assert.equal(config.outbound.enabled, false);
});

test('unos segundos de desfase entre relojes no bloquean la corrida', async () => {
  const { CLOCK_SKEW_TOLERANCE_MS } = await import('../src/prospecting/sources/durable-quota.js');

  // El CRM va dos segundos por delante. Sin tolerancia, su propia marca se leería
  // como "fechada en el futuro" y la fuente quedaría bloqueada para siempre.
  const adelantado = await checkDurableQuota({
    namespace: NS, now: AHORA,
    lookup: async () => ({ dedupKey: `${NS}:X`, lastVerified: new Date(AHORA + 2000).toISOString() }),
  });
  assert.equal(adelantado.allowed, false, 'sigue dentro de la ventana de 24 h');
  assert.equal(adelantado.reason, 'cuota_24h_durable', 'no es un problema de reloj: es la cuota');
  assert.ok(adelantado.remainingMs <= DURABLE_WINDOW_MS,
    'el tiempo restante no puede superar la ventana');

  // Más allá de la tolerancia sí es un reloj mal puesto, y bloquea por eso.
  const muyAdelantado = await checkDurableQuota({
    namespace: NS, now: AHORA,
    lookup: async () => ({
      dedupKey: `${NS}:X`,
      lastVerified: new Date(AHORA + CLOCK_SKEW_TOLERANCE_MS + 60000).toISOString(),
    }),
  });
  assert.equal(muyAdelantado.allowed, false);
  assert.equal(muyAdelantado.reason, 'cuota_durable_indeterminada');
  assert.match(muyAdelantado.detail, /reloj mal puesto/);

  // Y un desfase pequeño no convierte una marca vieja en válida.
  const vieja = await checkDurableQuota({
    namespace: NS, now: AHORA,
    lookup: async () => ({ dedupKey: `${NS}:X`, lastVerified: new Date(AHORA - DURABLE_WINDOW_MS - 1000).toISOString() }),
  });
  assert.equal(vieja.allowed, true);
});
