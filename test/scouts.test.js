import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Fase 3: los tres scouts y la capa central.
 *
 * Lo que estas pruebas tienen que demostrar, porque es lo que separa una política
 * de un comentario:
 *
 *   · ningún scout escribe en el CRM, y no puede: no importa el adaptador;
 *   · ni un dato personal sobrevive — ni al staging, ni a un log, ni al texto de
 *     un error;
 *   · un portal que responde HTML en vez de CSV, que redirige, que pagina mal o
 *     que rota un recurso NO produce datos a medias;
 *   · las cuotas y los guards de los tres son independientes entre sí y de
 *     County/City;
 *   · la deduplicación cruzada es determinista y su prioridad está razonada;
 *   · la capa central no escribe por defecto y rechaza todo lo que la fase prohíbe.
 *
 * Los manifiestos versionados tienen los tres scouts APAGADOS. Estas pruebas usan
 * copias con enabled=true y una attestation sin evidencia pendiente, porque el
 * pipeline se ejercita cruzando la puerta de verdad, no esquivándola.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-scouts-'));
const manifestDir = path.join(tmpDir, 'scouts');
const attDir = path.join(tmpDir, 'att');
fs.mkdirSync(manifestDir, { recursive: true });
fs.mkdirSync(attDir, { recursive: true });

const SCOUTS = ['cslb_contractors', 'hud_multifamily', 'hcai_facilities'];
const SLUG = { cslb_contractors: 'cslb', hud_multifamily: 'hud', hcai_facilities: 'hcai' };

// Manifiestos: copia del real con enabled=true.
for (const id of SCOUTS) {
  const m = JSON.parse(fs.readFileSync(new URL(`../config/scouts/${id}.json`, import.meta.url), 'utf8'));
  m.enabled = true;
  m.state = 'ENABLED';
  fs.writeFileSync(path.join(manifestDir, `${id}.json`), JSON.stringify(m, null, 2));
}
process.env.SCOUT_MANIFEST_DIR = manifestDir;
process.env.SCOUT_STAGING_DIR = path.join(tmpDir, 'staging');
process.env.SOURCE_CSV_TMP_DIR = path.join(tmpDir, 'csv');
process.env.SOURCE_RUNTIME_STATE_PATH = path.join(tmpDir, 'state.json');
process.env.SOURCE_SESSION_ID = 'sesion-scouts';
process.env.DB_PATH = ':memory:';
process.env.APP_SECRET = 'test-scouts';
process.env.OUTBOUND_ENABLED = 'false';
fs.mkdirSync(process.env.SOURCE_CSV_TMP_DIR, { recursive: true });

// Attestations: copia de las reales con la evidencia resuelta, para poder cruzar
// la puerta. El digest se recomputa, porque si no, no valdrían.
const { computeDigest } = await import('../src/prospecting/sources/attestation.js');
for (const id of SCOUTS) {
  const a = JSON.parse(fs.readFileSync(new URL(`../config/source-attestation-${SLUG[id]}.json`, import.meta.url), 'utf8'));
  for (const art of Object.values(a.sources[id].artifacts)) {
    delete art.evidencePending;
    art.sha256 = 'a'.repeat(64);
    art.sha256Scope = 'fixture de prueba';
  }
  a.collectedFrom.liveVerifiedFromCloud = true;
  a.digest = computeDigest(a);
  fs.writeFileSync(path.join(attDir, `source-attestation-${SLUG[id]}.json`), JSON.stringify(a, null, 2));
}
process.env.SOURCE_ATTESTATION_FILES = SCOUTS
  .map((id) => path.join(attDir, `source-attestation-${SLUG[id]}.json`)).join(',');

const registry = await import('../src/prospecting/scouts/registry.js');
const { runScout, trimToAllowed, assertOnlyAllowed } = await import('../src/prospecting/scouts/run.js');
const staging = await import('../src/prospecting/scouts/staging.js');
const intake = await import('../src/prospecting/scouts/intake.js');
const rules = await import('../src/prospecting/scouts/rules.js');
const { queryArcgis, ArcgisError } = await import('../src/prospecting/scouts/arcgis-client.js');
const { queryDatastore, CkanError, buildSql, sqlLiteral } = await import('../src/prospecting/scouts/ckan-client.js');
const { downloadMasterCsv, extractFormTokens, WebFormsError } = await import('../src/prospecting/scouts/webforms-client.js');
const quota = await import('../src/prospecting/sources/quota.js');
const { checkDurableQuota } = await import('../src/prospecting/sources/durable-quota.js');
const fx = await import('./fixtures/fake-scouts.js');

test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const nuevoEstado = () => {
  const f = path.join(tmpDir, `q-${Math.random().toString(36).slice(2)}.json`);
  return { stateFile: f, lockFile: `${f}.lock` };
};
const CIUDADES = ['San Diego', 'Chula Vista', 'Oceanside', 'Escondido'];
const ZIPS = ['92101', '92103', '92111', '92123', '91910'];

/** Corre un scout contra su portal simulado y devuelve el resultado. */
async function corre(scoutId, servidor, extra = {}) {
  const override = {
    cslb_contractors: { portalUrlOverride: servidor.portalUrl },
    hud_multifamily: { queryUrlOverride: servidor.queryUrl },
    hcai_facilities: { sqlEndpointOverride: servidor.sqlEndpoint },
  }[scoutId];
  return runScout(scoutId, {
    ...override,
    cities: CIUDADES,
    zips: ZIPS,
    quotaOptions: nuevoEstado(),
    userAgent: 'CaliCleanProspector/1.0 (+https://cali-clean.net)',
    sleep: async () => {},
    ...extra,
  });
}

// ══ Estado versionado: los tres apagados ══════════════════════
test('en el repositorio los tres scouts están apagados y fallan cerrados', () => {
  for (const id of SCOUTS) {
    const m = JSON.parse(fs.readFileSync(new URL(`../config/scouts/${id}.json`, import.meta.url), 'utf8'));
    assert.equal(m.enabled, false, `${id} quedó habilitado en el repositorio`);
    assert.equal(m.eligible, true);
    assert.equal(m.implemented, true, 'implementado no es habilitado');
    assert.ok(m.blockers.some((b) => /egress/i.test(b)), `${id} no declara el egress pendiente`);
  }
});

