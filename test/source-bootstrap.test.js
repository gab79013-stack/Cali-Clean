import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Bootstrap, cursor y snapshot.
 *
 * El contexto que explica todas estas pruebas: el 2026-10-04 la Routine corrió
 * de verdad y trajo 0 filas. La causa resultó no estar en la red ni en la
 * puerta, sino en el dataset — `record_open_date` está vacío en las 15 906
 * filas, así que la ventana de 30 días nunca podía coincidir con nada — y, de
 * paso, se vio que el contenedor es efímero y el estado de cuota local no
 * sobrevive. Estas pruebas fijan las dos correcciones para que ningún cambio
 * futuro las deshaga en silencio.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-boot-'));
process.env.SOURCE_RUNTIME_STATE_PATH = path.join(tmpDir, 'state.json');
process.env.SOURCE_SNAPSHOT_DIR = path.join(tmpDir, 'snapshots');
process.env.SOURCE_SESSION_ID = 'sesion-de-prueba';
process.env.DB_PATH = ':memory:';
process.env.APP_SECRET = 'test-bootstrap';
process.env.SERVICE_ZIPS = '92101,92103,92113';

const { SOURCES, fetchFromSource, emptyMetrics } = await import('../src/prospecting/sources/index.js');
const { resolveCursor, localCursor, crmCursor } = await import('../src/prospecting/sources/cursor.js');
const quota = await import('../src/prospecting/sources/quota.js');
const snap = await import('../src/prospecting/sources/snapshot.js');
const { allowedFields } = await import('../src/prospecting/sources/compliance.js');

const FUENTE = 'sdcounty_food_facility_permits';
const NS = 'sdcounty-ffp';

test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const nuevoEstado = () => {
  const f = path.join(tmpDir, `q-${Math.random().toString(36).slice(2)}.json`);
  return { stateFile: f, lockFile: `${f}.lock` };
};

/**
 * Portal simulado con la forma y los VALORES reales del dataset: permit_status
 * 'Issued'/'Permit Renewed'/'Expired', active_permit 'A' en todas, ninguna
 * fecha de apertura, y `last_updated` idéntico en todas las filas.
 */
const FILAS = [
  {
    record_id: 'DEH2026-FFP-900', record_name: 'Bahía Taquería', permit_status: 'Issued',
    active_permit: 'A', business_type: 'Restaurant Food Facility', address: '1450 Harbor Dr',
    city: 'San Diego', state: 'CA', zip: '92101', last_updated: '2026-08-10T00:00:00.000',
    permit_owner_full: 'Nombre Inventado Uno', permit_owner_email: 'uno@ejemplo.invalid',
    latitude: 32.71, longitude: -117.16, id: 'row-1',
  },
  {
    record_id: 'DEH2026-FFP-800', record_name: 'Gaslamp Coffee House', permit_status: 'Permit Renewed',
    active_permit: 'A', business_type: 'Retail Food Facility', address: '620 Fifth Ave',
    city: 'San Diego', state: 'CA', zip: '92101', last_updated: '2026-08-10T00:00:00.000',
  },
  {
    record_id: 'DEH2026-FFP-700', record_name: 'Cocina de Marisol', permit_status: 'Issued',
    active_permit: 'A', business_type: 'Microenterprise Home Kitchen', address: '3312 Residencia Way',
    city: 'San Diego', state: 'CA', zip: '92103', last_updated: '2026-08-10T00:00:00.000',
  },
  {
    record_id: 'DEH2026-FFP-600', record_name: 'Old Harbor Cantina', permit_status: 'Expired',
    active_permit: 'A', business_type: 'Restaurant Food Facility', address: '7 Closed St',
    city: 'San Diego', state: 'CA', zip: '92101', last_updated: '2026-08-10T00:00:00.000',
  },
  {
    record_id: 'DEH2026-FFP-500', record_name: 'Salazar, Ramón', permit_status: 'Issued',
    active_permit: 'A', business_type: 'Caterer', address: '19 Unknown Ave',
    city: 'San Diego', state: 'CA', zip: '92103', last_updated: '2026-08-10T00:00:00.000',
  },
];

