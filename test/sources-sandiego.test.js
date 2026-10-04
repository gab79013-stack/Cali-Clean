import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

/**
 * Fuentes del área de San Diego: la puerta de cumplimiento, el parseo de filas
 * con nombres de columna inciertos y el filtro por área de servicio.
 */

const attFile = path.join(os.tmpdir(), `cc-att-${Date.now()}.json`);
process.env.SOURCE_ATTESTATION_PATH = attFile;
process.env.DB_PATH = ':memory:';
process.env.APP_SECRET = 'test-sources';
process.env.SERVICE_ZIPS = '92101,92103,92110,92128';
process.env.PROSPECT_CRAWL_DELAY_MS = '0';

const { SOURCES, SERVICE_AREA, mapRow, buildUrl, fetchFromSource, sourceStatus } = await import('../src/prospecting/sources/index.js');
const { checkSourceAllowed, saveAttestation, loadAttestations } = await import('../src/prospecting/sources/compliance.js');
const { isInServiceArea } = await import('../src/services/scoring.js');
const { config } = await import('../src/config.js');
const { verifyMatch } = await import('../src/prospecting/agents/enrich.js');

test.after(() => fs.rmSync(attFile, { force: true }));

// ── Las fuentes son de San Diego, no de LA/SF ────────────────
test('el catálogo ya no apunta a Los Ángeles ni San Francisco', () => {
  const keys = Object.keys(SOURCES);
  assert.ok(keys.length > 0);
  for (const k of keys) {
    assert.ok(!/^(la|sf)_/.test(k), `quedó una fuente de LA/SF: ${k}`);
    assert.ok(/sandiego/i.test(SOURCES[k].domain), `${k} no apunta a un portal de San Diego`);
    assert.equal(SOURCES[k].serviceArea, SERVICE_AREA);
  }
});

test('las fuentes por defecto son las de San Diego', () => {
  for (const k of config.prospecting.sources) {
    assert.ok(SOURCES[k], `la fuente por defecto "${k}" no existe en el catálogo`);
    assert.ok(k.startsWith('sd'), `la fuente por defecto "${k}" no es de San Diego`);
  }
});

test('cada fuente declara dónde comprobar robots y términos', () => {
  for (const [k, s] of Object.entries(SOURCES)) {
    assert.ok(s.compliance?.robotsUrl?.startsWith('https://'), `${k} sin robotsUrl`);
    assert.ok(s.compliance?.termsUrl?.startsWith('https://'), `${k} sin termsUrl`);
  }
});

// ── La puerta de cumplimiento ────────────────────────────────
test('ninguna fuente viene habilitada de fábrica', () => {
  for (const [k, s] of Object.entries(SOURCES)) {
    const c = checkSourceAllowed(k, s, { attestations: {} });
    assert.equal(c.allowed, false, `${k} estaba habilitada sin verificar`);
    assert.equal(c.reason, 'sin_verificar');
  }
});