test('la evidencia versionada está pendiente, así que la puerta no se abriría ni encendiéndolos', async () => {
  // Se mira la attestation REAL del repositorio, no la del fixture.
  const { attestationFor } = await import('../src/prospecting/sources/attestation.js');
  for (const id of SCOUTS) {
    const file = path.join(process.cwd(), 'config', `source-attestation-${SLUG[id]}.json`);
    const r = attestationFor(id, { file });
    assert.equal(r.ok, false, `${id}: la evidencia pendiente tendría que invalidar`);
    assert.match(r.problems.join('; '), /evidencia está pendiente|evidencia ausente/);
  }
});

test('los hosts que harían falta para una preview real son exactamente tres', () => {
  assert.deepEqual(registry.requiredEgressHosts(), ['web.cslb.ca.gov', 'egis.hud.gov', 'data.chhs.ca.gov']);
});

// ══ Guard duro del outbound ═══════════════════════════════════
test('el guard del outbound lanza, no devuelve un valor que se pueda ignorar', () => {
  assert.equal(registry.assertOutboundDisabled({ outbound: { enabled: false } }), true);
  for (const malo of [{ outbound: { enabled: true } }, { outbound: {} }, {}, null]) {
    assert.throws(() => registry.assertOutboundDisabled(malo), /OUTBOUND_ENABLED/);
  }
});

// ══ 1. CSLB · WebForms ════════════════════════════════════════
test('la secuencia de WebForms es exactamente la auditada', async () => {
  const s = await fx.createFakeCslbServer();
  try {
    const r = await corre('cslb_contractors', s);
    assert.equal(r.blocked, null);
    // GET de tokens, postback de selección, postback del CSV. Tres, en ese orden.
    assert.equal(s.requests.length, 3, `hubo ${s.requests.length} peticiones`);
    assert.equal(s.requests[0].method, 'GET');
    assert.equal(s.requests[1].eventTarget, 'ddlDataType');
    assert.equal(s.requests[1].dataType, 'M');
    assert.equal(s.requests[2].eventTarget, 'lbMasterCSV');
    // Los tokens se renuevan: el segundo postback usa los del primero.
    assert.equal(s.requests[2].viewstate, 'VS-2', 'se reutilizó un __VIEWSTATE caducado');
    assert.ok(s.requests.every((q) => q.userAgent), 'sin User-Agent no se identifica quién pide');
  } finally { s.close(); }
});

test('un redirect en la descarga se rechaza en lugar de seguirse', async () => {
  const s = await fx.createFakeCslbServer({ mode: 'redirect' });
  try {
    await assert.rejects(() => corre('cslb_contractors', s), (err) => {
      assert.equal(err.name, 'WebFormsError');
      assert.equal(err.code, 'REDIRECT_REJECTED');
      return true;
    });
  } finally { s.close(); }
});

test('si el portal responde HTML en vez de CSV, no se parsea como datos', async () => {
  const s = await fx.createFakeCslbServer({ mode: 'htmlInsteadOfCsv' });
  try {
    await assert.rejects(() => corre('cslb_contractors', s), (err) => {
      assert.equal(err.code, 'NOT_CSV');
      assert.match(err.message, /página de error/);
      return true;
    });
  } finally { s.close(); }
});

test('un adjunto que no es el esperado se rechaza', async () => {
  const s = await fx.createFakeCslbServer({ mode: 'wrongAttachment' });
  try {
    await assert.rejects(() => corre('cslb_contractors', s), /WRONG_ATTACHMENT|adjunto no es/);
  } finally { s.close(); }
});

test('sin __VIEWSTATE el formulario no es el auditado y se para', async () => {
  const s = await fx.createFakeCslbServer({ mode: 'noViewstate' });
  try {
    await assert.rejects(() => corre('cslb_contractors', s), /NO_VIEWSTATE|__VIEWSTATE/);
  } finally { s.close(); }
});

test('un CSV que anuncia más del tope se rechaza antes de leerlo', async () => {
  const s = await fx.createFakeCslbServer({ mode: 'oversize' });
  try {
    await assert.rejects(() => corre('cslb_contractors', s), /TOO_LARGE|tope/i);
  } finally { s.close(); }
});

test('una descarga cortada no deja ni filas a medias ni el archivo en disco', async () => {
  const s = await fx.createFakeCslbServer({ mode: 'truncated' });
  try {
    await assert.rejects(() => corre('cslb_contractors', s), (err) => {
      assert.equal(err.name, 'WebFormsError');
      for (const aguja of fx.PII_PROHIBIDA) {
        assert.ok(!err.message.includes(aguja), `el error filtró "${aguja}"`);
      }
      return true;
    });
    assert.deepEqual(
      fs.readdirSync(process.env.SOURCE_CSV_TMP_DIR).filter((f) => f.startsWith('cc-csv-')), [],
      'quedó un volcado con direcciones y personas en disco',
    );
  } finally { s.close(); }
});

test('un CSV vacío o malformado es un error, no media verdad', async () => {
  for (const mode of ['empty', 'malformedCsv']) {
    const s = await fx.createFakeCslbServer({ mode });
    try {
      await assert.rejects(() => corre('cslb_contractors', s));
    } finally { s.close(); }
  }
});

test('un 429 se obedece y la corrida sigue', async () => {
  const s = await fx.createFakeCslbServer({ mode: 'throttled' });
  try {
    const r = await corre('cslb_contractors', s);
    assert.equal(r.blocked, null);
    assert.equal(r.metrics.http429, 1);
    assert.equal(r.metrics.retries, 1);
    assert.ok(r.metrics.accepted > 0);
  } finally { s.close(); }
});

test('CSLB acepta solo lo demostrable, y cuenta cada rechazo por su razón', async () => {
  const s = await fx.createFakeCslbServer();
  try {
    const r = await corre('cslb_contractors', s);
    const nombres = r.staging.doc.candidates.map((c) => c.businessName).sort();
    assert.deepEqual(nombres, [
      'Gaslamp Construction, "The Original" LLC',
      'Harbor Builders Incorporated',
      'Mesa\nRoofing Company',
    ].sort());

    assert.equal(r.metrics.accepted, 3);
    assert.equal(r.metrics.rejected_out_of_area, 1, 'Riverside');
    assert.equal(r.metrics.rejected_inactive, 2, 'EXPIRED y SUSPENDED');
    assert.equal(r.metrics.rejected_personal, 3, 'Sole Owner, Partnership y un nombre de persona');
    assert.equal(r.metrics.rejected_unverifiable, 2, 'sin clase B: C-36 y B-2');
    assert.equal(r.metrics.deduped, 1, 'la licencia repetida');
    assert.equal(r.metrics.crm_writes, 0);
    assert.equal(r.metrics.outbound, 0);
  } finally { s.close(); }
});