/** fetch que aplica el $where y el $order igual que SODA. */
function portalSimulado({ onUrl } = {}) {
  return async (url) => {
    if (onUrl) onUrl(String(url));
    const u = new URL(String(url));
    const where = u.searchParams.get('$where') || '';
    const limit = Number(u.searchParams.get('$limit') || 50);
    let rows = FILAS.slice();

    const flag = where.match(/active_permit\s*=\s*'([^']*)'/)?.[1];
    if (flag) rows = rows.filter((r) => r.active_permit === flag);
    const statusIn = where.match(/permit_status\s+in\s*\(([^)]*)\)/i)?.[1];
    if (statusIn) {
      const ok = statusIn.split(',').map((v) => v.trim().replace(/^'|'$/g, ''));
      rows = rows.filter((r) => ok.includes(r.permit_status));
    }
    const cursor = where.match(/record_id\s*<\s*'([^']*)'/)?.[1];
    if (cursor) rows = rows.filter((r) => r.record_id < cursor);
    if (/record_id DESC/i.test(u.searchParams.get('$order') || '')) {
      rows.sort((a, b) => b.record_id.localeCompare(a.record_id));
    }
    const page = rows.slice(0, limit);
    return {
      status: 200, ok: true, headers: { get: () => null },
      json: async () => page, text: async () => JSON.stringify(page),
    };
  };
}

const corrida = (opts = {}) => fetchFromSource(FUENTE, {
  baseOverride: 'https://portal.invalid',
  fetchImpl: portalSimulado(opts),
  sleep: async () => {},
  ...opts.extra,
});

// ── La causa del cero ────────────────────────────────────────
test('la consulta no depende de una fecha que el dataset no tiene', () => {
  const params = SOURCES[FUENTE].query({ limit: 50 });
  assert.ok(!/record_open_date|record_issue_date/.test(params.$where),
    'volvió el filtro por fecha: el dataset tiene esas columnas vacías en las 15 906 filas');
  assert.match(params.$where, /active_permit = 'A'/);
  assert.match(params.$where, /permit_status in/);
});

test('el $select sigue siendo exactamente la allowlist', () => {
  const params = SOURCES[FUENTE].query({ limit: 50 });
  assert.deepEqual(params.$select.split(','), allowedFields(FUENTE));
});

test('el tope de 50 filas no se puede subir desde el llamante', async () => {
  const { stateFile, lockFile } = nuevoEstado();
  let pedida = null;
  await corrida({
    onUrl: (u) => { pedida = u; },
    extra: { limit: 5000, quotaOptions: { stateFile, lockFile } },
  });
  assert.match(pedida, /%24limit=50/, `el $limit pedido no fue 50: ${pedida}`);
});

// ── Bootstrap → incremental ──────────────────────────────────
test('sin cursor la corrida es bootstrap y no filtra por record_id', async () => {
  const { stateFile, lockFile } = nuevoEstado();
  let pedida = null;
  const r = await corrida({
    onUrl: (u) => { pedida = u; },
    extra: { quotaOptions: { stateFile, lockFile } },
  });
  assert.equal(r.cursor.mode, 'bootstrap');
  assert.ok(!/record_id+%3C|record_id\+%3C/.test(pedida), 'el bootstrap no debe llevar cursor');
  // El servidor ya descarta la expirada: llegan 4 de las 5. De esas 4 caen la
  // cocina doméstica y la que lleva nombre de persona.
  assert.equal(r.metrics.fetched, 4);
  assert.equal(r.metrics.mapped, 2);
  assert.equal(r.metrics.skipped_residential, 1);
  assert.equal(r.metrics.skipped_unverifiable, 1);
});

test('el cursor de salida es el último identificador VISTO, no el aceptado', async () => {
  const { stateFile, lockFile } = nuevoEstado();
  const r = await corrida({ extra: { quotaOptions: { stateFile, lockFile } } });
  // Vio 900, 800, 700 (residencial) y 500 (nombre de persona). Si el cursor
  // fuera el último ACEPTADO (800), esas dos se volverían a pedir cada día y la
  // corrida no avanzaría nunca más allá de ellas.
  assert.equal(r.cursor.cursorOut, 'DEH2026-FFP-500');
  assert.equal(quota.readState(stateFile).sources[FUENTE].cursor, 'DEH2026-FFP-500');
});

