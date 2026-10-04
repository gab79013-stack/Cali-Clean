import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

/**
 * Fuentes del área de San Diego: auditoría del 2026-10-03, ampliada el
 * 2026-10-04 con la evidencia que habilitó la fuente del condado.
 *
 * Lo que estas pruebas tienen que demostrar, porque es lo que separa una
 * política escrita de una política aplicada:
 *
 *   · ninguna fuente no habilitada llega a abrir un socket;
 *   · los campos prohibidos no se mapean, no se guardan y no se registran;
 *   · robots y límites de la auditoría están reflejados en el código;
 *   · los ids de dataset inventados no aparecen y no pueden construir URL;
 *   · habilitar exige las DOS capas: decisión humana en el allowlist y
 *     constancia operativa vigente. Tener una no basta.
 *
 * La única fuente habilitada es la del condado. Las de la ciudad siguen
 * apagadas, y el GET condicional que necesitan sigue constando como pendiente.
 */

const attFile = path.join(os.tmpdir(), `cc-att-${Date.now()}.json`);
process.env.SOURCE_ATTESTATION_PATH = attFile;
process.env.DB_PATH = ':memory:';
process.env.APP_SECRET = 'test-sources';
process.env.SERVICE_ZIPS = '92101,92103,92110,92128';
process.env.PROSPECT_CRAWL_DELAY_MS = '0';

const {
  SOURCES, SERVICE_AREA, mapRow, buildUrl, fetchFromSource, sourceStatus,
} = await import('../src/prospecting/sources/index.js');
const {
  checkSourceAllowed, saveAttestation, loadAllowlist, allowlistEntry,
  forbiddenFields, allowedFields, scrubRow, isBannedDataset, rejectionFor,
} = await import('../src/prospecting/sources/compliance.js');
const { isInServiceArea } = await import('../src/services/scoring.js');
const { config } = await import('../src/config.js');
const { verifyMatch } = await import('../src/prospecting/agents/enrich.js');

test.after(() => fs.rmSync(attFile, { force: true }));

const ALLOWLIST = loadAllowlist();
const IDS_INVENTADOS = ['development-permits-set1', 'business-listings'];

// ── La evidencia de la auditoría está donde debe ─────────────
test('el allowlist registra la auditoría con fecha y método', () => {
  assert.equal(ALLOWLIST.auditedAt, '2026-10-03');
  assert.equal(ALLOWLIST.timezone, 'America/Los_Angeles');
  assert.ok(ALLOWLIST.auditMethod);
  assert.ok(Object.keys(ALLOWLIST.sources).length >= 3);
  assert.ok(Object.keys(ALLOWLIST.rejected).length >= 5);
});

test('cada fuente declara licencia, robots, límites y decisión', () => {
  for (const [k, e] of Object.entries(ALLOWLIST.sources)) {
    assert.ok(e.license?.name, `${k} sin licencia`);
    assert.ok(e.license?.termsUrl?.startsWith('https://'), `${k} sin URL de términos`);
    assert.ok(e.robots, `${k} sin evidencia de robots`);
    assert.ok(e.rateLimit?.internalPolicy, `${k} sin política de caudal`);
    assert.ok(e.decision, `${k} sin decisión razonada`);
    assert.ok(Array.isArray(e.fields?.allowed) && e.fields.allowed.length, `${k} sin campos permitidos`);
    assert.ok(Array.isArray(e.fields?.forbidden), `${k} sin lista de prohibidos`);
    assert.equal(typeof e.eligible, 'boolean');
    assert.equal(typeof e.enabled, 'boolean');
  }
});