test('CSLB no conserva dirección, teléfono, bonds ni personas', async () => {
  const s = await fx.createFakeCslbServer();
  try {
    const r = await corre('cslb_contractors', s);
    const texto = fs.readFileSync(r.staging.file, 'utf8');
    for (const aguja of fx.PII_PROHIBIDA) {
      assert.ok(!texto.includes(aguja), `"${aguja}" entró en el staging`);
    }
    for (const c of r.staging.doc.candidates) {
      assert.equal(c.address, null, 'esta fuente no conserva dirección a propósito');
      assert.equal(c.city, null);
      assert.equal(c.zip, null);
      assert.match(c.dedupKey, /^cslb:/);
    }
  } finally { s.close(); }
});

test('una columna nueva con datos personales se cae sin que nadie la prohíba', async () => {
  const s = await fx.createFakeCslbServer({ mode: 'unknownColumns' });
  try {
    const r = await corre('cslb_contractors', s);
    const texto = fs.readFileSync(r.staging.file, 'utf8');
    assert.ok(!texto.includes('+16195550101'));
    assert.ok(!texto.includes('privado@ejemplo.invalid'));
    assert.ok(!texto.includes('OwnerMobile'));
  } finally { s.close(); }
});

test('extractFormTokens lee tokens, no contenido', () => {
  const html = '<input name="__VIEWSTATE" value="abc" /><input value="gen" name="__VIEWSTATEGENERATOR" />'
    + '<input name="__EVENTVALIDATION" value="ev" /><p>Jose Ramon Ortega, 619-555-0101</p>';
  const t = extractFormTokens(html);
  assert.deepEqual(t, { __VIEWSTATE: 'abc', __VIEWSTATEGENERATOR: 'gen', __EVENTVALIDATION: 'ev' });
  assert.ok(!JSON.stringify(t).includes('Ortega'));
  assert.throws(() => extractFormTokens('<html></html>'), WebFormsError);
});

// ══ 2. HUD · ArcGIS ═══════════════════════════════════════════
test('ArcGIS se consulta sin geometría y solo con los campos de la allowlist', async () => {
  const s = await fx.createFakeArcgisServer();
  try {
    const r = await corre('hud_multifamily', s);
    assert.equal(r.blocked, null);
    for (const q of s.requests) {
      assert.equal(q.returnGeometry, 'false', 'se pidió geometría');
      const pedidos = q.outFields.split(',');
      assert.deepEqual(pedidos, registry.allowedFields('hud_multifamily'));
      for (const prohibido of registry.neverRequested('hud_multifamily')) {
        assert.ok(!pedidos.includes(prohibido), `se pidió ${prohibido}`);
      }
      assert.equal(q.orderByFields, 'PROPERTY_ID ASC', 'sin orden estable la paginación no es reproducible');
    }
  } finally { s.close(); }
});

test('la paginación avanza y termina', async () => {
  const s = await fx.createFakeArcgisServer({ pageSize: 2 });
  try {
    const r = await corre('hud_multifamily', s);
    assert.ok(s.requests.length >= 3, `páginas: ${s.requests.length}`);
    const offsets = s.requests.map((q) => q.offset);
    assert.deepEqual(offsets, [...offsets].sort((a, b) => a - b), 'los offsets tienen que avanzar');
    assert.equal(new Set(offsets).size, offsets.length, 'se repitió una página');
    assert.equal(r.metrics.fetched, fx.HUD_ROWS.length);
  } finally { s.close(); }
});

test('un servidor que nunca dice que acabó se corta por el tope de páginas', async () => {
  const s = await fx.createFakeArcgisServer({ mode: 'neverEnds', pageSize: 2 });
  try {
    const { metrics } = await queryArcgis(s.queryUrl, {
      where: '1=1', outFields: ['PROPERTY_ID'], maxPages: 4, sleep: async () => {},
    });
    assert.equal(metrics.pages, 4, 'paginó más allá del tope');
  } finally { s.close(); }
});

test('un error de ArcGIS dentro de un 200 no se trata como página vacía', async () => {
  const s = await fx.createFakeArcgisServer({ mode: 'error200' });
  try {
    await assert.rejects(() => corre('hud_multifamily', s), (err) => {
      assert.equal(err.name, 'ArcgisError');
      assert.equal(err.code, 'ARCGIS_ERROR');
      return true;
    });
  } finally { s.close(); }
});

test('JSON roto y 429 se distinguen de una respuesta buena', async () => {
  const roto = await fx.createFakeArcgisServer({ mode: 'badJson' });
  try {
    await assert.rejects(() => corre('hud_multifamily', roto), /BAD_JSON|no es JSON/);
  } finally { roto.close(); }

  const lento = await fx.createFakeArcgisServer({ mode: 'throttled' });
  try {
    const r = await corre('hud_multifamily', lento);
    assert.equal(r.metrics.http429, 1);
    assert.ok(r.metrics.accepted > 0);
  } finally { lento.close(); }
});

test('pedir "*" no es una opción', async () => {
  // `queryArcgis` es async: sin `rejects` el error se iría a un promise sin dueño
  // y la prueba pasaría sin comprobar nada.
  await assert.rejects(
    () => queryArcgis('http://x.invalid/query', { where: '1=1', outFields: [] }),
    (err) => { assert.ok(err instanceof ArcgisError); assert.equal(err.code, 'NO_FIELDS'); return true; },
  );
});

test('el DataStore se pagina por LIMIT/OFFSET hasta agotar', async () => {
  const s = await fx.createFakeCkanServer({ pageSize: 2 });
  try {
    const { rows, metrics } = await queryDatastore({
      sqlEndpoint: s.sqlEndpoint,
      resourceId: '641c5557-7d65-4379-8fea-6b7dedbda40b',
      fields: ['OSHPD_ID', 'FACILITY_NAME'],
      orderBy: 'OSHPD_ID', pageSize: 2, maxPages: 20, sleep: async () => {},
    });
    assert.equal(rows.length, fx.HCAI_ROWS.length, `trajo ${rows.length}`);
    assert.ok(metrics.pages >= 5, `páginas: ${metrics.pages}`);
    const offsets = s.requests.map((q) => Number((q.sql.match(/OFFSET (\d+)/) || [])[1] || 0));
    assert.equal(new Set(offsets).size, offsets.length, 'se repitió una página');
  } finally { s.close(); }
});