test('la corrida siguiente es incremental y continúa donde se quedó', async () => {
  const { stateFile, lockFile } = nuevoEstado();
  const primera = await corrida({ extra: { quotaOptions: { stateFile, lockFile } } });
  assert.equal(primera.cursor.mode, 'bootstrap');

  // Ventana de cuota a cero para poder ver la segunda corrida.
  let pedida = null;
  const segunda = await corrida({
    onUrl: (u) => { pedida = u; },
    extra: {
      quotaOptions: { stateFile, lockFile, windowMs: 0 },
      cursorOptions: { stateFile },
    },
  });
  assert.equal(segunda.cursor.mode, 'incremental');
  assert.equal(segunda.cursor.cursor, 'DEH2026-FFP-500');
  // La URL codifica los espacios como '+', así que se normaliza antes de mirar.
  const legible = decodeURIComponent(pedida).replace(/\+/g, ' ');
  assert.match(legible, /record_id < 'DEH2026-FFP-500'/);
  // Y no repite nada de la primera.
  const yaVistos = primera.rows.map((r) => r.dedupKey);
  for (const r of segunda.rows) {
    assert.ok(!yaVistos.includes(r.dedupKey), `${r.dedupKey} se repitió en la corrida incremental`);
  }
});

test('el bootstrap no se repite cuando ya hay cursor local', async () => {
  const { stateFile } = nuevoEstado();
  quota.recordSuccess(FUENTE, { rows: 2, cursor: 'DEH2026-FFP-700', file: stateFile });
  const info = await resolveCursor(FUENTE, { namespace: NS, stateFile });
  assert.equal(info.mode, 'incremental');
  assert.equal(info.origin, 'local');
  assert.equal(info.cursor, 'DEH2026-FFP-700');
  assert.equal(localCursor(FUENTE, { stateFile }), 'DEH2026-FFP-700');
});

// ── El cursor durable sale del CRM ───────────────────────────
test('el CRM es el cursor durable: se deriva de la clave más baja', async () => {
  const { stateFile } = nuevoEstado();   // vacío: el contenedor acaba de nacer
  const info = await resolveCursor(FUENTE, {
    namespace: NS, stateFile, crmConfigured: true,
    crmLookup: async (prefix) => {
      assert.equal(prefix, 'sdcounty-ffp:');
      return 'sdcounty-ffp:DEH2026-FFP-700';
    },
  });
  assert.equal(info.mode, 'incremental');
  assert.equal(info.origin, 'crm');
  assert.equal(info.cursor, 'DEH2026-FFP-700');
});

test('un CRM sin empresas de la fuente sí justifica el bootstrap', async () => {
  const { stateFile } = nuevoEstado();
  const info = await resolveCursor(FUENTE, {
    namespace: NS, stateFile, crmConfigured: true, crmLookup: async () => null,
  });
  assert.equal(info.mode, 'bootstrap');
  assert.equal(info.origin, 'crm');
});

test('si el CRM no se puede leer, NO se hace bootstrap a ciegas', async () => {
  const { stateFile } = nuevoEstado();
  const info = await resolveCursor(FUENTE, {
    namespace: NS, stateFile, crmConfigured: true,
    crmLookup: async () => { throw new Error('502 bad gateway'); },
  });
  assert.equal(info.mode, 'blocked');
  assert.equal(info.reason, 'cursor_indeterminado');
  assert.match(info.detail, /502/);
});

test('una clave de otro namespace no sirve de cursor', async () => {
  const r = await crmCursor(NS, async () => 'otra-fuente:XYZ');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'namespace_inesperado');
});

test('sin cursor y sin CRM, sincronizar queda bloqueado; mirar no', async () => {
  const { stateFile } = nuevoEstado();
  const paraSync = await resolveCursor(FUENTE, { namespace: NS, stateFile });
  assert.equal(paraSync.mode, 'blocked');
  assert.equal(paraSync.reason, 'sin_persistencia_durable');

  const paraMirar = await resolveCursor(FUENTE, {
    namespace: NS, stateFile, allowBootstrapWithoutCrm: true,
  });
  assert.equal(paraMirar.mode, 'bootstrap');
});

test('una corrida con cursor indeterminado no llega a consultar el portal', async () => {
  let tocado = false;
  const r = await fetchFromSource(FUENTE, {
    baseOverride: 'https://portal.invalid',
    fetchImpl: async () => { tocado = true; throw new Error('no debería llamarse'); },
    cursorOptions: {
      crmConfigured: true,
      crmLookup: async () => { throw new Error('CRM caído'); },
    },
  });
  assert.equal(tocado, false, 'salió a la red con el cursor indeterminado');
  assert.equal(r.blocked.reason, 'cursor_indeterminado');
  assert.equal(r.rows.length, 0);
});