test('una fuente sin verificar no llega a hacer la petición', async () => {
  let touched = false;
  const server = http.createServer((req, res) => { touched = true; res.end('[]'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await assert.rejects(
      () => fetchFromSource('sd_building_permits', { baseOverride: base }),
      /no está habilitada: sin_verificar/,
    );
    assert.equal(touched, false, 'salió a la red una fuente sin verificar');
  } finally {
    server.close();
  }
});

test('la verificación exige las tres marcas, no una cualquiera', () => {
  const s = SOURCES.sd_building_permits;
  const base = { robotsAllowed: true, endpointVerified: true, termsReviewed: true, verifiedAt: new Date().toISOString() };

  assert.equal(checkSourceAllowed('sd_building_permits', s, { attestations: { sd_building_permits: base } }).allowed, true);

  for (const [field, reason] of [
    ['robotsAllowed', 'robots_prohibe'],
    ['endpointVerified', 'endpoint_sin_confirmar'],
    ['termsReviewed', 'terminos_sin_revisar'],
  ]) {
    const att = { ...base, [field]: false };
    const c = checkSourceAllowed('sd_building_permits', s, { attestations: { sd_building_permits: att } });
    assert.equal(c.allowed, false, `faltando ${field} debería bloquear`);
    assert.equal(c.reason, reason);
  }
});

test('una verificación vieja caduca', () => {
  const old = new Date(Date.now() - 400 * 86400000).toISOString();
  const att = { robotsAllowed: true, endpointVerified: true, termsReviewed: true, verifiedAt: old };
  const c = checkSourceAllowed('sd_building_permits', SOURCES.sd_building_permits, { attestations: { sd_building_permits: att } });
  assert.equal(c.allowed, false);
  assert.equal(c.reason, 'verificacion_caducada');
});

test('la constancia se guarda y se vuelve a leer', () => {
  saveAttestation('sd_business_certificates', {
    robotsAllowed: true, endpointVerified: true, termsReviewed: true, verifiedAt: new Date().toISOString(),
  });
  const all = loadAttestations();
  assert.ok(all.sd_business_certificates);
  assert.equal(checkSourceAllowed('sd_business_certificates', SOURCES.sd_business_certificates).allowed, true);
});

test('sourceStatus explica por qué está cada fuente como está', () => {
  const rows = sourceStatus();
  assert.ok(rows.length >= 3);
  const unverified = rows.find((r) => !r.allowed);
  assert.ok(unverified.reason, 'debe decir el motivo');
  assert.ok(Object.hasOwn(unverified, 'configured'));
});

// ── Parseo con nombres de columna inciertos ──────────────────
test('mapea una fila usando el primer candidato presente', () => {
  const row = {
    approval_id: 'PMT-2026-001',
    contractor_name: 'bayside builders inc',
    job_address: '2100 Harbor Dr',
    zip: '92101',
    date_close: '2026-09-28T00:00:00.000',
    scope: 'Tenant improvement, 4,200 sqft office',
    valuation: '310000',
  };
  const m = mapRow(SOURCES.sd_building_permits, row);
  assert.equal(m.businessName, 'Bayside Builders Inc');
  assert.equal(m.address, '2100 Harbor Dr');
  assert.equal(m.zip, '92101');
  assert.equal(m.serviceArea, SERVICE_AREA);
  assert.equal(m.signal.type, 'permit_finaled');
  assert.equal(m.signal.finaledAt, '2026-09-28');
  assert.equal(m.signal.valuation, 310000);
  assert.equal(m.contactName, '', 'un registro público no aporta contacto');
  assert.equal(m.phone, '', 'ni teléfono');
});

test('usa el candidato alternativo cuando el portal usa otro nombre', () => {
  const m = mapRow(SOURCES.sd_building_permits, {
    permit_number: 'B-9', applicant_name: 'Coastal GC', project_address: '500 W Broadway', zip_code: '92101',
  });
  assert.equal(m.sourceId, 'B-9');
  assert.equal(m.businessName, 'Coastal Gc');
  assert.equal(m.address, '500 W Broadway');
});

test('una fila sin los campos obligatorios se descarta, no se completa', () => {
  // Si el portal cambia de columnas, es preferible no traer nada a traer
  // prospectos plausibles e inventados.
  assert.equal(mapRow(SOURCES.sd_building_permits, { columna_rara: 'x' }), null);
  assert.equal(mapRow(SOURCES.sd_building_permits, { contractor_name: 'Solo Nombre' }), null, 'falta la dirección');
  assert.equal(mapRow(SOURCES.sd_business_certificates, { dba_name: 'Tienda SD' }).businessName, 'Tienda Sd');
});

test('la consulta filtra por fecha y lleva el límite', () => {
  const params = SOURCES.sd_building_permits.query({ sinceDays: 30, limit: 25 });
  assert.match(params.$where, /date_close > '\d{4}-\d{2}-\d{2}T/);
  assert.equal(params.$limit, '25');
  const url = buildUrl(SOURCES.sd_building_permits, params, 'http://127.0.0.1:9');
  assert.ok(url.includes('/resource/development-permits-set1.json'));
  assert.ok(url.includes('%24where='));
});

test('una fuente sin dataset confirmado no puede construir URL', () => {
  assert.equal(SOURCES.sdcounty_business_licenses.dataset, null);
  assert.throws(
    () => buildUrl(SOURCES.sdcounty_business_licenses, {}),
    /no tiene dataset confirmado/,
  );
});

// ── Área de servicio ─────────────────────────────────────────
test('el filtro de área acepta San Diego y rechaza lo de fuera', () => {
  assert.equal(isInServiceArea('92101'), true);
  assert.equal(isInServiceArea('92128'), true);
  assert.equal(isInServiceArea('90026'), false, 'un ZIP de Los Ángeles no es área de servicio');
  assert.equal(isInServiceArea('94110'), false, 'ni uno de San Francisco');
});

// ── Dos señales para dar por buena una web ───────────────────
test('un teléfono suelto ya no basta para emparejar una web', () => {
  const soloTelefono = verifyMatch('<p>Llame al (619) 555-0142</p>', {
    businessName: 'Harbor View Dental', phone: '+16195550142', zip: '92101', address: '2100 Harbor Dr',
  });
  assert.equal(soloTelefono.matched, false, 'un solo dato puede ser de un agregador');
  assert.deepEqual(soloTelefono.evidence, ['phone']);

  const dosSenales = verifyMatch('<p>Harbor View Dental · 2100 Harbor Dr, 92101</p>', {
    businessName: 'Harbor View Dental', zip: '92101', address: '2100 Harbor Dr',
  });
  assert.equal(dosSenales.matched, true);
  assert.ok(dosSenales.evidence.length >= 2);
});