// ── Elegible no es habilitada ────────────────────────────────
test('solo la fuente del condado está habilitada', () => {
  const habilitadas = Object.entries(ALLOWLIST.sources)
    .filter(([, e]) => e.enabled === true)
    .map(([k]) => k);
  assert.deepEqual(habilitadas, ['sdcounty_food_facility_permits'],
    `habilitadas: ${habilitadas.join(', ') || 'ninguna'}`);

  // Y la que se habilitó dejó constancia de por qué y de qué lo resolvió.
  const county = ALLOWLIST.sources.sdcounty_food_facility_permits;
  assert.equal(county.state, 'ENABLED');
  assert.equal(county.enabledAt, '2026-10-04');
  assert.deepEqual(county.blockers, [], 'queda un bloqueo sin resolver');
  assert.equal(county.resolvedBlockers.length, 3);
  for (const r of county.resolvedBlockers) {
    assert.ok(r.resolvedBy, 'un bloqueo resuelto sin decir con qué');
    assert.ok(r.testedBy, 'un bloqueo resuelto sin prueba que lo sostenga');
  }
});

test('las tres son elegibles; solo la del condado puede salir a la red', () => {
  for (const [k, source] of Object.entries(SOURCES)) {
    const entry = allowlistEntry(k);
    assert.equal(entry.eligible, true, `${k} debería ser elegible`);
    const c = checkSourceAllowed(k, source, { attestations: {} });

    if (k === 'sdcounty_food_facility_permits') {
      // Pasa por la constancia importada, que se comprueba sin red.
      assert.equal(c.allowed, true, `la fuente habilitada quedó bloqueada: ${c.reason}`);
      assert.equal(c.attestationKind, 'hash-based-imported');
      continue;
    }
    assert.equal(c.allowed, false, `${k} podría salir a la red`);
    assert.equal(c.eligible, true, 'la puerta debe distinguir elegible de habilitada');
    assert.equal(c.reason, 'no_habilitada');
  }
});

test('una constancia operativa válida no basta para habilitar', () => {
  // Este es el punto del diseño: verificar no enciende. La decisión de
  // encender es humana y vive en el allowlist. Se prueba sobre una fuente que
  // sigue apagada, porque es ahí donde la distinción importa.
  saveAttestation('sd_business_tax_certificates', {
    robotsAllowed: true, endpointVerified: true, termsReviewed: true,
    verifiedAt: new Date().toISOString(),
  });
  const c = checkSourceAllowed('sd_business_tax_certificates', SOURCES.sd_business_tax_certificates);
  assert.equal(c.allowed, false);
  assert.equal(c.reason, 'no_habilitada');
});

test('habilitada en el allowlist pero sin constancia tampoco sale', () => {
  // La fuente del condado está habilitada de verdad, así que para probar esta
  // mitad de la puerta hay que quitarle la constancia: se apunta la attestation
  // importada a un archivo que no existe y se pasa un juego local vacío.
  const original = process.env.SOURCE_ATTESTATION_FILE;
  process.env.SOURCE_ATTESTATION_FILE = path.join(os.tmpdir(), `cc-sin-att-${Date.now()}.json`);
  try {
    const c = checkSourceAllowed('sdcounty_food_facility_permits', SOURCES.sdcounty_food_facility_permits, {
      attestations: {},
    });
    assert.equal(c.allowed, false, 'salió a la red sin constancia operativa');
    assert.equal(c.reason, 'sin_constancia_operativa');
  } finally {
    if (original === undefined) delete process.env.SOURCE_ATTESTATION_FILE;
    else process.env.SOURCE_ATTESTATION_FILE = original;
  }
});

test('un acceso no implementado bloquea aunque esté habilitada', () => {
  // La fuente de certificados ya tiene el acceso csv-static implementado, así
  // que esta comprobación se hace sobre la que sigue sin tenerlo. La puerta
  // mira `implemented` antes que `leadUseAllowed`, y por eso el motivo es este
  // y no "solo_investigacion".
  const fake = structuredClone(ALLOWLIST);
  fake.sources.sd_development_approvals.enabled = true;
  const c = checkSourceAllowed('sd_development_approvals', SOURCES.sd_development_approvals, {
    allowlist: fake, attestations: {},
  });
  assert.equal(c.allowed, false);
  assert.equal(c.reason, 'acceso_no_implementado');
  loadAllowlist({ reload: true });
});