// ── Defensa de datos sobre la forma real ─────────────────────
test('solo sobreviven permisos activos de negocios verificables', async () => {
  const { stateFile, lockFile } = nuevoEstado();
  const r = await corrida({ extra: { quotaOptions: { stateFile, lockFile } } });
  assert.deepEqual(r.rows.map((x) => x.businessName), ['Bahía Taquería', 'Gaslamp Coffee House']);
});

test('la expirada se descarta incluso si el servidor la devuelve', async () => {
  const { stateFile, lockFile } = nuevoEstado();
  // Servidor que ignora el $where: devuelve todo, expiradas incluidas.
  const r = await fetchFromSource(FUENTE, {
    baseOverride: 'https://portal.invalid',
    fetchImpl: async () => ({
      status: 200, ok: true, headers: { get: () => null },
      json: async () => FILAS, text: async () => '',
    }),
    sleep: async () => {},
    quotaOptions: { stateFile, lockFile },
  });
  assert.equal(r.metrics.fetched, 5);
  assert.equal(r.metrics.skipped_inactive, 1, 'la expirada tiene que caer en el cliente');
  assert.equal(r.metrics.skipped_residential, 1);
  assert.equal(r.metrics.skipped_unverifiable, 1, 'el nombre con forma de persona también');
  assert.equal(r.metrics.mapped, 2);
  const volcado = JSON.stringify(r.rows);
  for (const aguja of ['Nombre Inventado Uno', 'uno@ejemplo.invalid', '32.71', '-117.16', 'row-1',
    'Marisol', 'Salazar', 'Old Harbor']) {
    assert.ok(!volcado.includes(aguja), `"${aguja}" sobrevivió`);
  }
});

test('la clave de deduplicación es determinista y viene del record_id', async () => {
  const { stateFile, lockFile } = nuevoEstado();
  const a = await corrida({ extra: { quotaOptions: { stateFile, lockFile } } });
  const otro = nuevoEstado();
  const b = await corrida({ extra: { quotaOptions: otro } });

  assert.deepEqual(a.rows.map((r) => r.dedupKey), b.rows.map((r) => r.dedupKey),
    'dos corridas de las mismas filas tienen que dar las mismas claves');
  assert.deepEqual(a.rows.map((r) => r.dedupKey),
    ['sdcounty-ffp:DEH2026-FFP-900', 'sdcounty-ffp:DEH2026-FFP-800']);
  for (const r of a.rows) {
    assert.ok(!/^web:|\.com|\.net/.test(r.dedupKey), 'la clave no puede apoyarse en un dominio inventado');
  }
});

test('el record_id repetido del dataset se colapsa en una sola fila', async () => {
  const { stateFile, lockFile } = nuevoEstado();
  // El dataset real tiene 15 905 record_id distintos en 15 906 filas.
  const conRepetido = [FILAS[0], { ...FILAS[0], record_name: 'BAHIA TAQUERIA #2' }];
  const r = await fetchFromSource(FUENTE, {
    baseOverride: 'https://portal.invalid',
    fetchImpl: async () => ({
      status: 200, ok: true, headers: { get: () => null },
      json: async () => conRepetido, text: async () => '',
    }),
    sleep: async () => {},
    quotaOptions: { stateFile, lockFile },
  });
  assert.equal(r.metrics.fetched, 2);
  assert.equal(r.metrics.deduped, 1);
  assert.equal(r.metrics.mapped, 1);
});

test('el rastro de procedencia apunta al recurso oficial del condado', async () => {
  const { stateFile, lockFile } = nuevoEstado();
  const r = await corrida({ extra: { quotaOptions: { stateFile, lockFile } } });
  for (const row of r.rows) {
    assert.equal(row.sourceUrl, 'https://data.sandiegocounty.gov/resource/c5ez-ufrd.json');
  }
});

