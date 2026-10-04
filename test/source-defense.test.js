import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Defensa de datos, métricas y attestation, sobre la forma real de la muestra
 * del 2026-10-04: tres filas, una de ellas Microenterprise Home Kitchen.
 *
 * La muestra que se usa aquí es sintética y reproduce la FORMA verificada, no
 * su contenido: los hashes de la evidencia corresponden a los artefactos
 * reales, que esta sesión no tiene ni puede descargar.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-defense-'));
process.env.SOURCE_RUNTIME_STATE_PATH = path.join(tmpDir, 'state.json');
process.env.SOURCE_ATTESTATION_PATH = path.join(tmpDir, 'local-att.json');
process.env.DB_PATH = ':memory:';
process.env.APP_SECRET = 'test-defense';
process.env.SERVICE_ZIPS = '92101,92103,92113';

const {
  SOURCES, fetchFromSource, mapRow, buildUrl, emptyMetrics, sourceStatus,
} = await import('../src/prospecting/sources/index.js');
const { filterRow, isResidentialRow, assertNoForbidden } = await import('../src/prospecting/sources/row-filter.js');
const { allowedFields, forbiddenFields, allowlistEntry, loadAllowlist } = await import('../src/prospecting/sources/compliance.js');
const {
  computeDigest, verifyAttestation, loadAttestation, canonicalize,
} = await import('../src/prospecting/sources/attestation.js');

const FUENTE = 'sdcounty_food_facility_permits';

test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

/**
 * Muestra con la forma de la respuesta real: dos establecimientos comerciales y
 * una cocina doméstica. Se añaden a propósito campos prohibidos y una columna
 * desconocida, porque un servidor puede devolver de más.
 */
const MUESTRA = [
  {
    record_id: 'DEH2026-FFP-001',
    record_open_date: '2026-09-18T00:00:00.000',
    record_issue_date: '2026-09-25T00:00:00.000',
    record_name: 'Bahía Taquería',
    permit_status: 'Issued',
    active_permit: 'A',
    business_type: 'Restaurant Food Facility',
    address: '1450 Harbor Dr',
    city: 'San Diego',
    state: 'CA',
    zip: '92101',
    last_updated: '2026-10-01T00:00:00.000',
    // El servidor devuelve de más pese al $select:
    permit_owner_full: 'Lucía Ramírez Soto',
    permit_owner: 'L. Ramírez',
    permit_owner_email: 'lucia.privada@ejemplo.com',
    permit_owner_phone: '+16195550101',
    latitude: 32.7109,
    longitude: -117.1699,
    // Columna que el portal podría añadir mañana sin avisar:
    owner_mailing_address_2: 'Apt 4B, 77 Private Ln',
  },
  {
    record_id: 'DEH2026-FFP-002',
    record_open_date: '2026-09-20T00:00:00.000',
    record_issue_date: '2026-09-29T00:00:00.000',
    record_name: 'Gaslamp Coffee House',
    permit_status: 'Issued',
    active_permit: 'A',
    business_type: 'Retail Food Facility',
    address: '620 Fifth Ave',
    city: 'San Diego',
    state: 'CA',
    zip: '92101',
    last_updated: '2026-10-02T00:00:00.000',
    permit_owner_full: 'Daniel Okafor',
    latitude: 32.7111,
    longitude: -117.1601,
  },
  {
    // La fila que hay que excluir por completo: revela un domicilio.
    record_id: 'DEH2026-MHK-003',
    record_open_date: '2026-09-22T00:00:00.000',
    record_issue_date: '2026-09-28T00:00:00.000',
    record_name: 'Cocina de Marisol',
    permit_status: 'Issued',
    active_permit: 'A',
    business_type: 'Microenterprise Home Kitchen',
    address: '3312 Residencia Way',
    city: 'San Diego',
    state: 'CA',
    zip: '92103',
    last_updated: '2026-10-03T00:00:00.000',
    permit_owner_full: 'Marisol Vega',
    permit_owner_email: 'marisol.casa@ejemplo.com',
    latitude: 32.7455,
    longitude: -117.1601,
  },
];