test('el acceso csv-static ya está implementado para la fuente de la ciudad', () => {
  const entry = allowlistEntry('sd_business_tax_certificates');
  assert.equal(entry.implemented, true);
  assert.equal(entry.enabled, false, 'implementado no es habilitado');
  assert.equal(entry.accessType, 'csv-static');
  // Y la URL permitida es UN recurso, no un dominio.
  assert.deepEqual(entry.robots.allowedResources, [SOURCES.sd_business_tax_certificates.downloadUrl]);
  assert.equal(entry.robots.htmlCrawlingAllowed, false);
});

test('research-only no puede producir leads ni estando habilitada y verificada', () => {
  const fake = structuredClone(ALLOWLIST);
  fake.sources.sd_development_approvals.enabled = true;
  fake.sources.sd_development_approvals.implemented = true;
  const att = {
    sd_development_approvals: {
      robotsAllowed: true, endpointVerified: true, termsReviewed: true,
      verifiedAt: new Date().toISOString(),
    },
  };
  const c = checkSourceAllowed('sd_development_approvals', SOURCES.sd_development_approvals, {
    allowlist: fake, attestations: att,
  });
  assert.equal(c.allowed, false);
  assert.equal(c.reason, 'solo_investigacion');
  loadAllowlist({ reload: true });
});