test('sin fecha de apertura la señal no finge una: dice lo que se sabe', async () => {
  const { stateFile, lockFile } = nuevoEstado();
  const r = await corrida({ extra: { quotaOptions: { stateFile, lockFile } } });
  for (const row of r.rows) {
    assert.equal(row.signal.type, 'active_permit');
    assert.ok(!('openedAt' in row.signal), 'no puede haber una fecha de apertura inventada');
    assert.equal(row.signal.datasetUpdatedAt, '2026-08-10');
    assert.ok(['Issued', 'Permit Renewed'].includes(row.signal.permitStatus));
  }
});

// ── Snapshot ─────────────────────────────────────────────────
test('el snapshot lleva hash y se vuelve a leer igual', async () => {
  const { stateFile, lockFile } = nuevoEstado();
  const r = await corrida({ extra: { quotaOptions: { stateFile, lockFile } } });
  const w = snap.writeSnapshot({
    sourceId: FUENTE, mode: 'bootstrap', cursorIn: null,
    cursorOut: r.cursor.cursorOut, rows: r.rows, metrics: r.metrics,
  });
  assert.match(w.hash, /^sha256:[0-9a-f]{64}$/);

  const leido = snap.readSnapshot(w.file);
  assert.equal(leido.ok, true, `problemas: ${leido.problems.join('; ')}`);
  assert.equal(leido.doc.rowCount, r.rows.length);
  assert.deepEqual(leido.doc.rows.map((x) => x.dedupKey), r.rows.map((x) => x.dedupKey));
});

test('tocar el snapshot invalida su hash', () => {
  const w = snap.writeSnapshot({
    sourceId: FUENTE, mode: 'bootstrap', cursorIn: null, cursorOut: 'X',
    rows: [{ businessName: 'A', dedupKey: 'sdcounty-ffp:A' }], metrics: emptyMetrics(),
  });
  const doc = JSON.parse(fs.readFileSync(w.file, 'utf8'));
  doc.rows.push({ businessName: 'Colada a mano', dedupKey: 'sdcounty-ffp:Z' });
  fs.writeFileSync(w.file, JSON.stringify(doc, null, 2));

  const leido = snap.readSnapshot(w.file);
  assert.equal(leido.ok, false);
  assert.ok(leido.problems.some((p) => /hash no coincide/.test(p)));
});

test('el hash no depende del orden de las claves', () => {
  const a = { b: 2, a: 1, c: { y: 2, x: 1 } };
  const b = { a: 1, c: { x: 1, y: 2 }, b: 2 };
  assert.equal(snap.computeHash(a), snap.computeHash(b));
});

test('un snapshot de otra sesión no se reutiliza', () => {
  const w = snap.writeSnapshot({
    sourceId: FUENTE, mode: 'bootstrap', cursorIn: null, cursorOut: 'X',
    rows: [{ businessName: 'A', dedupKey: 'sdcounty-ffp:A' }], metrics: emptyMetrics(),
  });
  const original = process.env.SOURCE_SESSION_ID;
  process.env.SOURCE_SESSION_ID = 'otra-sesion';
  try {
    const leido = snap.readSnapshot(w.file);
    assert.equal(leido.ok, false);
    assert.ok(leido.problems.some((p) => /otra sesión/.test(p)));
    // Pero el contenido sigue siendo válido: lo que caduca es la autorización.
    const sinSesion = snap.readSnapshot(w.file, { requireSameSession: false });
    assert.equal(sinSesion.ok, true);
  } finally {
    process.env.SOURCE_SESSION_ID = original;
  }
});

test('un snapshot viejo caduca', () => {
  const w = snap.writeSnapshot({
    sourceId: FUENTE, mode: 'bootstrap', cursorIn: null, cursorOut: 'X',
    rows: [{ businessName: 'A', dedupKey: 'sdcounty-ffp:A' }], metrics: emptyMetrics(),
    now: Date.now() - 48 * 3600 * 1000,
  });
  const leido = snap.readSnapshot(w.file);
  assert.equal(leido.ok, false);
  assert.ok(leido.problems.some((p) => /caducó/.test(p)));
});

