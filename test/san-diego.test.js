import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Base aislada: este archivo ejercita la prospección del área de San Diego.
const dbFile = path.join(os.tmpdir(), `cc-sandiego-${Date.now()}.db`);
process.env.DB_PATH = dbFile;
process.env.OUTBOUND_ENABLED = 'false';
process.env.PROSPECT_CRAWL_DELAY_MS = '0';
process.env.MAIL_DRIVER = 'log';
process.env.APP_SECRET = 'test-secret-for-san-diego';

const { createFakeServer, counters } = await import('./fixtures/fake-sources.js');
const { db } = await import('../src/db.js');
const { setRequestRewriter } = await import('../src/prospecting/http.js');
const { SOURCES, fetchFromSource, resolveCkanResource, _clearCsvCache } = await import('../src/prospecting/sources/index.js');
const { parseCsv, pick, pickDate } = await import('../src/prospecting/sources/csv.js');
const { withinServiceArea, haversineMiles, CENTER } = await import('../src/prospecting/geo.js');
const { discover } = await import('../src/prospecting/agents/discover.js');
const { enrich } = await import('../src/prospecting/agents/enrich.js');

const { server, port } = await createFakeServer();
const base = `http://127.0.0.1:${port}`;

setRequestRewriter((url) => {
  const u = new URL(url);
  return { url: `${base}${u.pathname}${u.search}`, headers: { 'X-Forwarded-Host': u.host } };
});

test.after(() => {
  server.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
});

// ── Área de servicio ─────────────────────────────────────────
test('el área de servicio acepta el condado de San Diego', () => {
  for (const city of ['San Diego', 'Chula Vista', 'Oceanside', 'Escondido', 'El Cajon', 'Carlsbad']) {
    assert.equal(withinServiceArea({ city }).inside, true, `${city} debería entrar`);
  }
});

test('el área de servicio rechaza lo que está a más de 50 millas', () => {
  // Borrego Springs tiene ZIP del condado pero está a unas 75 millas.
  const borrego = withinServiceArea({ city: 'Borrego Springs', zip: '92004' });
  assert.equal(borrego.inside, false);
  assert.equal(borrego.basis, 'far_place');

  assert.equal(withinServiceArea({ city: 'Los Angeles', zip: '90010' }).inside, false);
  assert.equal(withinServiceArea({ city: 'Fresno', zip: '93650' }).inside, false);
});

test('con coordenadas se mide la distancia real', () => {
  const downtown = withinServiceArea({ lat: 32.72, lon: -117.16 });
  assert.equal(downtown.inside, true);
  assert.equal(downtown.basis, 'coordinates');
  assert.ok(downtown.miles < 1);

  const la = withinServiceArea({ city: 'San Diego', zip: '92101', lat: 34.05, lon: -118.24 });
  // Las coordenadas mandan sobre la ciudad declarada: la fila está mal puesta.
  assert.equal(la.inside, false);
  assert.ok(la.miles > 100);
});

test('la distancia a Los Ángeles es la conocida', () => {
  const miles = haversineMiles(CENTER, { lat: 34.0522, lon: -118.2437 });
  assert.ok(miles > 105 && miles < 115, `esperaba ~111 millas, dio ${miles}`);
});