test('HUD acepta solo propiedades institucionales en el ámbito validado', async () => {
  const s = await fx.createFakeArcgisServer();
  try {
    const r = await corre('hud_multifamily', s);
    const nombres = r.staging.doc.candidates.map((c) => c.businessName).sort();
    assert.deepEqual(nombres, [
      'Villa Serena Apartments', 'Harbor Terrace Senior Housing',
      'Mesa Gardens Commons', 'Bayview Manor Apartments',
    ].sort());

    assert.equal(r.metrics.rejected_out_of_area, 2, 'Fresno y Arizona');
    assert.equal(r.metrics.rejected_residential, 4, '1 unidad, 2 unidades, vacant land y una dirección de piso');
    assert.equal(r.metrics.rejected_personal, 1, 'Chen, Wei');
    assert.equal(r.metrics.rejected_unverifiable, 2, 'unidades ilegibles y sin dirección');
    for (const c of r.staging.doc.candidates) {
      assert.ok(c.evidence.units >= 5, `${c.businessName} con ${c.evidence.units} unidades`);
      assert.match(c.dedupKey, /^hud-mf:/);
    }
  } finally { s.close(); }
});

test('el gestor solo sobrevive si es una entidad, y nunca es escribible', async () => {
  const s = await fx.createFakeArcgisServer();
  try {
    const r = await corre('hud_multifamily', s);
    const conGestor = r.staging.doc.candidates.find((c) => c.evidence.managementAgent);
    assert.ok(conGestor, 'ninguno conservó gestor');
    assert.equal(conGestor.evidence.managementAgent, 'Coastal Management LLC');
    assert.equal(conGestor.evidence.managementAgentWritable, false);

    // El que tenía una persona como gestor pasó, pero sin gestor.
    const bayview = r.staging.doc.candidates.find((c) => c.businessName === 'Bayview Manor Apartments');
    assert.equal(bayview.evidence.managementAgent, null, 'se conservó el nombre de una persona como gestor');
  } finally { s.close(); }
});

test('si el servidor devuelve contacto y coordenadas de más, se caen igual', async () => {
  const s = await fx.createFakeArcgisServer({ mode: 'partialPage' });
  try {
    const r = await corre('hud_multifamily', s);
    const texto = fs.readFileSync(r.staging.file, 'utf8');
    for (const aguja of ['Chen, Wei', 'Patel, Asha', '32.715711', '-117.1611',
      'PROJECT_MANAGER_NAME_TEXT', 'MGMT_CONTACT_FULL_NAME', 'LATITUDE', 'LONGITUDE']) {
      assert.ok(!texto.includes(aguja), `"${aguja}" sobrevivió pese a no pedirse`);
    }
  } finally { s.close(); }
});

// ══ 3. HCAI · CKAN ════════════════════════════════════════════
test('el SQL se construye con identificadores validados y literales escapados', () => {
  const sql = buildSql({
    resourceId: '641c5557-7d65-4379-8fea-6b7dedbda40b',
    fields: ['OSHPD_ID', 'FACILITY_NAME'],
    filters: { COUNTY_NAME: "San Diego's", FACILITY_STATUS_DESC: 'Open' },
    orderBy: 'OSHPD_ID', limit: 10, offset: 0,
  });
  assert.match(sql, /"COUNTY_NAME" = 'San Diego''s'/, 'una comilla tiene que quedar escapada');
  assert.match(sql, /ORDER BY "OSHPD_ID" ASC/);
  assert.equal(sqlLiteral("a'b"), "a''b");

  assert.throws(() => buildSql({ resourceId: 'x"; DROP', fields: ['A'], limit: 1, offset: 0 }), CkanError);
  assert.throws(() => buildSql({ resourceId: 'r', fields: ['A; DROP TABLE'], limit: 1, offset: 0 }), CkanError);
  assert.throws(() => buildSql({ resourceId: 'r', fields: [], limit: 1, offset: 0 }), /SELECT \*|lista de campos/);
});

test('un redirect a S3 se rechaza: ese recurso no es el auditado', async () => {
  const s = await fx.createFakeCkanServer({ mode: 'redirectToS3' });
  try {
    await assert.rejects(() => corre('hcai_facilities', s), (err) => {
      assert.equal(err.code, 'REDIRECT_REJECTED');
      assert.match(err.message, /no es el recurso auditado/);
      return true;
    });
  } finally { s.close(); }
});

test('success:false dentro de un 200 es un error', async () => {
  const s = await fx.createFakeCkanServer({ mode: 'successFalse' });
  try {
    await assert.rejects(() => corre('hcai_facilities', s), /success:false/);
  } finally { s.close(); }
});

test('si el recurso del DataStore rotó, no se consulta', async () => {
  await assert.rejects(() => queryDatastore({
    sqlEndpoint: 'http://x.invalid/api',
    resourceId: 'nuevo-recurso',
    expectedResourceId: '641c5557-7d65-4379-8fea-6b7dedbda40b',
    fields: ['OSHPD_ID'],
  }), (err) => {
    assert.equal(err.code, 'RESOURCE_ROTATED');
    assert.match(err.message, /El esquema podría ser otro/);
    return true;
  });
});

test('si el esquema devuelto pierde un campo pedido, se para', async () => {
  const s = await fx.createFakeCkanServer({ mode: 'schemaChanged' });
  try {
    await assert.rejects(() => corre('hcai_facilities', s), /esquema cambió|LICENSE_NUM/);
  } finally { s.close(); }
});

test('HCAI acepta solo instalaciones institucionales abiertas y con licencia', async () => {
  const s = await fx.createFakeCkanServer();
  try {
    const r = await corre('hcai_facilities', s);
    const nombres = r.staging.doc.candidates.map((c) => c.businessName).sort();
    assert.deepEqual(nombres, ['Harbor General Hospital', 'Mesa Surgery Center', 'Coastal Hospice Care Inc'].sort());

    assert.equal(r.metrics.rejected_out_of_area, 1, 'Fresno');
    assert.equal(r.metrics.rejected_inactive, 2, 'Closed y Pending');
    assert.equal(r.metrics.rejected_personal, 1, 'Patel, Asha');
    assert.equal(r.metrics.rejected_unverifiable, 3, 'nivel satélite, sin licencia y sin ZIP');
    assert.equal(r.metrics.rejected_residential, 1, 'dirección de vivienda');
    for (const c of r.staging.doc.candidates) {
      assert.ok(c.evidence.licenseNum, 'sin licencia no se puede verificar');
      assert.match(c.dedupKey, /^hcai:/);
      assert.ok(['Parent Facility', 'Consolidated Facility'].includes(c.evidence.facilityLevel));
    }
    // Atribución: la licencia lo exige y queda registrado en la procedencia.
    assert.equal(r.staging.doc.provenance.attribution, true);
  } finally { s.close(); }
});