const AGUJAS_PROHIBIDAS = [
  'Lucía Ramírez Soto', 'L. Ramírez', 'lucia.privada@ejemplo.com', '+16195550101',
  'Daniel Okafor', 'Marisol Vega', 'marisol.casa@ejemplo.com',
  'Apt 4B, 77 Private Ln', '32.7109', '-117.1699', '32.7455',
  'permit_owner', 'latitude', 'longitude', 'owner_mailing_address_2',
];

/** fetch simulado que devuelve la muestra ignorando el $select. */
const fetchMuestra = () => async () => ({
  status: 200,
  ok: true,
  headers: { get: () => null },
  json: async () => MUESTRA,
  text: async () => JSON.stringify(MUESTRA),
});

const nuevoEstado = () => {
  const f = path.join(tmpDir, `q-${Math.random().toString(36).slice(2)}.json`);
  return { stateFile: f, lockFile: `${f}.lock` };
};

// ── Allowlist estricta ───────────────────────────────────────
test('el $select pide exactamente la allowlist y nada más', () => {
  const params = SOURCES[FUENTE].query({ sinceDays: 90, limit: 50 });
  assert.deepEqual(params.$select.split(','), allowedFields(FUENTE));
  for (const prohibido of forbiddenFields(FUENTE)) {
    assert.ok(!params.$select.includes(prohibido));
  }
  assert.ok(!params.$select.includes('permit_owner_phone'));
});

test('al parsear, lo no permitido se cae: prohibido y desconocido', () => {
  const { row, dropped } = filterRow(FUENTE, MUESTRA[0]);
  assert.deepEqual(Object.keys(row).sort(), allowedFields(FUENTE).slice().sort());

  // Los declarados prohibidos.
  for (const f of ['permit_owner_full', 'permit_owner', 'permit_owner_email', 'latitude', 'longitude']) {
    assert.ok(dropped.forbidden.includes(f), `${f} debería caer como prohibido`);
  }
  // Y los que nadie declaró: la lista es cerrada, no una lista negra.
  assert.ok(dropped.unknown.includes('owner_mailing_address_2'));
  assert.ok(dropped.unknown.includes('permit_owner_phone'),
    'una columna nueva con datos personales no puede esperar a que alguien la prohíba');
});

test('assertNoForbidden caza un campo prohibido a cualquier profundidad', () => {
  assert.throws(() => assertNoForbidden(FUENTE, { a: { b: { latitude: 1 } } }), /Campo prohibido "latitude"/);
  assert.throws(() => assertNoForbidden(FUENTE, { lista: [{ permit_owner: 'x' }] }), /permit_owner/);
  assert.equal(assertNoForbidden(FUENTE, { record_id: 'A', address: 'B' }), true);
});

// ── Cocinas domésticas ───────────────────────────────────────
test('una cocina doméstica se reconoce por varias formas de nombrarla', () => {
  assert.equal(isResidentialRow({ business_type: 'Microenterprise Home Kitchen' }), true);
  assert.equal(isResidentialRow({ business_type: 'MICROENTERPRISE HOME KITCHEN OPERATION' }), true);
  assert.equal(isResidentialRow({ business_type: 'MHKO' }), true);
  assert.equal(isResidentialRow({ business_type: 'Cottage Food Operation' }), true);
  assert.equal(isResidentialRow({ business_type: 'Residential Care Kitchen' }), true);
  assert.equal(isResidentialRow({ address: '12 Private Home Rd', business_type: 'Restaurant' }), true);
  assert.equal(isResidentialRow({ business_type: 'Restaurant Food Facility' }), false);
  assert.equal(isResidentialRow({ business_type: 'Retail Food Facility' }), false);
});