// ── CSV ──────────────────────────────────────────────────────
test('el CSV se parsea con comillas, comas y saltos dentro de campo', () => {
  const rows = parseCsv('a,b\n"uno, dos",tres\n"con ""comillas""","dos\nlíneas"\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].a, 'uno, dos');
  assert.equal(rows[1].a, 'con "comillas"');
  assert.equal(rows[1].b, 'dos\nlíneas');
});

test('pick sobrevive a que el portal renombre una columna', () => {
  assert.equal(pick({ business_name: 'Acme' }, ['dba_name', 'business_name']), 'Acme');
  assert.equal(pick({ dba_name: '   ' }, ['dba_name', 'business_name'], 'sin nombre'), 'sin nombre');
  assert.equal(pickDate({ d: '2026-01-15' }, ['d']).toISOString().slice(0, 10), '2026-01-15');
  assert.equal(pickDate({ d: 'no es fecha' }, ['d']), null);
});

// ── La fuente de San Diego ───────────────────────────────────
test('la fuente de San Diego devuelve solo negocios dentro del área y recientes', async () => {
  const rows = await fetchFromSource('sd_active_businesses', { sinceDays: 90, limit: 50, baseOverride: base });
  const names = rows.map((r) => r.businessName);

  assert.ok(names.includes('Gaslamp Dental Studio'));
  assert.ok(names.includes('Bayview Property Management'));
  assert.ok(names.includes('Oceanside Taco House'));

  // Fuera del área.
  assert.ok(!names.includes('Wilshire Med Offices'), 'Los Ángeles no debería colarse');
  assert.ok(!names.includes('Borrego Desert Clinic'), 'Borrego Springs está a 75 millas');
  // Fuera de la ventana de tiempo.
  assert.ok(!names.includes('Old Town Antiques'), 'un negocio de hace 11 años no es una señal');

  // Los campos del CSV llegan mapeados, no vacíos.
  const gaslamp = rows.find((r) => r.businessName === 'Gaslamp Dental Studio');
  assert.equal(gaslamp.city, 'San Diego');
  assert.equal(gaslamp.zip, '92101');
  assert.equal(gaslamp.phone, '6195550188');
  assert.equal(gaslamp.address, '410 Fifth Ave');
  assert.equal(gaslamp.naics, '621210');
  assert.equal(gaslamp.area.inside, true);
});

test('lo más reciente va primero', async () => {
  const rows = await fetchFromSource('sd_active_businesses', { sinceDays: 90, limit: 50, baseOverride: base });
  const dates = rows.map((r) => r.signal.openedAt);
  assert.deepEqual(dates, [...dates].sort().reverse());
});

test('si la ruta del fichero caduca, el catálogo CKAN la resuelve', async () => {
  const original = SOURCES.sd_active_businesses.urls;
  SOURCES.sd_active_businesses.urls = ['https://seshat.datasd.org/ttcs/ruta-que-ya-no-existe.csv'];
  try {
    const rows = await fetchFromSource('sd_active_businesses', { sinceDays: 90, limit: 50, baseOverride: base });
    assert.ok(rows.some((r) => r.businessName === 'Gaslamp Dental Studio'),
      'debería haber caído al fichero que anuncia CKAN');
  } finally {
    SOURCES.sd_active_businesses.urls = original;
  }
});

test('el catálogo CKAN devuelve el CSV, no el diccionario en PDF', async () => {
  const url = await resolveCkanResource(SOURCES.sd_active_businesses.ckan, base);
  assert.match(url, /\.csv$/);
});

// ── Paginación y caché ───────────────────────────────────────
test('el offset devuelve la página siguiente, no la misma otra vez', async () => {
  const opts = { sinceDays: 90, baseOverride: base };

  // Ojo: la página se recorta ANTES del filtro de área, así que una página
  // entera puede salir vacía si sus filas caen fuera de San Diego. Lo que no
  // puede pasar es que dos páginas distintas traigan el mismo negocio.
  const page1 = await fetchFromSource('sd_active_businesses', { ...opts, limit: 3, offset: 0 });
  const page2 = await fetchFromSource('sd_active_businesses', { ...opts, limit: 3, offset: 3 });

  assert.ok(page1.length > 0 && page2.length > 0, 'ambas páginas deberían traer algo');
  const solapan = page1.filter((a) => page2.some((b) => b.businessName === a.businessName));
  assert.deepEqual(solapan, [],
    'sin paginación cada ronda repetiría las filas más recientes y no habría nada nuevo');

  // Recorrer todas las páginas debe dar exactamente lo mismo que pedirlas de golpe.
  const todas = await fetchFromSource('sd_active_businesses', { ...opts, limit: 50, offset: 0 });
  const porPaginas = [];
  for (let off = 0; off < 12; off += 2) {
    porPaginas.push(...await fetchFromSource('sd_active_businesses', { ...opts, limit: 2, offset: off }));
  }
  assert.deepEqual(porPaginas.map((r) => r.businessName), todas.map((r) => r.businessName));
});

test('el fichero se descarga una vez, no una por ronda', async () => {
  _clearCsvCache();
  counters.csvDownloads = 0;

  for (let i = 0; i < 5; i++) {
    await fetchFromSource('sd_active_businesses', { sinceDays: 90, limit: 2, offset: i * 2, baseOverride: base });
  }
  assert.equal(counters.csvDownloads, 1,
    `cinco rondas deberían costar una descarga, costaron ${counters.csvDownloads}`);
});

// ── El pipeline de punta a punta ─────────────────────────────
test('descubrir y enriquecer produce correos reales, y solo reales', async () => {
  const d = await discover({ sources: ['sd_active_businesses'], sinceDays: 90, limit: 50, baseOverride: base });
  assert.ok(d.inserted >= 3, `esperaba al menos 3 prospectos, hubo ${d.inserted}`);

  const e = await enrich({ skipDns: true });
  assert.ok(e.enriched >= 2, `esperaba al menos 2 enriquecidos, hubo ${e.enriched}`);

  const withEmail = db.prepare(
    "SELECT business_name, email, email_source FROM prospects WHERE email IS NOT NULL ORDER BY business_name"
  ).all();

  // Cada correo viene de la web del propio negocio.
  for (const row of withEmail) {
    assert.equal(row.email_source, 'published_on_website');
    assert.match(row.email, /@/);
  }
  const emails = withEmail.map((r) => r.email);
  assert.ok(emails.includes('office@gaslampdentalstudio.com'));
  assert.ok(emails.includes('hello@bayviewpropertymanagement.com'));

  // El que no publica correo se rechaza; no se le inventa un info@.
  const taco = db.prepare("SELECT stage, reject_reason, email FROM prospects WHERE business_name LIKE 'Oceanside%'").get();
  assert.equal(taco.email, null);
  assert.equal(taco.stage, 'rejected');
  assert.equal(taco.reject_reason, 'no_public_email');
});

test('la exportación escribe solo los correos verificados', async () => {
  const outTxt = path.join(os.tmpdir(), `cc-export-${Date.now()}.txt`);
  const rows = db.prepare(`
    SELECT email FROM prospects
     WHERE email IS NOT NULL AND email_source = 'published_on_website'
     GROUP BY lower(email)`).all();

  fs.writeFileSync(outTxt, rows.map((r) => r.email).join('\n'));
  const written = fs.readFileSync(outTxt, 'utf8').trim().split('\n').filter(Boolean);
  fs.rmSync(outTxt, { force: true });

  assert.equal(written.length, rows.length);
  for (const email of written) assert.match(email, /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i);
});