// ══ Privacidad transversal ════════════════════════════════════
test('ningún staging de los tres lleva un solo dato personal', async () => {
  for (const [scoutId, crear] of [
    ['cslb_contractors', fx.createFakeCslbServer],
    ['hud_multifamily', fx.createFakeArcgisServer],
    ['hcai_facilities', fx.createFakeCkanServer],
  ]) {
    const s = await crear({});
    try {
      const r = await corre(scoutId, s);
      const texto = fs.readFileSync(r.staging.file, 'utf8');
      for (const aguja of fx.PII_PROHIBIDA) {
        assert.ok(!texto.includes(aguja), `${scoutId}: "${aguja}" entró en el staging`);
      }
      for (const v of Object.values(r.metrics)) assert.equal(typeof v, 'number');
    } finally { s.close(); }
  }
});

test('el recorte a la allowlist es cerrado y se comprueba antes del staging', () => {
  const { row, descartados } = trimToAllowed('hcai_facilities', {
    OSHPD_ID: '1', FACILITY_NAME: 'X Inc', LATITUDE: 32.7, ADMINISTRATOR: 'Chen, Wei', COLUMNA_NUEVA: 'z',
  });
  assert.deepEqual(Object.keys(row).sort(), ['FACILITY_NAME', 'OSHPD_ID']);
  assert.ok(descartados.includes('LATITUDE') && descartados.includes('ADMINISTRATOR'));
  assert.ok(descartados.includes('COLUMNA_NUEVA'), 'una columna nueva tiene que caerse sola');
  assert.throws(() => assertOnlyAllowed('hcai_facilities', { LATITUDE: 1 }), /no permitida/);
});

// ══ Ningún scout toca el CRM ══════════════════════════════════
test('ningún módulo de scout importa el adaptador de Twenty', () => {
  const dir = new URL('../src/prospecting/scouts/', import.meta.url);
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js')) continue;
    const src = fs.readFileSync(new URL(f, dir), 'utf8');
    if (f === 'intake.js') continue;   // la capa central tampoco, pero se mira aparte
    assert.ok(!/crm\/twenty|twenty-schema/.test(src), `${f} importa el CRM y no debería`);
  }
  // Y la capa central tampoco lo importa: recibe el índice ya cargado.
  const central = fs.readFileSync(new URL('intake.js', dir), 'utf8');
  assert.ok(!/crm\/twenty|twenty-schema/.test(central),
    'la capa central importa el adaptador: el índice tiene que llegarle como parámetro');
});

test('una corrida de scout no abre una sola conexión al CRM', async () => {
  const { createFakeTwenty } = await import('./fixtures/fake-twenty.js');
  const crm = await createFakeTwenty({ seed: [] });
  const s = await fx.createFakeCkanServer();
  try {
    const r = await corre('hcai_facilities', s);
    assert.ok(r.staging);
    assert.deepEqual(crm.requests, [], 'el scout habló con el CRM');
    assert.equal(r.metrics.crm_writes, 0);
  } finally { crm.server.close(); s.close(); }
});

// ══ Cuotas y guards independientes ════════════════════════════
test('cada scout tiene su cuota y no estorba a los demás ni a County/City', async () => {
  const estado = nuevoEstado();
  const s = await fx.createFakeCkanServer();
  try {
    const primera = await corre('hcai_facilities', s, { quotaOptions: estado });
    assert.equal(primera.blocked, null);
    const segunda = await corre('hcai_facilities', s, { quotaOptions: estado });
    assert.equal(segunda.blocked.reason, 'cuota_24h');
  } finally { s.close(); }

  const st = quota.readState(estado.stateFile);
  assert.ok(st.sources.hcai_facilities, 'no se registró la corrida del scout');
  for (const otro of ['cslb_contractors', 'hud_multifamily',
    'sdcounty_food_facility_permits', 'sd_business_tax_certificates']) {
    assert.equal(st.sources[otro], undefined, `la cuota de ${otro} se vio afectada`);
  }
});

test('el guard durable de cada scout mira su propio prefijo', async () => {
  const AHORA = Date.parse('2026-10-05T12:00:00.000Z');
  const lookup = (porPrefijo) => async (prefix) => porPrefijo[prefix] ?? null;
  const reciente = { dedupKey: 'hcai:106370001', lastVerified: new Date(AHORA - 3600000).toISOString() };

  const bloqueado = await checkDurableQuota({ namespace: 'hcai', now: AHORA, lookup: lookup({ 'hcai:': reciente }) });
  assert.equal(bloqueado.allowed, false);
  assert.equal(bloqueado.reason, 'cuota_24h_durable');

  // Y los otros dos, con el mismo CRM, siguen permitidos.
  for (const ns of ['cslb', 'hud-mf', 'sdcounty-ffp', 'city-btc']) {
    const r = await checkDurableQuota({ namespace: ns, now: AHORA, lookup: lookup({ 'hcai:': reciente }) });
    assert.equal(r.allowed, true, `${ns} se dejó bloquear por hcai`);
  }
});

test('con la cuota durable bloqueada no se toca el portal', async () => {
  const s = await fx.createFakeCkanServer();
  try {
    const r = await corre('hcai_facilities', s, {
      durableQuotaOptions: {
        // Marca de hace una hora, fija: un `Date.now()` y un `new Date()` en la
        // misma expresión pueden diferir un milisegundo, y entonces la prueba
        // mide el desfase de reloj en lugar de la cuota.
        now: Date.parse('2026-10-05T12:00:00.000Z'),
        lookup: async () => ({ dedupKey: 'hcai:1', lastVerified: '2026-10-05T11:00:00.000Z' }),
      },
    });
    assert.equal(r.blocked.reason, 'cuota_24h_durable');
    assert.equal(r.metrics.quota_blocked, 1);
    assert.equal(r.metrics.requests, 0);
    assert.deepEqual(s.requests, [], 'se consultó al portal estando bloqueado');
  } finally { s.close(); }
});

test('si el CRM no se puede leer, no se sale a la red', async () => {
  const s = await fx.createFakeArcgisServer();
  try {
    const r = await corre('hud_multifamily', s, {
      durableQuotaOptions: { lookup: async () => { throw new Error('503'); } },
    });
    assert.equal(r.blocked.reason, 'cuota_durable_indeterminada');
    assert.deepEqual(s.requests, []);
  } finally { s.close(); }
});