test('la fila de cocina doméstica se descarta entera, no se recorta', () => {
  const { row, reason } = filterRow(FUENTE, MUESTRA[2]);
  assert.equal(row, null);
  assert.equal(reason, 'residential');
});

test('la detección se hace antes de recortar campos', () => {
  // Si se recortara primero, `business_type` podría no estar y la fila pasaría.
  const fila = { ...MUESTRA[2] };
  const { reason } = filterRow(FUENTE, fila);
  assert.equal(reason, 'residential');
});

// ── Pipeline completo de la fuente ───────────────────────────
test('la corrida mapea solo lo comercial y deja fuera todo lo demás', async () => {
  const { stateFile, lockFile } = nuevoEstado();
  const { rows, metrics, blocked } = await fetchFromSource(FUENTE, {
    baseOverride: 'https://ejemplo.test',
    fetchImpl: fetchMuestra(),
    sleep: async () => {},
    quotaOptions: { stateFile, lockFile },
  });

  assert.equal(blocked, null);
  assert.equal(metrics.fetched, 3);
  assert.equal(metrics.mapped, 2, 'solo los dos establecimientos comerciales');
  assert.equal(metrics.skipped_residential, 1);
  assert.equal(rows.length, 2);

  const nombres = rows.map((r) => r.businessName);
  assert.deepEqual(nombres, ['Bahía Taquería', 'Gaslamp Coffee House']);
  assert.ok(!nombres.includes('Cocina De Marisol'));
});

test('ningún dato prohibido sobrevive, ni en el prospecto ni en raw', async () => {
  const { stateFile, lockFile } = nuevoEstado();
  const { rows } = await fetchFromSource(FUENTE, {
    baseOverride: 'https://ejemplo.test',
    fetchImpl: fetchMuestra(),
    sleep: async () => {},
    quotaOptions: { stateFile, lockFile },
  });

  const volcado = JSON.stringify(rows);
  for (const aguja of AGUJAS_PROHIBIDAS) {
    assert.ok(!volcado.includes(aguja), `"${aguja}" sobrevivió a la corrida`);
  }
  for (const r of rows) {
    assert.deepEqual(Object.keys(r.raw).sort(), allowedFields(FUENTE).slice().sort());
    assertNoForbidden(FUENTE, r.raw, 'raw');
  }
});

test('las filas duplicadas se cuentan como tales', async () => {
  const { stateFile, lockFile } = nuevoEstado();
  // El dataset real tiene un record_id repetido en 15 906 filas, así que el
  // duplicado que importa es el del mismo identificador, no el del mismo
  // nombre: dos permisos distintos pueden llamarse igual y ser dos negocios.
  const duplicada = [MUESTRA[0], { ...MUESTRA[0] }];
  const { rows, metrics } = await fetchFromSource(FUENTE, {
    baseOverride: 'https://ejemplo.test',
    fetchImpl: async () => ({
      status: 200, ok: true, headers: { get: () => null },
      json: async () => duplicada, text: async () => JSON.stringify(duplicada),
    }),
    sleep: async () => {},
    quotaOptions: { stateFile, lockFile },
  });
  assert.equal(metrics.fetched, 2);
  assert.equal(metrics.mapped, 1);
  assert.equal(metrics.deduped, 1);
  assert.equal(rows.length, 1);
});

test('la segunda corrida del día queda bloqueada y lo dice en las métricas', async () => {
  const { stateFile, lockFile } = nuevoEstado();
  const opciones = {
    baseOverride: 'https://ejemplo.test',
    fetchImpl: fetchMuestra(),
    sleep: async () => {},
    quotaOptions: { stateFile, lockFile },
  };
  const primera = await fetchFromSource(FUENTE, opciones);
  assert.equal(primera.blocked, null);

  const segunda = await fetchFromSource(FUENTE, opciones);
  assert.equal(segunda.blocked.reason, 'cuota_24h');
  assert.equal(segunda.metrics.quota_blocked, 1);
  assert.equal(segunda.rows.length, 0);
});