test('el resumen del snapshot no lleva un solo dato personal', async () => {
  const { stateFile, lockFile } = nuevoEstado();
  const r = await corrida({ extra: { quotaOptions: { stateFile, lockFile } } });
  const resumen = snap.summarize(r.rows);
  const texto = JSON.stringify(resumen);
  for (const aguja of ['Nombre Inventado', 'ejemplo.invalid', '32.71', 'permit_owner', 'Marisol']) {
    assert.ok(!texto.includes(aguja), `"${aguja}" apareció en el resumen`);
  }
  // Y sí lleva lo que hace falta para decidir.
  for (const c of resumen) {
    // `status` en lugar de `permitStatus`: el campo es común a las dos fuentes y
    // cada una lo rellena desde el suyo (permit_status o account_status).
    assert.ok(c.businessName && c.city && c.businessType && c.status && c.dedupKey);
    assert.match(c.recordIdPartial, /^…/, 'el identificador va recortado');
  }
});

// ── Reutilización sin segunda consulta ───────────────────────
test('reutilizar el snapshot no consulta la fuente ni gasta otra cuota', async () => {
  const { stateFile, lockFile } = nuevoEstado();
  let consultas = 0;
  const r = await fetchFromSource(FUENTE, {
    baseOverride: 'https://portal.invalid',
    fetchImpl: portalSimulado({ onUrl: () => { consultas++; } }),
    sleep: async () => {},
    quotaOptions: { stateFile, lockFile },
  });
  assert.equal(consultas, 1);

  const w = snap.writeSnapshot({
    sourceId: FUENTE, mode: 'bootstrap', cursorIn: null,
    cursorOut: r.cursor.cursorOut, rows: r.rows, metrics: r.metrics,
  });

  // El paso de sincronización solo lee el archivo: ni una petición más.
  const antes = quota.readState(stateFile).sources[FUENTE].runs;
  const leido = snap.readSnapshot(w.file);
  const despues = quota.readState(stateFile).sources[FUENTE].runs;

  assert.equal(leido.ok, true);
  assert.equal(consultas, 1, 'reutilizar volvió a consultar el portal');
  assert.equal(antes, despues, 'reutilizar gastó una segunda corrida de cuota');
  assert.deepEqual(leido.doc.rows.map((x) => x.dedupKey), r.rows.map((x) => x.dedupKey),
    'lo que se sincronizaría no es exactamente lo que se enseñó');
});

// ── El CRM no se toca ────────────────────────────────────────
test('el plan contra el CRM es idempotente y solo hace GET', async () => {
  const { createFakeTwenty } = await import('./fixtures/fake-twenty.js');
  const { createClient, planCompanyUpsert } = await import('../src/services/crm/twenty.js');
  const { stateFile, lockFile } = nuevoEstado();

  const r = await corrida({ extra: { quotaOptions: { stateFile, lockFile } } });
  const fake = await createFakeTwenty({ seed: [] });
  try {
    const client = createClient({ baseUrl: fake.baseUrl });
    const prospecto = (row) => ({
      dedupKey: row.dedupKey, businessName: row.businessName, sourceUrl: row.sourceUrl,
      serviceArea: row.serviceArea, address: row.address, city: row.city, zip: row.zip,
      stage: 'discovered', channel: 'public_record', lastVerified: new Date().toISOString(),
    });

    const primera = [];
    for (const row of r.rows) primera.push(await planCompanyUpsert(client, prospecto(row)));
    assert.deepEqual(primera.map((p) => p.action), ['create', 'create']);

    // Planificar otra vez no cambia nada: el plan es una lectura.
    const segunda = [];
    for (const row of r.rows) segunda.push(await planCompanyUpsert(client, prospecto(row)));
    assert.deepEqual(segunda.map((p) => p.action), ['create', 'create']);

    assert.deepEqual(fake.writes(), [], 'planificar escribió en el CRM');
    assert.ok(fake.requests.every((q) => q.method === 'GET'), 'hubo algo que no era GET');
    assert.equal(fake.companies.length, 0, 'el CRM cambió de contenido');

    // Y la clave que se consulta es la determinista, no un dominio.
    for (const q of fake.requests) {
      assert.match(q.query.filter || '', /dedupKey\[eq\]:sdcounty-ffp:/);
    }
  } finally {
    fake.server.close();
  }
});