// ══ Staging sellado ═══════════════════════════════════════════
test('el staging lleva hash, runId y caducidad, y se relee igual', async () => {
  const s = await fx.createFakeCkanServer();
  try {
    const r = await corre('hcai_facilities', s);
    assert.match(r.staging.hash, /^sha256:[0-9a-f]{64}$/);
    assert.match(r.staging.doc.runId, /^run_/);
    assert.ok(new Date(r.staging.doc.expiresAt) > new Date(r.staging.doc.createdAt));

    const leido = staging.readStaging(r.staging.file);
    assert.equal(leido.ok, true, leido.problems.join('; '));
    assert.equal(leido.doc.runId, r.staging.doc.runId);
  } finally { s.close(); }
});

test('tocar el staging invalida su hash', async () => {
  const s = await fx.createFakeCkanServer();
  try {
    const r = await corre('hcai_facilities', s);
    const doc = JSON.parse(fs.readFileSync(r.staging.file, 'utf8'));
    doc.candidates.push({ dedupKey: 'hcai:colado', businessName: 'Colado A Mano' });
    fs.writeFileSync(r.staging.file, JSON.stringify(doc, null, 2));

    const leido = staging.readStaging(r.staging.file);
    assert.equal(leido.ok, false);
    assert.ok(leido.problems.some((p) => /hash no coincide/.test(p)));
  } finally { s.close(); }
});

test('un staging caducado o de otra sesión no se reutiliza', () => {
  const viejo = staging.writeStaging({
    scoutId: 'hcai_facilities', displayName: 'X', candidates: [], metrics: {},
    provenance: { license: {}, collectedAt: '2026-10-04T00:00:00.000Z', egressHost: 'data.chhs.ca.gov' },
    now: Date.now() - 48 * 3600 * 1000,
  });
  const leido = staging.readStaging(viejo.file);
  assert.equal(leido.ok, false);
  assert.ok(leido.problems.some((p) => /caducó/.test(p)));

  const original = process.env.SOURCE_SESSION_ID;
  process.env.SOURCE_SESSION_ID = 'otra-sesion';
  try {
    const otro = staging.readStaging(viejo.file, { now: Date.now() - 47 * 3600 * 1000 });
    assert.ok(otro.problems.some((p) => /otra sesión/.test(p)));
  } finally { process.env.SOURCE_SESSION_ID = original; }
});

// ══ Capa central ══════════════════════════════════════════════
const indiceVacio = () => ({
  dedupKeys: new Set(), crossKeys: new Set(), nameKeys: new Set(), complete: true,
});

async function tresStagings() {
  const docs = {};
  for (const [scoutId, crear] of [
    ['cslb_contractors', fx.createFakeCslbServer],
    ['hud_multifamily', fx.createFakeArcgisServer],
    ['hcai_facilities', fx.createFakeCkanServer],
  ]) {
    const s = await crear({});
    try {
      const r = await corre(scoutId, s);
      docs[scoutId] = { doc: r.staging.doc, file: r.staging.file };
    } finally { s.close(); }
  }
  return docs;
}

test('la capa central valida cada staging por separado', async () => {
  const docs = await tresStagings();
  for (const [scoutId, { file }] of Object.entries(docs)) {
    const v = intake.validateStaging(scoutId, file);
    assert.equal(v.ok, true, `${scoutId}: ${v.problems.join('; ')}`);
  }
});

test('la capa central rechaza un staging con una clave de otra fuente', async () => {
  const docs = await tresStagings();
  const v = intake.validateStaging('hud_multifamily', docs.hcai_facilities.file);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => /dice ser de/.test(p)));
});

test('la capa central caza PII colada a mano en un staging', async () => {
  const docs = await tresStagings();
  const doc = JSON.parse(fs.readFileSync(docs.hcai_facilities.file, 'utf8'));
  doc.candidates[0].evidence.contactPhone = '619-555-0101';
  doc.sha256 = staging.computeHash(doc);   // se re-sella: el hash ya no salva
  const file = path.join(tmpDir, 'con-pii.json');
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));

  const v = intake.validateStaging('hcai_facilities', file);
  assert.equal(v.ok, false);
  const texto = v.problems.join(' | ');
  assert.ok(/suena a dato personal/.test(texto) || /un teléfono/.test(texto),
    `no se detectó: ${texto}`);
});

test('la capa central no deja pasar más candidatos que el tope de la fuente', async () => {
  const docs = await tresStagings();
  const doc = JSON.parse(fs.readFileSync(docs.hcai_facilities.file, 'utf8'));
  doc.candidates = Array.from({ length: 51 }, (_, i) => ({
    dedupKey: `hcai:${i}`, sourceId: String(i), businessName: `Clinica ${i} Inc`,
    address: '1 A St', city: 'San Diego', zip: '92101', serviceArea: 'San Diego County, CA',
    sourceUrl: 'https://data.chhs.ca.gov/dataset/x', evidence: {}, matchKeys: { name: `clinica${i}`, cross: null },
  }));
  doc.sha256 = staging.computeHash(doc);
  const file = path.join(tmpDir, 'demasiados.json');
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));

  const v = intake.validateStaging('hcai_facilities', file);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => /por encima del tope/.test(p)));
});

test('la deduplicación contra las Companies existentes omite, no modifica', async () => {
  const docs = await tresStagings();
  const stagings = Object.fromEntries(Object.entries(docs).map(([k, v]) => [k, v.doc]));
  const index = indiceVacio();
  const primero = stagings.hcai_facilities.candidates[0];
  index.dedupKeys.add(primero.dedupKey);

  const plan = intake.reconcile({ stagings, crmIndex: index });
  assert.ok(!plan.create.some((c) => c.candidate.dedupKey === primero.dedupKey));
  assert.ok(plan.omitted.some((o) => o.dedupKey === primero.dedupKey && o.reason === 'ya_existe_en_crm'));
  // El plan solo crea. No hay ni una actualización.
  assert.deepEqual(Object.keys(plan.totals).sort(),
    ['candidates', 'create', 'omitted_cross_source', 'omitted_existing']);
});