// ── Ninguna fuente no habilitada abre un socket ──────────────
test('una fuente no habilitada no llega a hacer la petición', async () => {
  let touched = false;
  const server = http.createServer((req, res) => { touched = true; res.end('[]'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const apagadas = Object.keys(SOURCES).filter((k) => allowlistEntry(k).enabled !== true);
  assert.equal(apagadas.length, 2, 'se esperaban dos fuentes apagadas');
  try {
    for (const key of apagadas) {
      await assert.rejects(
        () => fetchFromSource(key, { baseOverride: base }),
        /no está habilitada/,
        `${key} debería haber sido bloqueada`,
      );
    }
    assert.equal(touched, false, 'alguna fuente salió a la red sin estar habilitada');
  } finally {
    server.close();
  }
});

// ── Ids inventados y datasets rechazados ─────────────────────
test('los ids inventados no aparecen en ninguna definición', () => {
  const definiciones = JSON.stringify(SOURCES);
  for (const id of IDS_INVENTADOS) {
    assert.ok(!definiciones.includes(id), `el id inventado "${id}" sigue en las definiciones`);
  }
  for (const s of Object.values(SOURCES)) {
    assert.ok(!IDS_INVENTADOS.includes(s.dataset), `dataset inventado en ${s.label}`);
  }
});

test('los datasets rechazados están registrados con su motivo', () => {
  for (const id of [...IDS_INVENTADOS, 'dyzh-7eat', '76h4-nnmj']) {
    assert.equal(isBannedDataset(id), true, `${id} debería estar prohibido`);
    assert.ok(rejectionFor(id)?.reason, `${id} sin motivo registrado`);
  }
  assert.match(rejectionFor('dyzh-7eat').reason, /obsoleto|2023|2024/i);
  assert.match(rejectionFor('76h4-nnmj').reason, /licencia|personales/i);
});

test('un dataset rechazado no puede construir URL', () => {
  for (const id of [...IDS_INVENTADOS, 'dyzh-7eat', '76h4-nnmj']) {
    const inventada = { label: `prueba ${id}`, accessType: 'soda', domain: 'data.sandiegocounty.gov', dataset: id };
    assert.throws(() => buildUrl(inventada, {}), /rechazado por la auditoría/, `${id} construyó URL`);
  }
});

test('un accessType sin implementar falla diciéndolo, no devolviendo vacío', () => {
  for (const key of ['sd_business_tax_certificates', 'sd_development_approvals']) {
    assert.equal(SOURCES[key].accessType, 'csv-static');
    assert.throws(() => buildUrl(SOURCES[key], {}), /no está implementado/);
  }
});

// ── Campos prohibidos: ni mapeados, ni guardados, ni registrados ──
test('el $select pide solo los campos permitidos', () => {
  const params = SOURCES.sdcounty_food_facility_permits.query({ sinceDays: 90, limit: 50 });
  const pedidos = params.$select.split(',');
  assert.deepEqual(pedidos, allowedFields('sdcounty_food_facility_permits'));
  for (const prohibido of forbiddenFields('sdcounty_food_facility_permits')) {
    assert.ok(!pedidos.includes(prohibido), `el $select pide el campo prohibido ${prohibido}`);
    assert.ok(!params.$select.includes(prohibido), `${prohibido} aparece en el $select`);
  }
});

test('la política de 50 filas se aplica aunque pidan más', () => {
  const params = SOURCES.sdcounty_food_facility_permits.query({ limit: 500 });
  assert.equal(params.$limit, '50');
});

test('scrubRow quita los campos prohibidos de una fila', () => {
  const fila = {
    record_id: 'R-1', record_name: 'Taquería del Puerto', address: '990 Main St',
    permit_owner_full: 'Juan Pérez García', permit_owner: 'J. Pérez',
    permit_owner_email: 'juan@ejemplo.com', latitude: 32.71, longitude: -117.16,
  };
  const limpia = scrubRow('sdcounty_food_facility_permits', fila);
  for (const f of ['permit_owner_full', 'permit_owner', 'permit_owner_email', 'latitude', 'longitude']) {
    assert.ok(!(f in limpia), `${f} sobrevivió al filtrado`);
  }
  assert.equal(limpia.record_name, 'Taquería del Puerto', 'no debe tirar lo permitido');
  const serializada = JSON.stringify(limpia);
  assert.ok(!serializada.includes('Juan Pérez'), 'el nombre de persona quedó en la fila');
  assert.ok(!serializada.includes('juan@ejemplo.com'));
});

test('un campo prohibido no llega al prospecto mapeado ni a su rastro', () => {
  const fila = {
    record_id: 'R-2', record_name: 'Panadería Balboa', address: '500 Park Blvd',
    city: 'San Diego', zip: '92101', record_open_date: '2026-09-20T00:00:00.000',
    business_type: 'Food Facility',
    permit_owner_full: 'María Soledad Ruiz', permit_owner_email: 'maria@ejemplo.com',
    latitude: 32.73, longitude: -117.14,
  };
  const m = mapRow(SOURCES.sdcounty_food_facility_permits, fila, 'sdcounty_food_facility_permits');
  const todo = JSON.stringify(m);
  for (const aguja of ['María Soledad', 'maria@ejemplo.com', '32.73', '-117.14', 'permit_owner']) {
    assert.ok(!todo.includes(aguja), `"${aguja}" se coló en el prospecto mapeado`);
  }
  assert.equal(m.businessName, 'Panadería Balboa');
  assert.equal(m.zip, '92101');
});

test('el titular del permiso de la ciudad no se mapea', () => {
  const fila = {
    APPROVAL_ID: 'A-77', PROJECT_TITLE: 'Tenant Improvement Harbor Dr',
    GIS_ADDRESS: '2100 Harbor Dr', APPROVAL_CREATE_DATE: '2026-09-28',
    APPROVAL_SCOPE: 'Interior remodel', APPROVAL_VALUATION: '310000',
    APPROVAL_PERMIT_HOLDER: 'Roberto Núñez',
  };
  const m = mapRow(SOURCES.sd_development_approvals, fila, 'sd_development_approvals');
  assert.ok(!JSON.stringify(m).includes('Roberto Núñez'), 'el titular acabó en el prospecto');
  assert.equal(m.businessName, 'Tenant Improvement Harbor Dr');
  assert.equal(m.contactName, '', 'un registro público no aporta contacto');
});

test('el titular del certificado municipal no es un campo mapeable', () => {
  // Esta fuente no pasa por `mapRow`: su mapeo vive en el ejecutor csv-static,
  // donde el titular se lee de paso y muere en la misma iteración. Lo que aquí
  // se comprueba es que no haya ninguna ruta por la que pudiera salir: ni
  // declarado como campo de la fuente, ni permitido por la auditoría.
  const definicion = JSON.stringify(SOURCES.sd_business_tax_certificates);
  assert.ok(!definicion.includes('business_owner_name'),
    'el titular aparece en la definición de la fuente');
  assert.ok(!definicion.includes('address_suite') && !definicion.includes('lat'),
    'un campo prohibido aparece en la definición');

  const entry = allowlistEntry('sd_business_tax_certificates');
  assert.ok(!entry.fields.allowed.includes('business_owner_name'));
  assert.ok(entry.fields.forbidden.includes('business_owner_name'));
  for (const f of ['lat', 'lng', 'address_pmb_box', 'address_po_box', 'address_suite', 'address_no_fraction']) {
    assert.ok(entry.fields.forbidden.includes(f), `${f} debería estar prohibido`);
  }
  // Y queda escrito que su único uso es efímero, para que nadie lo reinterprete.
  assert.match(entry.fields.ephemeralOnly.business_owner_name, /Nunca se mapea/);
});

test('los campos prohibidos nunca se registran en un log', () => {
  const fila = {
    record_id: 'R-3', record_name: 'Café Hillcrest', address: '1 Fifth Ave',
    permit_owner_full: 'Persona Identificable', permit_owner_email: 'x@ejemplo.com',
  };
  const impreso = [];
  const origLog = console.log; const origErr = console.error;
  console.log = (...a) => impreso.push(a.join(' '));
  console.error = (...a) => impreso.push(a.join(' '));
  try {
    const limpia = scrubRow('sdcounty_food_facility_permits', fila);
    console.log(`fila procesada: ${JSON.stringify(limpia)}`);
    console.log(`campos: ${Object.keys(limpia).join(', ')}`);
  } finally {
    console.log = origLog; console.error = origErr;
  }
  for (const linea of impreso) {
    assert.ok(!linea.includes('Persona Identificable'), `se registró un dato personal: ${linea}`);
    assert.ok(!linea.includes('x@ejemplo.com'));
    assert.ok(!linea.includes('permit_owner'));
  }
});

// ── Robots y política de caudal reflejados ───────────────────
test('la evidencia de robots coincide con lo auditado', () => {
  const county = allowlistEntry('sdcounty_food_facility_permits').robots;
  assert.equal(county.portalRobotsStatus, 200);
  assert.equal(county.crawlDelaySeconds, 1);
  assert.equal(county.resourcePathAllowed, true);
  assert.equal(county.odataPathBlocked, true);

  for (const k of ['sd_business_tax_certificates', 'sd_development_approvals']) {
    const r = allowlistEntry(k).robots;
    assert.equal(r.portalRobotsStatus, 404);
    assert.equal(r.downloadRobotsStatus, 403);
    assert.ok(r.interpretation, 'una situación ambigua tiene que llevar su razonamiento');
  }
});

test('solo se usa SODA en /resource, nunca OData', () => {
  const url = buildUrl(SOURCES.sdcounty_food_facility_permits, { $limit: '1' });
  assert.ok(url.includes('/resource/c5ez-ufrd.json'));
  assert.ok(!/odata/i.test(url), 'robots.txt del condado bloquea OData');
});

test('el crawl-delay efectivo no baja del declarado por el portal', () => {
  const declarado = allowlistEntry('sdcounty_food_facility_permits').robots.crawlDelaySeconds * 1000;
  const politica = allowlistEntry('sdcounty_food_facility_permits').rateLimit.internalPolicy.minDelayMs;
  assert.ok(politica >= declarado, 'la política interna es más laxa que el robots.txt del portal');
  assert.equal(politica, 2000);
});

test('la política de caudal registra lo que exige la auditoría', () => {
  const county = allowlistEntry('sdcounty_food_facility_permits').rateLimit;
  assert.equal(county.internalPolicy.maxRowsPerRun, 50);
  assert.equal(county.internalPolicy.maxRunsPerDay, 1);
  assert.equal(county.internalPolicy.respectRetryAfter, true);
  assert.equal(county.throttleSignal, 'HTTP 429');
  assert.equal(county.tokenRequired, false);

  // La ciudad ya tiene política implementada, con los nombres precisos de lo
  // que el código hace cumplir.
  const city = allowlistEntry('sd_business_tax_certificates').rateLimit.internalPolicy;
  assert.equal(city.maxValidCandidatesPerRun, 50);
  assert.equal(city.maxSuccessfulRunsPer24h, 1);
  assert.equal(city.requestsPerRun, 1);
  assert.deepEqual(city.conditionalGet, ['If-None-Match', 'If-Modified-Since']);
  assert.equal(city.htmlCrawling, false);
  assert.match(city.durableQuotaAuthority, /city-btc:/);

  // La de research-only sigue como estaba: no se ha tocado.
  const research = allowlistEntry('sd_development_approvals').rateLimit.internalPolicy;
  assert.equal(research.maxDownloadsPerDay, 1);
  assert.deepEqual(research.conditionalGet, ['If-None-Match', 'If-Modified-Since']);
  assert.equal(research.htmlCrawling, false);
});

// ── Requisitos pendientes: constan, y no activan nada ────────
test('el 429 y la cuota constan como resueltos; el GET condicional sigue pendiente', () => {
  // Lo que antes era un bloqueo pendiente ahora tiene que constar como
  // resuelto y con la prueba que lo sostiene. Lo que sigue faltando tiene que
  // seguir visible, y seguir impidiendo que la fuente que lo necesita se
  // encienda.
  const county = allowlistEntry('sdcounty_food_facility_permits');
  const resueltos = county.resolvedBlockers.map((r) => r.blocker).join(' | ');
  assert.match(resueltos, /429|Retry-After/i, 'el 429 no consta como resuelto');
  assert.match(resueltos, /1 corrida|corrida\/día|corrida al día/i, 'la cuota no consta como resuelta');
  assert.deepEqual(county.blockers, []);

  const pruebas = county.resolvedBlockers.map((r) => r.testedBy);
  assert.ok(pruebas.includes('test/soda-quota.test.js'));

  // La ciudad resolvió el GET condicional, y ahora lo que la mantiene apagada es
  // otra cosa: la decisión operativa y el egress. Los dos constan.
  const city = allowlistEntry('sd_business_tax_certificates');
  const cityResueltos = city.resolvedBlockers.map((r) => r.blocker).join(' | ');
  assert.match(cityResueltos, /ETag|If-None-Match|csv-static/i, 'el GET condicional no consta como resuelto');
  assert.ok(city.blockers.some((b) => /egress|dominio/i.test(b)), 'el egress pendiente tiene que constar');
  assert.ok(city.blockers.some((b) => /decisión operativa|preview/i.test(b)));
  assert.equal(city.enabled, false, 'sigue apagada hasta que alguien la encienda a mano');

  // La de research-only sigue con su bloqueo de GET condicional abierto.
  const research = allowlistEntry('sd_development_approvals');
  assert.ok(research.blockers.some((b) => /ETag|If-None-Match|condicional|implementado/i.test(b)));
  assert.equal(research.enabled, false);
});

test('el código no finge soportar el GET condicional', async () => {
  // Si algún día apiFetch aprende ETag, esta prueba falla y obliga a actualizar
  // el allowlist en lugar de dejar la evidencia mintiendo.
  const http2 = await import('../src/prospecting/http.js');
  assert.equal(typeof http2.apiFetch, 'function');
  const src = fs.readFileSync(new URL('../src/prospecting/http.js', import.meta.url), 'utf8');
  const soporta = /If-None-Match|If-Modified-Since|retry-after/i.test(src);
  assert.equal(soporta, false,
    'apiFetch ya soporta GET condicional o Retry-After: actualiza config/source-allowlist.json');
});

test('sourceStatus separa elegible, habilitada e implementada', () => {
  const rows = sourceStatus();
  assert.equal(rows.length, 3);
  for (const r of rows) {
    assert.equal(r.eligible, true);
    assert.ok(r.state);
    assert.ok(r.license);
    assert.ok(Array.isArray(r.forbiddenFields));
    // Habilitada y permitida van juntas: la única habilitada es la única que
    // puede salir, y las demás no pueden por no estarlo.
    assert.equal(r.allowed, r.enabled, `${r.key}: enabled=${r.enabled} pero allowed=${r.allowed}`);
  }
  const county = rows.find((r) => r.key === 'sdcounty_food_facility_permits');
  assert.equal(county.enabled, true);
  assert.equal(county.allowed, true);
  assert.equal(county.implemented, true, 'SODA sí está implementado');
  assert.equal(county.configured, true, 'es la fuente por defecto');
  for (const r of rows.filter((x) => x.key !== county.key)) {
    assert.equal(r.enabled, false, `${r.key} quedó habilitada`);
    assert.equal(r.reason, 'no_habilitada');
  }
  const csv = rows.filter((r) => r.accessType === 'csv-static');
  assert.equal(csv.length, 2);
  const city = csv.find((r) => r.key === 'sd_business_tax_certificates');
  assert.equal(city.implemented, true, 'csv-static ya está implementado');
  assert.equal(city.enabled, false, 'y sigue apagada: implementar no es habilitar');
  const research = csv.find((r) => r.key === 'sd_development_approvals');
  assert.equal(research.implemented, false);
});

// ── Catálogo y área ──────────────────────────────────────────
test('el catálogo es de San Diego y declara su área de servicio', () => {
  // Dos áreas, y la diferencia es real: los permisos del condado cubren todo el
  // condado, y los certificados de actividad son del término municipal. Decir
  // "San Diego County" de un negocio del centro de la ciudad sería menos
  // preciso, no más.
  const AREAS = ['San Diego County, CA', 'San Diego'];
  for (const [k, s] of Object.entries(SOURCES)) {
    assert.ok(/sandiego|datasd/i.test(s.domain), `${k} no apunta a un portal de San Diego`);
    assert.ok(AREAS.includes(s.serviceArea), `${k} declara un área inesperada: ${s.serviceArea}`);
    assert.ok(!/^(la|sf)_/.test(k), `quedó una fuente de LA/SF: ${k}`);
  }
  assert.equal(SOURCES.sdcounty_food_facility_permits.serviceArea, SERVICE_AREA);
  assert.equal(SOURCES.sd_business_tax_certificates.serviceArea, 'San Diego');
});

test('las fuentes por defecto existen en el catálogo', () => {
  for (const k of config.prospecting.sources) {
    assert.ok(SOURCES[k], `la fuente por defecto "${k}" no existe`);
  }
});

test('los nombres con tilde y con apóstrofo se capitalizan bien', () => {
  // Con una frontera de palabra ASCII, "panadería" salía "PanaderíA": el
  // nombre del cliente mal escrito en el CRM desde el primer día.
  const nombre = (raw) => mapRow(
    SOURCES.sdcounty_food_facility_permits,
    { record_id: 'R', record_name: raw, address: '1 Main St' },
    'sdcounty_food_facility_permits',
  ).businessName;

  assert.equal(nombre('PANADERÍA BALBOA'), 'Panadería Balboa');
  assert.equal(nombre('taquería el faro'), 'Taquería El Faro');
  assert.equal(nombre('NIÑOS Y MÁS'), 'Niños Y Más');
  assert.equal(nombre("MIGUEL'S COCINA"), "Miguel's Cocina", 'el apóstrofo no parte la palabra');
  assert.equal(nombre("O'BRIEN PLUMBING"), "O'Brien Plumbing", 'salvo en los prefijos de apellido');
  assert.equal(nombre('harbor view dental'), 'Harbor View Dental');
});

test('una fila sin los campos obligatorios se descarta, no se completa', () => {
  assert.equal(mapRow(SOURCES.sdcounty_food_facility_permits, { columna_rara: 'x' }, 'sdcounty_food_facility_permits'), null);
  assert.equal(mapRow(SOURCES.sd_development_approvals, { PROJECT_TITLE: 'Solo título' }, 'sd_development_approvals'), null,
    'falta la dirección');
});

test('la consulta del condado filtra por permiso activo, no por fecha', () => {
  // Por qué no por fecha: record_open_date está vacío en las 15 906 filas del
  // dataset, así que cualquier ventana devuelve 0. Era la causa del cero de la
  // Routine del 2026-10-04.
  const params = SOURCES.sdcounty_food_facility_permits.query({ limit: 25 });
  assert.ok(!/record_open_date/.test(params.$where),
    'volvió el filtro por una fecha que el dataset no tiene');
  assert.match(params.$where, /active_permit = 'A'/);
  assert.match(params.$where, /permit_status in \('Issued', 'Permit Renewed'\)/);
  assert.ok(!/Expired/.test(params.$where), 'las expiradas no se piden');
  assert.equal(params.$order, 'last_updated DESC, record_id DESC');
  assert.equal(params.$limit, '25');

  const url = buildUrl(SOURCES.sdcounty_food_facility_permits, params);
  assert.ok(url.startsWith('https://data.sandiegocounty.gov/resource/c5ez-ufrd.json?'));
});

test('el cursor entra en el $where escapado y nunca por encima de 50 filas', () => {
  const conCursor = SOURCES.sdcounty_food_facility_permits.query({ limit: 500, cursor: "DEH'2026" });
  assert.match(conCursor.$where, /record_id < 'DEH''2026'/,
    'una comilla en un identificador del portal tiene que quedar escapada');
  assert.equal(conCursor.$limit, '50', 'el tope de la política interna no se puede pedir más alto');

  const sinCursor = SOURCES.sdcounty_food_facility_permits.query({ limit: 10 });
  assert.ok(!/record_id </.test(sinCursor.$where), 'sin cursor no se añade cláusula');
});

test('el filtro de área acepta San Diego y rechaza lo de fuera', () => {
  assert.equal(isInServiceArea('92101'), true);
  assert.equal(isInServiceArea('92128'), true);
  assert.equal(isInServiceArea('90026'), false, 'un ZIP de Los Ángeles no es área de servicio');
  assert.equal(isInServiceArea('94110'), false, 'ni uno de San Francisco');
});

test('un teléfono suelto no basta para emparejar una web', () => {
  const soloTelefono = verifyMatch('<p>Llame al (619) 555-0142</p>', {
    businessName: 'Harbor View Dental', phone: '+16195550142', zip: '92101', address: '2100 Harbor Dr',
  });
  assert.equal(soloTelefono.matched, false, 'un solo dato puede ser de un agregador');

  const dosSenales = verifyMatch('<p>Harbor View Dental · 2100 Harbor Dr, 92101</p>', {
    businessName: 'Harbor View Dental', zip: '92101', address: '2100 Harbor Dr',
  });
  assert.equal(dosSenales.matched, true);
  assert.ok(dosSenales.evidence.length >= 2);
});