test('el 429 se refleja en las métricas de la corrida', async () => {
  const { stateFile, lockFile } = nuevoEstado();
  let n = 0;
  const { metrics } = await fetchFromSource(FUENTE, {
    baseOverride: 'https://ejemplo.test',
    fetchImpl: async () => {
      n++;
      if (n === 1) {
        return { status: 429, ok: false, headers: { get: (h) => (h.toLowerCase() === 'retry-after' ? '3' : null) }, text: async () => '' };
      }
      return { status: 200, ok: true, headers: { get: () => null }, json: async () => MUESTRA, text: async () => '' };
    },
    sleep: async () => {},
    quotaOptions: { stateFile, lockFile },
  });
  assert.equal(metrics.http429, 1);
  assert.equal(metrics.retries, 1);
  assert.equal(metrics.mapped, 2);
});

// ── Métricas ─────────────────────────────────────────────────
test('las métricas traen todos los campos y ninguno sobra', () => {
  const esperados = [
    'attempted', 'fetched', 'fetched_bytes', 'mapped',
    'skipped_personal', 'skipped_residential', 'skipped_inactive',
    'skipped_unverifiable', 'skipped_duplicate_existing', 'skipped_invalid',
    'skipped_sensitive', 'deduped', 'retries', 'http429', 'quota_blocked',
    'duration_ms', 'planned_create', 'planned_update', 'planned_noop', 'errors',
    'crm_writes', 'outbound',
  ].sort();
  assert.deepEqual(Object.keys(emptyMetrics()).sort(), esperados);
});

test('un dry-run no escribe en el CRM ni envía nada', async () => {
  const { stateFile, lockFile } = nuevoEstado();
  const { metrics } = await fetchFromSource(FUENTE, {
    baseOverride: 'https://ejemplo.test',
    fetchImpl: fetchMuestra(),
    sleep: async () => {},
    quotaOptions: { stateFile, lockFile },
  });
  assert.equal(metrics.crm_writes, 0);
  assert.equal(metrics.outbound, 0);
});

test('las métricas son recuentos: no llevan filas ni datos personales', async () => {
  const { stateFile, lockFile } = nuevoEstado();
  const { metrics } = await fetchFromSource(FUENTE, {
    baseOverride: 'https://ejemplo.test',
    fetchImpl: fetchMuestra(),
    sleep: async () => {},
    quotaOptions: { stateFile, lockFile },
  });
  const texto = JSON.stringify(metrics);
  for (const aguja of AGUJAS_PROHIBIDAS) assert.ok(!texto.includes(aguja));
  for (const v of Object.values(metrics)) assert.equal(typeof v, 'number', 'una métrica no numérica podría traer datos');
});

// ── Attestation ──────────────────────────────────────────────
const ATT_REAL = loadAttestation(path.join(process.cwd(), 'config', 'source-attestation.json'));

test('la attestation del repositorio valida offline', () => {
  const r = verifyAttestation(ATT_REAL);
  assert.equal(r.valid, true, `problemas: ${r.problems.join('; ')}`);
  assert.equal(r.checks.structure, true);
  assert.equal(r.checks.digest, true);
  assert.equal(r.checks.age, true);
});

test('el verificador no afirma haber comprobado los hashes upstream', () => {
  const r = verifyAttestation(ATT_REAL);
  assert.equal(r.checks.upstreamHashesRecomputed, false,
    'sin red y sin artefactos, afirmarlo sería mentir');
  assert.equal(r.checks.networkFetchPerformed, false);
  assert.equal(r.checks.signature, 'no_aplica_sin_clave_autorizada');
});