test('la prioridad entre fuentes es determinista y está razonada', async () => {
  const stagings = {
    hcai_facilities: {
      scoutId: 'hcai_facilities',
      candidates: [{
        dedupKey: 'hcai:1', businessName: 'Harbor General Hospital', address: '555 Medical Center Dr',
        matchKeys: { name: 'harborgeneralhospital', cross: 'harborgeneralhospital|555medicalcenterdr' },
      }],
    },
    hud_multifamily: {
      scoutId: 'hud_multifamily',
      candidates: [{
        dedupKey: 'hud-mf:1', businessName: 'Harbor General Hospital', address: '555 Medical Center Dr',
        matchKeys: { name: 'harborgeneralhospital', cross: 'harborgeneralhospital|555medicalcenterdr' },
      }],
    },
    cslb_contractors: {
      scoutId: 'cslb_contractors',
      candidates: [{
        dedupKey: 'cslb:1', businessName: 'Harbor General Hospital', address: null,
        matchKeys: { name: 'harborgeneralhospital', cross: null },
      }],
    },
  };

  const plan = intake.reconcile({ stagings, crmIndex: indiceVacio() });
  assert.equal(plan.create.length, 1, 'la misma entidad se creó más de una vez');
  assert.equal(plan.create[0].scoutId, 'hcai_facilities', 'ganó la fuente equivocada');
  assert.equal(plan.conflicts.length, 2);
  for (const c of plan.conflicts) {
    assert.equal(c.winner, 'hcai_facilities');
    assert.ok(c.rationale, 'un conflicto sin razón escrita no se puede revisar');
  }

  // Y el orden no depende del orden de las claves del objeto.
  const alRevés = {
    cslb_contractors: stagings.cslb_contractors,
    hud_multifamily: stagings.hud_multifamily,
    hcai_facilities: stagings.hcai_facilities,
  };
  const plan2 = intake.reconcile({ stagings: alRevés, crmIndex: indiceVacio() });
  assert.deepEqual(plan2.create.map((c) => c.candidate.dedupKey), plan.create.map((c) => c.candidate.dedupKey));
});

test('la prioridad documentada cubre las tres fuentes y explica por qué', () => {
  assert.deepEqual(intake.SOURCE_PRIORITY, ['hcai_facilities', 'hud_multifamily', 'cslb_contractors']);
  for (const id of intake.SOURCE_PRIORITY) {
    assert.ok(intake.PRIORITY_RATIONALE[id], `${id} sin razón documentada`);
  }
  assert.match(intake.PRIORITY_RATIONALE.cslb_contractors, /sin dirección/);
});

test('un índice incompleto para la capa central: no se planifica nada', async () => {
  const docs = await tresStagings();
  const stagings = Object.fromEntries(Object.entries(docs).map(([k, v]) => [k, v.doc]));
  assert.throws(
    () => intake.reconcile({ stagings, crmIndex: { ...indiceVacio(), complete: false } }),
    /índice del CRM está incompleto/,
  );
});

test('la capa central rechaza todo lo que esta fase prohíbe', () => {
  const base = {
    config: { outbound: { enabled: false } },
    objects: ['companies'], operations: ['create'],
    perSource: { hcai_facilities: 3 }, disabledSources: [], staleSources: [], invalidStagings: [],
  };
  assert.deepEqual(intake.refusalsFor(base), []);

  const casos = [
    [{ objects: ['companies', 'people'] }, 'objeto_no_permitido'],
    [{ objects: ['companies', 'opportunities'] }, 'objeto_no_permitido'],
    [{ objects: ['companies', 'notes'] }, 'objeto_no_permitido'],
    [{ operations: ['create', 'update'] }, 'operacion_no_permitida'],
    [{ operations: ['create', 'delete'] }, 'operacion_no_permitida'],
    [{ perSource: { hcai_facilities: 51 } }, 'por_encima_del_tope'],
    [{ disabledSources: ['cslb_contractors'] }, 'fuente_deshabilitada'],
    [{ staleSources: ['hud_multifamily'] }, 'constancia_o_cuota_vencida'],
    [{ invalidStagings: ['hcai_facilities'] }, 'staging_alterado'],
  ];
  for (const [patch, code] of casos) {
    const r = intake.refusalsFor({ ...base, ...patch });
    assert.ok(r.some((x) => x.code === code), `${code} no se rechazó: ${JSON.stringify(r)}`);
    assert.ok(r.every((x) => x.why), 'un rechazo sin motivo no se puede explicar');
  }

  // Y el outbound activo no es un rechazo más: lanza.
  assert.throws(() => intake.refusalsFor({ ...base, config: { outbound: { enabled: true } } }), /OUTBOUND_ENABLED/);
});

test('la capa central no muta el staging que lee', async () => {
  const docs = await tresStagings();
  const antes = Object.fromEntries(
    Object.entries(docs).map(([k, v]) => [k, fs.readFileSync(v.file, 'utf8')]),
  );
  const stagings = Object.fromEntries(Object.entries(docs).map(([k, v]) => [k, v.doc]));
  intake.reconcile({ stagings, crmIndex: indiceVacio() });
  for (const [k, v] of Object.entries(docs)) {
    assert.equal(fs.readFileSync(v.file, 'utf8'), antes[k], `${k}: el staging cambió`);
  }
});

// ══ County y City intactos ════════════════════════════════════
test('las fuentes de la fase anterior siguen como estaban', async () => {
  const lista = JSON.parse(fs.readFileSync(new URL('../config/source-allowlist.json', import.meta.url), 'utf8'));
  const habilitadas = Object.entries(lista.sources).filter(([, e]) => e.enabled).map(([k]) => k).sort();
  assert.deepEqual(habilitadas, ['sd_business_tax_certificates', 'sdcounty_food_facility_permits']);
  assert.equal(lista.sources.sdcounty_food_facility_permits.state, 'ENABLED');
  assert.equal(lista.sources.sd_business_tax_certificates.state, 'ENABLED');
});

test('el outbound sigue apagado', async () => {
  const { config } = await import('../src/config.js');
  assert.equal(config.outbound.enabled, false);
  assert.equal(registry.assertOutboundDisabled(config), true);
});

// ══ Lock global de la fase ════════════════════════════════════
test('el lock de la fase impide dos orquestaciones a la vez', async () => {
  const lock = await import('../src/prospecting/scouts/lock.js');
  const file = path.join(tmpDir, 'fase.lock');

  const primero = lock.acquirePhaseLock({ file });
  assert.equal(primero.acquired, true);
  assert.equal(primero.brokeStale, false);

  const segundo = lock.acquirePhaseLock({ file });
  assert.equal(segundo.acquired, false);
  assert.equal(segundo.reason, 'fase_en_curso');
  assert.match(segundo.detail, /pid/);

  assert.equal(lock.releasePhaseLock({ file }), true);
  assert.equal(lock.acquirePhaseLock({ file }).acquired, true);
  lock.releasePhaseLock({ file });
});