test('el cursor se puede recuperar del CRM sin escribir nada', async () => {
  const { createFakeTwenty } = await import('./fixtures/fake-twenty.js');
  const { createClient, lowestDedupKeyWithPrefix } = await import('../src/services/crm/twenty.js');
  const fake = await createFakeTwenty({
    seed: [
      { id: 'a', name: 'Uno', dedupKey: 'sdcounty-ffp:DEH2026-FFP-900' },
      { id: 'b', name: 'Dos', dedupKey: 'sdcounty-ffp:DEH2026-FFP-700' },
      { id: 'c', name: 'Otra fuente', dedupKey: 'otra:XYZ' },
    ],
  });
  try {
    const client = createClient({ baseUrl: fake.baseUrl });
    const key = await lowestDedupKeyWithPrefix(client, 'sdcounty-ffp:');
    assert.ok(String(key).startsWith('sdcounty-ffp:'), `devolvió ${key}`);
    assert.deepEqual(fake.writes(), [], 'recuperar el cursor escribió algo');
  } finally {
    fake.server.close();
  }
});

// ── Las demás fuentes siguen cerradas ────────────────────────
test('ninguna otra fuente puede pedir el endpoint SODA del condado', async () => {
  const { buildUrl } = await import('../src/prospecting/sources/index.js');
  const { allowlistEntry } = await import('../src/prospecting/sources/compliance.js');

  // Las dos municipales son csv-static: `buildUrl` —que construye URLs de
  // SODA— se niega a formarlas, estén habilitadas o no. El acceso de una fuente
  // no es intercambiable con el de otra.
  for (const key of ['sd_business_tax_certificates', 'sd_development_approvals']) {
    assert.throws(() => buildUrl(SOURCES[key], {}), /no está implementado/);
  }

  // Y la que sigue apagada tampoco llega a la red.
  assert.equal(allowlistEntry('sd_development_approvals').enabled, false);
  await assert.rejects(
    () => fetchFromSource('sd_development_approvals', { baseOverride: 'https://portal.invalid' }),
    /no está habilitada/,
  );
});

test('los datasets rechazados siguen sin poder construir URL', async () => {
  const { buildUrl } = await import('../src/prospecting/sources/index.js');
  for (const id of ['development-permits-set1', 'business-listings', 'dyzh-7eat', '76h4-nnmj']) {
    assert.throws(
      () => buildUrl({ label: `x ${id}`, accessType: 'soda', domain: 'data.sandiegocounty.gov', dataset: id }, {}),
      /rechazado por la auditoría/,
    );
  }
});

test('el outbound sigue apagado', async () => {
  const { config } = await import('../src/config.js');
  assert.equal(config.outbound.enabled, false);
});

// ── El cuerpo exacto que se escribe ──────────────────────────
/**
 * Estas tres fijan lo que viaja al CRM en la carga productiva. Si alguien
 * cambia el mapeo, fallan aquí y no en los datos del cliente.
 */
test('la procedencia de un registro público es BUSINESS_DIRECTORY', async () => {
  const { toLeadSource, ENUMS } = await import('../src/services/crm/twenty-schema.js');
  assert.equal(toLeadSource('public_record'), 'BUSINESS_DIRECTORY',
    'PUBLIC_WEBSITE sería mentir: a este negocio no se le ha visitado la web');
  assert.ok(ENUMS.leadSource.includes('BUSINESS_DIRECTORY'),
    'el valor tiene que existir ya en el enum: no se cambia el esquema del CRM');
  assert.equal(toLeadSource('inbound'), 'INBOUND_WEBSITE');
  assert.equal(toLeadSource('outbound'), 'PUBLIC_WEBSITE');
});

test('el cuerpo de Company lleva la procedencia completa y ni un dato personal', async () => {
  const { mapProspectToCompany } = await import('../src/services/crm/twenty.js');
  const { stateFile, lockFile } = nuevoEstado();
  const r = await corrida({ extra: { quotaOptions: { stateFile, lockFile } } });
  const verificadoEn = '2026-10-04T06:49:55.122Z';

  for (const row of r.rows) {
    const body = mapProspectToCompany({
      dedupKey: row.dedupKey, businessName: row.businessName, sourceUrl: row.sourceUrl,
      serviceArea: row.serviceArea, address: row.address, city: row.city, zip: row.zip,
      state: 'CA', country: 'US', stage: 'discovered', channel: 'public_record',
      lastVerified: verificadoEn,
    });

    assert.equal(body.leadSource, 'BUSINESS_DIRECTORY');
    assert.equal(body.dedupKey, row.dedupKey);
    assert.match(body.dedupKey, /^sdcounty-ffp:/);
    assert.equal(body.sourceUrl.primaryLinkUrl, 'https://data.sandiegocounty.gov/resource/c5ez-ufrd.json');
    assert.equal(body.lastVerified, verificadoEn, 'la marca es la del snapshot, no la de ahora');
    assert.ok(body.serviceArea, 'sin área de servicio no se puede filtrar por zona');
    assert.equal(body.contactabilityStatus, 'NO_VERIFIED_CHANNEL',
      'no hay canal verificado: no se puede afirmar que se le pueda escribir');

    // Nada de contacto: el registro público no lo da y no se inventa.
    assert.equal(body.businessEmail, undefined);
    assert.equal(body.domainName, undefined);
    const texto = JSON.stringify(body);
    for (const aguja of ['Nombre Inventado', 'ejemplo.invalid', 'permit_owner', 'latitude', '32.71']) {
      assert.ok(!texto.includes(aguja), `"${aguja}" viajaría al CRM`);
    }
  }
});