test('la attestation recoge la evidencia del 2026-10-04 con sus tres hashes', () => {
  assert.equal(ATT_REAL.evidenceCollectedAt, '2026-10-04T05:11:43.000Z');
  const arts = ATT_REAL.sources[FUENTE].artifacts;
  assert.equal(arts.robots.sha256, '0d8f965679b15e98c0cf18c01a14ab25d5b067fec3ea1d5ebc0db1c1b590ab84');
  assert.equal(arts.metadata.sha256, 'b2d752bb871e0d6dd1544af56694b231a370f794bb39b610947b2eb5658ee5d7');
  assert.equal(arts.sodaSample.sha256, '850f68e3da646726353a2b49199f6bcd9c970d83bcfdeed79dce5f758e27b47d');
  for (const a of Object.values(arts)) assert.equal(a.httpStatus, 200);

  const robots = ATT_REAL.sources[FUENTE].robots;
  assert.equal(robots.crawlDelaySeconds, 1);
  assert.deepEqual(robots.allowedPaths, ['/resource']);
  assert.deepEqual(robots.blockedPaths, ['/OData.svc/', '/api/odata/']);
  assert.equal(ATT_REAL.sources[FUENTE].license.licenseId, 'PUBLIC_DOMAIN');

  // Y deja constancia de que Cloud no fue quien la obtuvo.
  assert.match(ATT_REAL.collectedFrom.note, /NO realizó ninguna petición/);
});

test('tocar un solo byte invalida el digest', () => {
  const alterada = structuredClone(ATT_REAL);
  alterada.sources[FUENTE].artifacts.robots.sha256 = '0'.repeat(64);
  const r = verifyAttestation(alterada);
  assert.equal(r.valid, false);
  assert.ok(r.problems.some((p) => /digest no coincide/.test(p)));
});

test('el digest no depende del orden de las claves', () => {
  const a = { b: 2, a: 1, c: { y: 2, x: 1 } };
  const b = { a: 1, c: { x: 1, y: 2 }, b: 2 };
  assert.equal(canonicalize(a), canonicalize(b));
  assert.equal(computeDigest(a), computeDigest(b));
});

test('una attestation con firma se rechaza por no poder comprobarla', () => {
  const conFirma = structuredClone(ATT_REAL);
  conFirma.signature = 'MEUCIQ...';
  conFirma.digest = computeDigest(conFirma);
  const r = verifyAttestation(conFirma);
  assert.equal(r.valid, false);
  assert.ok(r.problems.some((p) => /no hay clave autorizada/.test(p)));
});

test('una attestation caducada deja de valer', () => {
  const vieja = structuredClone(ATT_REAL);
  vieja.evidenceCollectedAt = '2024-01-01T00:00:00.000Z';
  vieja.digest = computeDigest(vieja);
  const r = verifyAttestation(vieja, { maxAgeDays: 180 });
  assert.equal(r.valid, false);
  assert.ok(r.problems.some((p) => /evidencia de hace/.test(p)));
});

test('una attestation fechada en el futuro también se rechaza', () => {
  const futura = structuredClone(ATT_REAL);
  futura.evidenceCollectedAt = new Date(Date.now() + 10 * 86400000).toISOString();
  futura.digest = computeDigest(futura);
  const r = verifyAttestation(futura);
  assert.equal(r.valid, false);
  assert.ok(r.problems.some((p) => /futuro/.test(p)));
});

test('un hash con forma incorrecta se detecta', () => {
  const mala = structuredClone(ATT_REAL);
  mala.sources[FUENTE].artifacts.robots.sha256 = 'no-es-un-hash';
  mala.digest = computeDigest(mala);
  const r = verifyAttestation(mala);
  assert.equal(r.valid, false);
  assert.ok(r.problems.some((p) => /forma de SHA256/.test(p)));
});

// ── Las demás fuentes siguen cerradas ────────────────────────
test('solo la fuente del condado puede salir a la red', () => {
  const rows = sourceStatus();
  const permitidas = rows.filter((r) => r.allowed).map((r) => r.key);
  assert.deepEqual(permitidas, [FUENTE], `fuentes habilitadas: ${permitidas.join(', ')}`);
});