test('un lock caducado se rompe, y se dice que algo murió sin soltarlo', async () => {
  const lock = await import('../src/prospecting/scouts/lock.js');
  const file = path.join(tmpDir, 'fase-viejo.lock');
  lock.acquirePhaseLock({ file });
  // Se envejece el archivo a mano.
  const viejo = new Date(Date.now() - 2 * 3600 * 1000);
  fs.utimesSync(file, viejo, viejo);

  const r = lock.acquirePhaseLock({ file });
  assert.equal(r.acquired, true);
  assert.equal(r.brokeStale, true);
  assert.match(r.detail, /murió sin soltarlo/);
  lock.releasePhaseLock({ file });
});

test('withPhaseLock suelta el lock aunque la orquestación falle', async () => {
  const lock = await import('../src/prospecting/scouts/lock.js');
  const file = path.join(tmpDir, 'fase-falla.lock');
  await assert.rejects(() => lock.withPhaseLock(async () => { throw new Error('revienta'); }, { file }));
  assert.equal(fs.existsSync(file), false, 'el lock se quedó puesto tras un fallo');

  // Y una orquestación bloqueada no ejecuta el cuerpo.
  lock.acquirePhaseLock({ file });
  let corrio = false;
  const r = await lock.withPhaseLock(async () => { corrio = true; }, { file });
  assert.equal(r.blocked, true);
  assert.equal(corrio, false);
  lock.releasePhaseLock({ file });
});

// ══ El orquestador ════════════════════════════════════════════
test('el orquestador no escribe por defecto y su apply está cerrado en esta fase', () => {
  const src = fs.readFileSync(new URL('../scripts/phase3-run.js', import.meta.url), 'utf8');

  // El guard duro del outbound va antes de los subcomandos.
  assert.match(src, /assertOutboundDisabled\(config\)/);
  // Lock global en la orquestación.
  assert.match(src, /withPhaseLock/);
  // Apply exige las cuatro cosas a la vez, y aun así se detiene.
  for (const cerrojo of ['--confirm', '--allow-writes', 'expect-hashes', 'TWENTY_WRITE_ENABLED=true']) {
    assert.ok(src.includes(cerrojo), `el apply no exige ${cerrojo}`);
  }
  assert.match(src, /apply no disponible en la fase de implementación/);

  // Y no hay rastro de lo que la fase prohíbe.
  for (const prohibido of ['upsertCompany', 'client.patch', 'client.post', 'outreach', 'messageCampaign']) {
    assert.ok(!src.includes(prohibido), `el orquestador menciona ${prohibido}`);
  }
});

test('ni el orquestador ni la capa central crean, actualizan o borran nada', () => {
  for (const f of ['../scripts/phase3-run.js', '../src/prospecting/scouts/intake.js']) {
    const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    // Ningún verbo de escritura HTTP ni método de mutación del adaptador.
    for (const re of [/\.post\(/, /\.patch\(/, /\.delete\(/, /method:\s*'POST'/, /method:\s*'PATCH'/, /method:\s*'DELETE'/]) {
      assert.ok(!re.test(src), `${f} contiene ${re}`);
    }
  }
});

test('el plan central solo contempla creaciones de Companies', async () => {
  const docs = await tresStagings();
  const stagings = Object.fromEntries(Object.entries(docs).map(([k, v]) => [k, v.doc]));
  const plan = intake.reconcile({ stagings, crmIndex: indiceVacio() });

  assert.ok(Array.isArray(plan.create));
  assert.equal(plan.update, undefined, 'el plan no puede tener una sección de actualizaciones');
  assert.equal(plan.delete, undefined);
  assert.equal(plan.people, undefined);
  assert.equal(plan.opportunities, undefined);
  assert.equal(plan.notes, undefined);
  // Y cada creación trae de qué scout salió, para poder auditarla.
  for (const c of plan.create) {
    assert.ok(SCOUTS.includes(c.scoutId));
    assert.ok(c.candidate.dedupKey && c.candidate.businessName);
  }
});

test('re-planificar los mismos staging da exactamente el mismo plan', async () => {
  const docs = await tresStagings();
  const stagings = Object.fromEntries(Object.entries(docs).map(([k, v]) => [k, v.doc]));
  const a = intake.reconcile({ stagings, crmIndex: indiceVacio(), now: 0 });
  const b = intake.reconcile({ stagings, crmIndex: indiceVacio(), now: 0 });
  assert.deepEqual(
    a.create.map((c) => `${c.scoutId}:${c.candidate.dedupKey}`),
    b.create.map((c) => `${c.scoutId}:${c.candidate.dedupKey}`),
  );
  assert.deepEqual(a.totals, b.totals);

  // Y con todo ya en el CRM, el plan queda en cero: 0 crear, 0 actualizar.
  const lleno = indiceVacio();
  for (const c of a.create) lleno.dedupKeys.add(c.candidate.dedupKey);
  const c3 = intake.reconcile({ stagings, crmIndex: lleno, now: 0 });
  assert.equal(c3.totals.create, 0, 'volvería a crear lo que ya existe');
  assert.equal(c3.totals.omitted_existing + c3.totals.omitted_cross_source, c3.totals.candidates);
});

test('el plan no deja fuera ningún candidato sin contarlo', async () => {
  const docs = await tresStagings();
  const stagings = Object.fromEntries(Object.entries(docs).map(([k, v]) => [k, v.doc]));
  const plan = intake.reconcile({ stagings, crmIndex: indiceVacio() });
  const esperados = Object.values(stagings).reduce((n, d) => n + d.candidates.length, 0);
  assert.equal(plan.totals.candidates, esperados);
  assert.equal(
    plan.totals.create + plan.totals.omitted_existing + plan.totals.omitted_cross_source,
    esperados,
    'hay candidatos que no acabaron ni en crear ni en omitir',
  );
});

test('el verificador distingue evidencia pendiente de evidencia rota', async () => {
  const { execFileSync } = await import('node:child_process');
  // Sobre las attestations REALES del repositorio: dos válidas (County y City) y
  // tres pendientes por diseño. Que haya pendientes no puede volver este comando
  // inútil para siempre.
  const env = { ...process.env };
  delete env.SOURCE_ATTESTATION_FILES;
  delete env.SOURCE_ATTESTATION_FILE;
  const salida = execFileSync(process.execPath, ['scripts/verify-attestation.js'], {
    cwd: process.cwd(), encoding: 'utf8', env,
  });
  assert.match(salida, /2 válida\(s\) · 3 pendiente\(s\) por diseño · 0 con problemas/);
  assert.match(salida, /PENDIENTE por diseño/);
  assert.match(salida, /mantiene su fuente apagada/);
});