test('con la marca del snapshot la segunda pasada es noop, no update', async () => {
  const { createFakeTwenty } = await import('./fixtures/fake-twenty.js');
  const { createClient, upsertCompany, planCompanyUpsert } = await import('../src/services/crm/twenty.js');
  const { stateFile, lockFile } = nuevoEstado();
  const r = await corrida({ extra: { quotaOptions: { stateFile, lockFile } } });
  const verificadoEn = '2026-10-04T06:49:55.122Z';
  const prospecto = (row) => ({
    dedupKey: row.dedupKey, businessName: row.businessName, sourceUrl: row.sourceUrl,
    serviceArea: row.serviceArea, address: row.address, city: row.city, zip: row.zip,
    state: 'CA', country: 'US', stage: 'discovered', channel: 'public_record',
    lastVerified: verificadoEn,
  });

  const fake = await createFakeTwenty({ seed: [] });
  try {
    const client = createClient({ baseUrl: fake.baseUrl });
    for (const row of r.rows) {
      const res = await upsertCompany(client, prospecto(row), { dryRun: false });
      assert.equal(res.action, 'create');
    }
    assert.equal(fake.companies.length, r.rows.length);

    // Replanificar con el MISMO snapshot: nada que cambiar.
    const escriturasAntes = fake.writes().length;
    for (const row of r.rows) {
      const plan = await planCompanyUpsert(client, prospecto(row));
      assert.equal(plan.action, 'noop', `${row.businessName} propondría un cambio y no debería`);
    }
    assert.equal(fake.writes().length, escriturasAntes, 'replanificar escribió');
    assert.equal(fake.companies.length, r.rows.length, 'se duplicó algo');
  } finally {
    fake.server.close();
  }
});

test('la dirección no se da por cambiada por los subcampos que no se envían', async () => {
  const { diffCompany, mapProspectToCompany } = await import('../src/services/crm/twenty.js');
  const propuesta = mapProspectToCompany({
    dedupKey: 'sdcounty-ffp:X', businessName: 'Pho Kitchen',
    address: '9708 Mission Gorge Rd', city: 'Santee', zip: '92071',
    state: 'CA', country: 'US', stage: 'discovered', channel: 'public_record',
    lastVerified: '2026-10-04T06:49:55.122Z',
  });

  // Lo que la API devuelve de verdad: el compuesto completo, con los subcampos
  // que nosotros no enviamos en blanco o en null.
  const enElCrm = {
    ...propuesta,
    address: {
      addressStreet1: '9708 Mission Gorge Rd', addressStreet2: '',
      addressCity: 'Santee', addressPostcode: '92071',
      addressState: 'CA', addressCountry: 'US',
      addressLat: null, addressLng: null,
    },
  };
  assert.deepEqual(diffCompany(enElCrm, propuesta), {},
    'la dirección se daba por cambiada y proponía un PATCH idéntico en sustancia');

  // Y un cambio de verdad sí se ve.
  const mudado = { ...enElCrm, address: { ...enElCrm.address, addressStreet1: '1 Otra Calle' } };
  assert.ok('address' in diffCompany(mudado, propuesta), 'una calle distinta tiene que detectarse');

  // Lo mismo con una ciudad distinta, que es el otro cambio que importa.
  const otraCiudad = { ...enElCrm, address: { ...enElCrm.address, addressCity: 'Poway' } };
  assert.ok('address' in diffCompany(otraCiudad, propuesta));
});