test('las fuentes City siguen apagadas y sin poder construir URL', async () => {
  for (const key of ['sd_business_tax_certificates', 'sd_development_approvals']) {
    const entry = allowlistEntry(key);
    assert.equal(entry.enabled, false, `${key} quedó habilitada`);
    assert.throws(() => buildUrl(SOURCES[key], {}), /no está implementado/);
    await assert.rejects(
      () => fetchFromSource(key, { baseOverride: 'https://ejemplo.test', fetchImpl: fetchMuestra() }),
      /no está habilitada/,
    );
  }
});

test('los datasets rechazados siguen sin poder construir URL', () => {
  for (const id of ['development-permits-set1', 'business-listings', 'dyzh-7eat', '76h4-nnmj']) {
    assert.throws(
      () => buildUrl({ label: `x ${id}`, accessType: 'soda', domain: 'data.sandiegocounty.gov', dataset: id }, {}),
      /rechazado por la auditoría/,
    );
  }
});

test('el allowlist solo tiene una fuente habilitada', () => {
  const lista = loadAllowlist({ reload: true });
  const habilitadas = Object.entries(lista.sources).filter(([, e]) => e.enabled === true).map(([k]) => k);
  assert.deepEqual(habilitadas, [FUENTE]);
});

// ── Aislamiento del CRM y del outbound ───────────────────────
/**
 * Las métricas dicen `crm_writes: 0`, pero las escribe el mismo código que se
 * está probando. Estas dos pruebas no le creen: levantan un Twenty simulado
 * que registra TODAS las peticiones con su método, y miran ese registro.
 */
test('una corrida de descubrimiento no toca el CRM: ni un GET, ni una escritura', async () => {
  const { createFakeTwenty } = await import('./fixtures/fake-twenty.js');
  const { discover } = await import('../src/prospecting/agents/discover.js');
  const { config } = await import('../src/config.js');

  const fake = await createFakeTwenty({ seed: [] });
  const baseUrlOriginal = config.twenty.baseUrl;
  const fetchOriginal = globalThis.fetch;
  const salidasGlobales = [];

  // El CRM apunta al simulado: si algo del descubrimiento quisiera escribir,
  // iría ahí y quedaría registrado en lugar de fallar en silencio.
  config.twenty.baseUrl = fake.baseUrl;
  // Y cualquier petición que no pase por el fetch inyectado queda anotada.
  globalThis.fetch = async (url, opts = {}) => {
    salidasGlobales.push({ url: String(url), method: opts.method || 'GET' });
    throw new Error('la corrida no debería usar el fetch global');
  };

  try {
    const { stateFile, lockFile } = nuevoEstado();
    const stats = await discover({
      sources: [FUENTE],
      limit: 10,
      baseOverride: 'https://ejemplo.test',
      fetchOptions: {
        fetchImpl: fetchMuestra(),
        sleep: async () => {},
        quotaOptions: { stateFile, lockFile },
      },
    });

    assert.deepEqual(stats.errors, []);
    assert.equal(stats.inserted, 2, 'los dos negocios comerciales');
    assert.equal(stats.metrics.skipped_residential, 1);

    assert.deepEqual(fake.writes(), [], 'hubo escrituras contra el CRM');
    assert.deepEqual(fake.requests, [], 'el descubrimiento ni siquiera leyó del CRM');
    assert.equal(fake.companies.length, 0, 'el CRM cambió de contenido');
    assert.deepEqual(salidasGlobales, [], `salió por el fetch global: ${JSON.stringify(salidasGlobales)}`);

    assert.equal(stats.metrics.crm_writes, 0);
    assert.equal(stats.metrics.outbound, 0);
  } finally {
    globalThis.fetch = fetchOriginal;
    config.twenty.baseUrl = baseUrlOriginal;
    fake.server.close();
  }
});

test('el outbound está apagado por defecto en este flujo', async () => {
  const { config } = await import('../src/config.js');
  assert.equal(config.outbound.enabled, false,
    'OUTBOUND_ENABLED debe seguir en false: ninguna corrida de fuentes envía nada');
});
