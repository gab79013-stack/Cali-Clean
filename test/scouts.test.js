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

const SCOUTS = ['cslb_contractors', 'hud_multifamily', 'cde_schools'];
const SLUG = { cslb_contractors: 'cslb', hud_multifamily: 'hud', cde_schools: 'cde' };

// Manifiestos: copia del real con enabled=true.
for (const id of SCOUTS) {
  const m = JSON.parse(fs.readFileSync(new URL(`../config/scouts/${id}.json`, import.meta.url), 'utf8'));
  m.enabled = true;
  m.eligible = true;
  m.state = 'ENABLED';
  // El robots de CDE no se ha podido leer, y la puerta lo trata como un "no".
  // Para ejercitar su pipeline hay que soltar ese cerrojo EN LA COPIA; dos
  // pruebas aparte comprueban que el manifiesto versionado sigue cerrado y que
  // el cerrojo no se puede abrir con un flag.
  if (m.robots) m.robots.disallowsOurPath = false;
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
    cde_schools: { downloadUrlOverride: servidor.downloadUrl },
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
test('el estado versionado de cada scout es el que la verificación real encontró', () => {
  const leer = (id) => JSON.parse(fs.readFileSync(new URL(`../config/scouts/${id}.json`, import.meta.url), 'utf8'));

  // HUD cumplió: robots inexistente, API pública y esquema verificado.
  const hud = leer('hud_multifamily');
  assert.equal(hud.enabled, true);
  assert.equal(hud.state, 'ENABLED');
  assert.deepEqual(hud.blockers, []);
  assert.equal(hud.schemaVerification.allowlistFieldsAllExist, true);
  assert.equal(hud.robots.disallowsOurPath, false);

  // CSLB: la secuencia existe y se verificó, pero el portal rechaza la descarga.
  const cslb = leer('cslb_contractors');
  assert.equal(cslb.enabled, false);
  assert.equal(cslb.state, 'BLOCKED_BY_PUBLISHER');
  assert.equal(cslb.cloudVerification.step3Csv.httpStatus, 403);
  assert.equal(cslb.cloudVerification.step3Csv.evasionAttempted, false,
    'no se intenta sortear la protección de un portal');
  assert.ok(cslb.blockers.some((b) => /403|WAF|rechaza/i.test(b)));

  // Y su robots SÍ se leyó: 404, sin política. Eso es lo único que afirma.
  assert.equal(cslb.robots.status, 'LEIDO');
  assert.equal(cslb.robots.httpStatus, 404);
  assert.equal(cslb.robots.disallowsOurPath, false);
  assert.match(cslb.robots.interpretation, /NO se interpreta como permiso/);

  // CDE: auditada en vivo. Cuatro de cinco comprobaciones pasaron; la licencia
  // no, porque la declaración de copyright del sitio no es legible desde aquí.
  // Que falte una sola de las cinco deja la fuente apagada.
  const cde = leer('cde_schools');
  assert.equal(cde.enabled, false);
  assert.equal(cde.eligible, false);
  assert.equal(cde.state, 'PENDING_LICENSE_REVIEW');
  for (const k of ['hostAllowed', 'robotsVerified', 'schemaVerified',
    'officialFileUrlVerified', 'termsVerified']) {
    assert.equal(cde.verification[k], true, `${k} debería estar verificada en vivo`);
  }
  assert.equal(cde.verification.licenseVerified, false,
    'no se afirma licencia sin haber leído la declaración de copyright');

  // El robots SÍ se leyó, y permite la ruta por omisión.
  assert.equal(cde.robots.status, 'LEIDO');
  assert.equal(cde.robots.httpStatus, 200);
  assert.equal(cde.robots.disallowsOurPath, false);
  assert.match(cde.robots.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(cde.robots.allowedResources,
    ['https://www.cde.ca.gov/schooldirectory/report?rid=dl1&tp=txt']);

  // El esquema se contrastó campo a campo contra el oficial, y las correcciones
  // quedan escritas: la allowlist a ciegas nombraba columnas que no existen.
  assert.equal(cde.schemaVerification.documentedFieldCount, 46);
  assert.equal(cde.schemaVerification.allowlistFieldsAllExist, true);
  assert.equal(cde.fields.allowedVerifiedAgainstSchema, true);
  for (const inventada of ['Ext', 'Email', 'AdmEmail1', 'AdmFName1']) {
    assert.ok(!cde.fields.allowed.includes(inventada));
    assert.ok(!cde.fields.neverRequested.includes(inventada),
      `prohibir "${inventada}", que no existe en el esquema, no protege nada`);
  }
  // Y la lista de nunca-pedidos es el complemento exacto sobre el esquema real.
  assert.deepEqual(
    [...cde.fields.allowed, ...cde.fields.neverRequested].sort(),
    [...cde.schemaVerification.documentedFields].sort(),
  );
  for (const personal of ['AdmFName', 'AdmLName', 'Phone', 'Phone Ext', 'FaxNumber',
    'Latitude', 'Longitude', 'MailStreet', 'MailZip']) {
    assert.ok(cde.fields.neverRequested.includes(personal), `${personal} tiene que estar prohibida`);
  }

  // La licencia: lo que se leyó y lo que no, por separado.
  assert.equal(cde.license.status, 'PARCIALMENTE_VERIFICADA');
  assert.equal(cde.license.readDocuments.length, 2);
  for (const d of cde.license.readDocuments) {
    assert.equal(d.httpStatus, 200);
    assert.match(d.sha256, /^[0-9a-f]{64}$/);
  }
  assert.equal(cde.license.unreadDocuments.length, 1);
  assert.equal(cde.license.unreadDocuments[0].evasionAttempted, false,
    'no se sortea un reto de bot-manager');
  assert.ok(cde.blockers.some((b) => /Copyright/i.test(b)));
  assert.equal(cde.replaces, 'hcai_facilities');
  assert.equal(cde.egressHost, 'www.cde.ca.gov');
  assert.notEqual(cde.egressHost, 'data.chhs.ca.gov', 'no se reutiliza el host retirado');
});

test('HCAI está retirada: ni manifiesto, ni cliente, ni regla en el árbol activo', () => {
  // Se retiró porque su robots.txt prohíbe /api/. Lo que queda es el expediente
  // en docs/retired/, no código que alguien pueda volver a enchufar.
  assert.equal(fs.existsSync(new URL('../config/scouts/hcai_facilities.json', import.meta.url).pathname), false);
  assert.equal(fs.existsSync(new URL('../config/source-attestation-hcai.json', import.meta.url).pathname), false);
  assert.equal(fs.existsSync(new URL('../src/prospecting/scouts/ckan-client.js', import.meta.url).pathname), false);
  assert.ok(!registry.SCOUT_IDS.includes('hcai_facilities'));
  assert.equal(rules.evaluateHcaiRow, undefined, 'la regla retirada sigue exportada');

  for (const dir of ['../src/prospecting/scouts/', '../src/prospecting/sources/']) {
    const base = new URL(dir, import.meta.url);
    for (const f of fs.readdirSync(base)) {
      if (!f.endsWith('.js')) continue;
      const src = fs.readFileSync(new URL(f, base), 'utf8');
      assert.ok(!/ckan-client|queryDatastore/.test(src), `${f} sigue importando el cliente retirado`);
      assert.ok(!/evaluateHcaiRow/.test(src), `${f} sigue llamando a la regla retirada`);
    }
  }
  // Y el expediente existe, con el motivo por escrito.
  const readme = fs.readFileSync(new URL('../docs/retired/README.md', import.meta.url), 'utf8');
  assert.match(readme, /Disallow: \/api\//);
});

test('el robots del publicador bloquea aunque alguien ponga enabled=true', async () => {
  // Esto es lo que impide que un "no" del publicador se sortee con un flag.
  const dir = path.join(tmpDir, 'scouts-override');
  fs.mkdirSync(dir, { recursive: true });
  // El caso real que lo motivó —HCAI— ya está retirado, así que se reconstruye:
  // una fuente con el robots leído y PROHIBIENDO, y con enabled=true encima.
  const m = JSON.parse(fs.readFileSync(new URL('../config/scouts/cde_schools.json', import.meta.url), 'utf8'));
  m.enabled = true;
  m.eligible = true;
  m.state = 'ENABLED';
  m.robots = {
    status: 'LEIDO',
    disallowsOurPath: true,
    disallowReason: 'Disallow: /schooldirectory/ para User-agent: *',
  };
  fs.writeFileSync(path.join(dir, 'cde_schools.json'), JSON.stringify(m, null, 2));
  for (const otro of ['cslb_contractors', 'hud_multifamily']) {
    fs.copyFileSync(new URL(`../config/scouts/${otro}.json`, import.meta.url), path.join(dir, `${otro}.json`));
  }

  const original = process.env.SCOUT_MANIFEST_DIR;
  process.env.SCOUT_MANIFEST_DIR = dir;
  try {
    registry.loadManifests({ reload: true, dir });
    const c = registry.checkScoutAllowed('cde_schools');
    assert.equal(c.allowed, false, 'enabled=true pasó por encima del robots del publicador');
    assert.equal(c.reason, 'robots_prohibe');
    assert.equal(c.overridable, false);
    assert.match(c.detail, /Disallow|prohíbe/i);
  } finally {
    process.env.SCOUT_MANIFEST_DIR = original;
    registry.loadManifests({ reload: true, dir: manifestDir });
  }
});

test('un robots que no se ha leído tampoco abre la puerta', async () => {
  // "Desconocer no es permiso" está escrito en el manifiesto de CDE. Esta prueba
  // comprueba que además es un cerrojo: con eligible y enabled en true, y sin
  // haber leído el robots, la puerta sigue cerrada y no es sorteable.
  const dir = path.join(tmpDir, 'scouts-sin-robots');
  fs.mkdirSync(dir, { recursive: true });
  const m = JSON.parse(fs.readFileSync(new URL('../config/scouts/cde_schools.json', import.meta.url), 'utf8'));
  m.enabled = true;
  m.eligible = true;
  // Ya no queda ninguna fuente en el repo con el robots sin leer —CDE lo leyó—,
  // así que se reconstruye ese estado: es el que hubo hasta hoy, y el cerrojo
  // tiene que seguir mordiendo.
  m.robots = { status: 'NO_LEIDO', disallowsOurPath: null, interpretation: 'no se ha leído' };
  fs.writeFileSync(path.join(dir, 'cde_schools.json'), JSON.stringify(m, null, 2));
  for (const otro of ['cslb_contractors', 'hud_multifamily']) {
    fs.copyFileSync(new URL(`../config/scouts/${otro}.json`, import.meta.url), path.join(dir, `${otro}.json`));
  }

  const original = process.env.SCOUT_MANIFEST_DIR;
  process.env.SCOUT_MANIFEST_DIR = dir;
  try {
    registry.loadManifests({ reload: true, dir });
    const c = registry.checkScoutAllowed('cde_schools');
    assert.equal(c.allowed, false, 'un robots sin leer se tomó como permiso');
    assert.equal(c.reason, 'robots_sin_leer');
    assert.equal(c.overridable, false);
    // Y la fuente que sí lo leyó —404, sin política— no queda atrapada por esto.
    assert.equal(registry.checkScoutAllowed('cslb_contractors').reason, 'no_habilitada');
  } finally {
    process.env.SCOUT_MANIFEST_DIR = original;
    registry.loadManifests({ reload: true, dir: manifestDir });
  }
});

test('la evidencia de HUD está verificada en vivo; la de los otros dos, no', async () => {
  const { attestationFor } = await import('../src/prospecting/sources/attestation.js');
  const hud = attestationFor('hud_multifamily', {
    file: path.join(process.cwd(), 'config', 'source-attestation-hud.json'),
  });
  assert.equal(hud.ok, true, (hud.problems || []).join('; '));
  assert.equal(hud.checks.liveVerifiedFromCloud, true);
  assert.equal(hud.entry.schema.allowlistFieldsAllExist, true);
  // Y el 404 del robots se registra como hallazgo, no como un 200 falso.
  assert.equal(hud.entry.artifacts.robotsTxt.httpStatus, 404);
  assert.equal(hud.entry.artifacts.robotsTxt.httpStatusIsEvidence, true);

  for (const id of ['cslb_contractors', 'cde_schools']) {
    const r = attestationFor(id, {
      file: path.join(process.cwd(), 'config', `source-attestation-${SLUG[id]}.json`),
    });
    assert.equal(r.ok, false, `${id}: su evidencia sigue pendiente`);
  }
});

test('los hosts que harían falta para una preview real son exactamente tres', () => {
  assert.deepEqual(registry.requiredEgressHosts(), ['web.cslb.ca.gov', 'egis.hud.gov', 'www.cde.ca.gov']);
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
    // Nombre REAL del control, verificado contra el portal: el `__EVENTTARGET`
    // lleva la ruta completa de ASP.NET. Con el nombre corto el postback no se
    // reconoce y el portal devuelve otra página.
    assert.equal(s.requests[1].eventTarget, 'ctl00$MainContent$ddlStatus');
    assert.equal(s.requests[1].dataType, 'M');
    assert.equal(s.requests[2].eventTarget, 'ctl00$MainContent$lbMasterCSV');
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

// ══ 3. CDE · volcado TSV del directorio ═══════════════════════
test('el volcado se descarga una sola vez, del recurso exacto y nada más', async () => {
  const s = await fx.createFakeCdeServer();
  try {
    const r = await corre('cde_schools', s);
    assert.equal(r.blocked, null);
    assert.equal(s.requests.length, 1, `hubo ${s.requests.length} peticiones`);
    assert.equal(s.requests[0].method, 'GET');
    assert.equal(s.requests[0].path, '/schooldirectory/report');
    // El volcado, no el buscador: la descarga lleva los parámetros del informe.
    assert.deepEqual(s.requests[0].query, { rid: 'dl1', tp: 'txt' });
    assert.ok(s.requests[0].userAgent, 'sin User-Agent no se identifica quién pide');
    assert.equal(r.metrics.requests, 1);
  } finally { s.close(); }
});

test('solo se descarga el recurso exacto que la auditoría permite', async () => {
  // `allowedResources` tiene UNA entrada: la URL que la página de descarga del
  // propio CDE publica. Cambiar el manifiesto para apuntar a otra cosa —otro
  // informe, otro formato, otra ruta del mismo host— no vale.
  const m = registry.manifestFor('cde_schools');
  assert.deepEqual(m.robots.allowedResources,
    ['https://www.cde.ca.gov/schooldirectory/report?rid=dl1&tp=txt']);
  assert.equal(m.downloadVerification.hrefObserved, m.downloadUrl,
    'la URL no se dedujo: se copió del enlace oficial');

  const dir = path.join(tmpDir, 'scouts-otro-recurso');
  fs.mkdirSync(dir, { recursive: true });
  const otro = JSON.parse(JSON.stringify(m));
  otro.downloadUrl = 'https://www.cde.ca.gov/schooldirectory/report?rid=dl2&tp=txt';
  fs.writeFileSync(path.join(dir, 'cde_schools.json'), JSON.stringify(otro, null, 2));
  for (const id of ['cslb_contractors', 'hud_multifamily']) {
    fs.copyFileSync(path.join(manifestDir, `${id}.json`), path.join(dir, `${id}.json`));
  }

  const original = process.env.SCOUT_MANIFEST_DIR;
  process.env.SCOUT_MANIFEST_DIR = dir;
  try {
    registry.loadManifests({ reload: true, dir });
    await assert.rejects(
      () => runScout('cde_schools', {
        cities: CIUDADES, zips: ZIPS, quotaOptions: nuevoEstado(), sleep: async () => {},
        fetchImpl: () => { throw new Error('no debería llegar a pedir nada'); },
      }),
      /no está en los recursos permitidos/,
    );
  } finally {
    process.env.SCOUT_MANIFEST_DIR = original;
    registry.loadManifests({ reload: true, dir: manifestDir });
  }
});

test('si el volcado deja de traer una columna de la allowlist, se para', async () => {
  // Es la promesa que el manifiesto hace por escrito: contrastar la cabecera y
  // fallar cerrado. Sin esto, perder `Zip` significaría dejar de exigir dirección
  // completa sin que nadie se enterase.
  const s = await fx.createFakeCdeServer({ mode: 'missingColumn' });
  try {
    await assert.rejects(() => corre('cde_schools', s), (err) => {
      assert.match(err.message, /esquema del volcado .* cambió/);
      assert.match(err.message, /Zip/);
      return true;
    });
  } finally { s.close(); }
});

test('CDE acepta solo centros activos del condado, y cuenta cada rechazo por su razón', async () => {
  const s = await fx.createFakeCdeServer();
  try {
    const r = await corre('cde_schools', s);
    const nombres = r.staging.doc.candidates.map((c) => c.businessName).sort();
    assert.deepEqual(nombres, [
      'Harbor View Elementary',
      'Mesa Verde "North" Middle School',
      'Pacific\nCharter Academy',
    ].sort());

    assert.equal(r.metrics.fetched, fx.CDE_ROWS.length);
    assert.equal(r.metrics.accepted, 3);
    assert.equal(r.metrics.rejected_out_of_area, 1, 'Orange');
    assert.equal(r.metrics.rejected_inactive, 2, 'Closed y Pending');
    assert.equal(r.metrics.rejected_unverifiable, 5,
      'dos filas de distrito u oficina, una virtual, una sin ZIP y una sin calle');
    assert.equal(r.metrics.rejected_residential, 2,
      'un Family Child Care Home y una dirección con Apt');
    assert.equal(r.metrics.deduped, 1, 'el CDSCode repetido en el mismo volcado');
    assert.equal(r.metrics.crm_writes, 0);
    assert.equal(r.metrics.outbound, 0);
    // Y todo lo que entró está contado: ni una fila se pierde por el camino.
    const sumado = r.metrics.accepted + r.metrics.deduped + r.metrics.rejected_out_of_area
      + r.metrics.rejected_inactive + r.metrics.rejected_unverifiable + r.metrics.rejected_residential;
    assert.equal(sumado, r.metrics.fetched);
  } finally { s.close(); }
});

test('un Family Child Care Home no entra, ni por el tipo ni por la dirección', () => {
  const m = registry.manifestFor('cde_schools');
  const base = {
    County: 'San Diego', StatusType: 'Active', School: 'Casa Azul Learning Center',
    Street: '900 Broadway', City: 'San Diego', Zip: '92101', CDSCode: '37683380009999',
    Virtual: 'N', SOCType: 'Preschool', DOCType: 'Unified School District', EILName: 'Preschool',
  };
  assert.equal(rules.evaluateCdeRow(base, m).ok, true);

  for (const [patch, kind] of [
    [{ School: 'Tiny Hands Family Child Care Home' }, 'residential'],
    [{ SOCType: 'FCCH' }, 'residential'],
    [{ EILName: 'Home-Based Program' }, 'residential'],
    [{ DOCType: 'In-Home Care' }, 'residential'],
    [{ Street: '12 Island Ave Apt 7B' }, 'residential'],
    [{ Street: 'PO BOX 9912' }, 'residential'],
    [{ School: 'No Data' }, 'unverifiable'],
    [{ School: '' }, 'unverifiable'],
    [{ Virtual: 'Y' }, 'unverifiable'],
    [{ Zip: '' }, 'unverifiable'],
    [{ Street: '' }, 'unverifiable'],
    [{ CDSCode: '' }, 'unverifiable'],
    [{ County: 'Orange' }, 'out_of_area'],
    [{ StatusType: 'Closed' }, 'inactive'],
    [{ School: 'Fernandez, Ana Lucia' }, 'personal'],
  ]) {
    const v = rules.evaluateCdeRow({ ...base, ...patch }, m);
    assert.equal(v.ok, false, `${JSON.stringify(patch)} se aceptó`);
    assert.equal(v.kind, kind, `${JSON.stringify(patch)} → ${v.kind}`);
    assert.ok(v.reason, 'un rechazo sin razón no se puede auditar');
  }
});

test('el sitio oficial solo se conserva si viene de la fuente, y no se visita', async () => {
  const s = await fx.createFakeCdeServer();
  try {
    const r = await corre('cde_schools', s);
    const sitios = r.staging.doc.candidates.map((c) => c.evidence.website);
    assert.ok(sitios.includes('https://pacific-charter.invalid'), 'se perdió el sitio que sí venía');
    for (const w of sitios) assert.match(w, /^https:\/\//, `"${w}" no es una URL`);
    // Solo se pidió el volcado: ni una visita a ningún sitio de los centros.
    assert.equal(s.requests.length, 1);
  } finally { s.close(); }

  const m = registry.manifestFor('cde_schools');
  const base = {
    County: 'San Diego', StatusType: 'Active', School: 'Casa Azul Learning Center',
    Street: '900 Broadway', City: 'San Diego', Zip: '92101', CDSCode: '37683380009999',
  };
  // Sin `Website` no se adivina uno a partir del nombre.
  assert.equal(rules.evaluateCdeRow({ ...base, Website: '' }, m).website, null);
  assert.equal(rules.evaluateCdeRow({ ...base, Website: 'www.x.invalid' }, m).website, 'https://www.x.invalid');
});

test('CDE no conserva administradores, teléfonos, correos ni coordenadas', async () => {
  const s = await fx.createFakeCdeServer();
  try {
    const r = await corre('cde_schools', s);
    const texto = fs.readFileSync(r.staging.file, 'utf8');
    for (const aguja of fx.PII_PROHIBIDA) {
      assert.ok(!texto.includes(aguja), `"${aguja}" entró en el staging`);
    }
    for (const prohibido of registry.neverRequested('cde_schools')) {
      assert.ok(!texto.includes(prohibido), `el nombre de columna ${prohibido} sobrevivió`);
    }
    for (const c of r.staging.doc.candidates) {
      assert.match(c.dedupKey, /^cde:/);
      assert.ok(c.address && c.city && /^\d{5}$/.test(c.zip), 'dirección comercial incompleta');
      assert.equal(c.evidence.phone, undefined);
      assert.equal(c.evidence.email, undefined);
    }
  } finally { s.close(); }
});

test('una columna nueva con datos de una persona se cae sin que nadie la prohíba', async () => {
  const s = await fx.createFakeCdeServer({ mode: 'unknownColumns' });
  try {
    const r = await corre('cde_schools', s);
    assert.equal(r.metrics.accepted, 1);
    const texto = fs.readFileSync(r.staging.file, 'utf8');
    assert.ok(!texto.includes('(619) 555-0101'));
    assert.ok(!texto.includes('principal.personal@ejemplo.invalid'));
    assert.ok(!texto.includes('PrincipalMobile'));
  } finally { s.close(); }
});

test('un 304 no gasta cuota ni produce staging a medias', async () => {
  const s = await fx.createFakeCdeServer({ mode: 'notModified' });
  const estado = nuevoEstado();
  try {
    const r = await corre('cde_schools', s, { quotaOptions: estado, etag: s.etag });
    assert.equal(r.notModified, true);
    assert.equal(r.staging, null, 'un 304 no trae filas: no hay nada que sellar');
    assert.equal(r.blocked.reason, 'sin_cambios_304');

    // Y la cuota sigue intacta: la segunda corrida vuelve a intentarlo y se para
    // otra vez en el 304 del publicador, NO en la cuota del día.
    const segunda = await corre('cde_schools', s, { quotaOptions: estado, etag: s.etag });
    assert.equal(segunda.blocked.reason, 'sin_cambios_304', 'un 304 consumió la corrida del día');
    assert.equal(s.requests.length, 2, 'la segunda corrida ni llegó a preguntar');
    const st = quota.readState(estado.stateFile);
    assert.equal(st.sources.cde_schools?.lastSuccessAt ?? null, null,
      'un 304 se anotó como corrida exitosa');
  } finally { s.close(); }
});

test('una descarga cortada no deja filas a medias ni el volcado en disco', async () => {
  const s = await fx.createFakeCdeServer({ mode: 'truncated' });
  try {
    await assert.rejects(() => corre('cde_schools', s), (err) => {
      for (const aguja of fx.PII_PROHIBIDA) {
        assert.ok(!err.message.includes(aguja), `el error filtró "${aguja}"`);
      }
      return true;
    });
    assert.deepEqual(
      fs.readdirSync(process.env.SOURCE_CSV_TMP_DIR).filter((f) => f.startsWith('cc-csv-')), [],
      'quedó en disco un volcado con correos de administradores',
    );
  } finally { s.close(); }
});

test('un volcado que anuncia más del tope, vacío o malformado es un error', async () => {
  for (const mode of ['oversize', 'empty', 'malformed']) {
    const s = await fx.createFakeCdeServer({ mode });
    try {
      await assert.rejects(() => corre('cde_schools', s), undefined, `mode=${mode} pasó`);
    } finally { s.close(); }
  }
});

test('el tope de 50 por corrida se respeta aunque el volcado traiga miles', async () => {
  const muchas = Array.from({ length: 120 }, (_, i) => fx.cdeRow({
    CDSCode: `3768338${String(i).padStart(7, '0')}`,
    School: `Escuela Numero ${i} Elementary`,
  }));
  const s = await fx.createFakeCdeServer({ body: fx.cdeTsv(muchas) });
  try {
    const r = await corre('cde_schools', s);
    assert.equal(r.metrics.accepted, 50, `aceptó ${r.metrics.accepted}`);
    assert.equal(r.staging.doc.candidates.length, 50);
  } finally { s.close(); }
});

test('el tabulador es el delimitador, y una coma dentro de un campo no lo parte', async () => {
  const s = await fx.createFakeCdeServer({
    body: fx.cdeTsv([fx.cdeRow({
      CDSCode: '37683380007777', School: 'Bayside Academy, Lower Campus',
      Street: '77 Bay Blvd, Suite 2', City: 'San Diego', Zip: '92101',
    })]),
  });
  try {
    const r = await corre('cde_schools', s);
    assert.equal(r.metrics.accepted, 1);
    const c = r.staging.doc.candidates[0];
    assert.equal(c.businessName, 'Bayside Academy, Lower Campus');
    assert.equal(c.address, '77 Bay Blvd, Suite 2');
  } finally { s.close(); }
});

test('la procedencia del volcado trae su huella, y no afirma una licencia que no se leyó', async () => {
  const s = await fx.createFakeCdeServer();
  try {
    const r = await corre('cde_schools', s);
    const pr = r.staging.doc.provenance;
    assert.match(pr.fileSha256, /^[0-9a-f]{64}$/);
    assert.ok(pr.fileBytes > 0);
    assert.equal(pr.delimiter, 'tab');
    assert.equal(pr.license.status, 'PARCIALMENTE_VERIFICADA');
    // La procedencia lleva lo que se leyó Y lo que no: una ficha que solo
    // enseñara los documentos favorables no sería procedencia, sería publicidad.
    assert.equal(pr.license.readDocuments.length, 2);
    assert.equal(pr.license.unreadDocuments.length, 1);
    assert.match(pr.license.conclusion, /no se ha podido leer|no restringen/);
    // Y la cabecera que se procesó queda contada, sin copiar un solo nombre de
    // columna: un volcado con la cabecera corrida metería texto arbitrario aquí.
    assert.equal(pr.headerColumns, fx.CDE_HEADER.length);
    assert.equal(pr.headerUnexpectedCount, 0);
    assert.equal(pr.headerUnexpected, undefined);
  } finally { s.close(); }
});

// ══ Privacidad transversal ════════════════════════════════════
test('ningún staging de los tres lleva un solo dato personal', async () => {
  for (const [scoutId, crear] of [
    ['cslb_contractors', fx.createFakeCslbServer],
    ['hud_multifamily', fx.createFakeArcgisServer],
    ['cde_schools', fx.createFakeCdeServer],
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
  const { row, descartados } = trimToAllowed('cde_schools', {
    CDSCode: '1', School: 'Harbor View Elementary', Latitude: 32.7,
    AdmEmail1: 'afernandez@ejemplo.invalid', Phone: '(619) 555-0142', COLUMNA_NUEVA: 'z',
  });
  assert.deepEqual(Object.keys(row).sort(), ['CDSCode', 'School']);
  assert.ok(descartados.includes('Latitude') && descartados.includes('AdmEmail1'));
  assert.ok(descartados.includes('Phone'));
  assert.ok(descartados.includes('COLUMNA_NUEVA'), 'una columna nueva tiene que caerse sola');
  assert.throws(() => assertOnlyAllowed('cde_schools', { Latitude: 1 }), /no permitida/);
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
  const s = await fx.createFakeCdeServer();
  try {
    const r = await corre('cde_schools', s);
    assert.ok(r.staging);
    assert.deepEqual(crm.requests, [], 'el scout habló con el CRM');
    assert.equal(r.metrics.crm_writes, 0);
  } finally { crm.server.close(); s.close(); }
});

// ══ Cuotas y guards independientes ════════════════════════════
test('cada scout tiene su cuota y no estorba a los demás ni a County/City', async () => {
  const estado = nuevoEstado();
  const s = await fx.createFakeCdeServer();
  try {
    const primera = await corre('cde_schools', s, { quotaOptions: estado });
    assert.equal(primera.blocked, null);
    const segunda = await corre('cde_schools', s, { quotaOptions: estado });
    assert.equal(segunda.blocked.reason, 'cuota_24h');
  } finally { s.close(); }

  const st = quota.readState(estado.stateFile);
  assert.ok(st.sources.cde_schools, 'no se registró la corrida del scout');
  for (const otro of ['cslb_contractors', 'hud_multifamily',
    'sdcounty_food_facility_permits', 'sd_business_tax_certificates']) {
    assert.equal(st.sources[otro], undefined, `la cuota de ${otro} se vio afectada`);
  }
});

test('el guard durable de cada scout mira su propio prefijo', async () => {
  const AHORA = Date.parse('2026-10-05T12:00:00.000Z');
  const lookup = (porPrefijo) => async (prefix) => porPrefijo[prefix] ?? null;
  const reciente = { dedupKey: 'cde:37683380000001', lastVerified: new Date(AHORA - 3600000).toISOString() };

  const bloqueado = await checkDurableQuota({ namespace: 'cde', now: AHORA, lookup: lookup({ 'cde:': reciente }) });
  assert.equal(bloqueado.allowed, false);
  assert.equal(bloqueado.reason, 'cuota_24h_durable');

  // Y los otros dos, con el mismo CRM, siguen permitidos.
  for (const ns of ['cslb', 'hud-mf', 'sdcounty-ffp', 'city-btc']) {
    const r = await checkDurableQuota({ namespace: ns, now: AHORA, lookup: lookup({ 'cde:': reciente }) });
    assert.equal(r.allowed, true, `${ns} se dejó bloquear por cde`);
  }
});

test('con la cuota durable bloqueada no se toca el portal', async () => {
  const s = await fx.createFakeCdeServer();
  try {
    const r = await corre('cde_schools', s, {
      durableQuotaOptions: {
        // Marca de hace una hora, fija: un `Date.now()` y un `new Date()` en la
        // misma expresión pueden diferir un milisegundo, y entonces la prueba
        // mide el desfase de reloj en lugar de la cuota.
        now: Date.parse('2026-10-05T12:00:00.000Z'),
        lookup: async () => ({ dedupKey: 'cde:1', lastVerified: '2026-10-05T11:00:00.000Z' }),
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
  const s = await fx.createFakeCdeServer();
  try {
    const r = await corre('cde_schools', s);
    assert.match(r.staging.hash, /^sha256:[0-9a-f]{64}$/);
    assert.match(r.staging.doc.runId, /^run_/);
    assert.ok(new Date(r.staging.doc.expiresAt) > new Date(r.staging.doc.createdAt));

    const leido = staging.readStaging(r.staging.file);
    assert.equal(leido.ok, true, leido.problems.join('; '));
    assert.equal(leido.doc.runId, r.staging.doc.runId);
  } finally { s.close(); }
});

test('tocar el staging invalida su hash', async () => {
  const s = await fx.createFakeCdeServer();
  try {
    const r = await corre('cde_schools', s);
    const doc = JSON.parse(fs.readFileSync(r.staging.file, 'utf8'));
    doc.candidates.push({ dedupKey: 'cde:colado', businessName: 'Colado A Mano' });
    fs.writeFileSync(r.staging.file, JSON.stringify(doc, null, 2));

    const leido = staging.readStaging(r.staging.file);
    assert.equal(leido.ok, false);
    assert.ok(leido.problems.some((p) => /hash no coincide/.test(p)));
  } finally { s.close(); }
});

test('un staging caducado o de otra sesión no se reutiliza', () => {
  const viejo = staging.writeStaging({
    scoutId: 'cde_schools', displayName: 'X', candidates: [], metrics: {},
    provenance: { license: {}, collectedAt: '2026-10-04T00:00:00.000Z', egressHost: 'www.cde.ca.gov' },
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
    ['cde_schools', fx.createFakeCdeServer],
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
  const v = intake.validateStaging('hud_multifamily', docs.cde_schools.file);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => /dice ser de/.test(p)));
});

test('la capa central caza PII colada a mano en un staging', async () => {
  const docs = await tresStagings();
  const doc = JSON.parse(fs.readFileSync(docs.cde_schools.file, 'utf8'));
  doc.candidates[0].evidence.contactPhone = '619-555-0101';
  doc.sha256 = staging.computeHash(doc);   // se re-sella: el hash ya no salva
  const file = path.join(tmpDir, 'con-pii.json');
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));

  const v = intake.validateStaging('cde_schools', file);
  assert.equal(v.ok, false);
  const texto = v.problems.join(' | ');
  assert.ok(/suena a dato personal/.test(texto) || /un teléfono/.test(texto),
    `no se detectó: ${texto}`);
});

test('la capa central no deja pasar más candidatos que el tope de la fuente', async () => {
  const docs = await tresStagings();
  const doc = JSON.parse(fs.readFileSync(docs.cde_schools.file, 'utf8'));
  doc.candidates = Array.from({ length: 51 }, (_, i) => ({
    dedupKey: `cde:${i}`, sourceId: String(i), businessName: `Escuela ${i} Elementary`,
    address: '1 A St', city: 'San Diego', zip: '92101', serviceArea: 'San Diego County, CA',
    sourceUrl: 'https://www.cde.ca.gov/schooldirectory/', evidence: {}, matchKeys: { name: `clinica${i}`, cross: null },
  }));
  doc.sha256 = staging.computeHash(doc);
  const file = path.join(tmpDir, 'demasiados.json');
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));

  const v = intake.validateStaging('cde_schools', file);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => /por encima del tope/.test(p)));
});

test('la deduplicación contra las Companies existentes omite, no modifica', async () => {
  const docs = await tresStagings();
  const stagings = Object.fromEntries(Object.entries(docs).map(([k, v]) => [k, v.doc]));
  const index = indiceVacio();
  const primero = stagings.cde_schools.candidates[0];
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
    cde_schools: {
      scoutId: 'cde_schools',
      candidates: [{
        dedupKey: 'cde:1', businessName: 'Harbor View Elementary', address: '1200 Harbor Blvd',
        matchKeys: { name: 'harborviewelementary', cross: 'harborviewelementary|1200harborblvd' },
      }],
    },
    hud_multifamily: {
      scoutId: 'hud_multifamily',
      candidates: [{
        dedupKey: 'hud-mf:1', businessName: 'Harbor View Elementary', address: '1200 Harbor Blvd',
        matchKeys: { name: 'harborviewelementary', cross: 'harborviewelementary|1200harborblvd' },
      }],
    },
    cslb_contractors: {
      scoutId: 'cslb_contractors',
      candidates: [{
        dedupKey: 'cslb:1', businessName: 'Harbor View Elementary', address: null,
        matchKeys: { name: 'harborviewelementary', cross: null },
      }],
    },
  };

  const plan = intake.reconcile({ stagings, crmIndex: indiceVacio() });
  assert.equal(plan.create.length, 1, 'la misma entidad se creó más de una vez');
  assert.equal(plan.create[0].scoutId, 'cde_schools', 'ganó la fuente equivocada');
  assert.equal(plan.conflicts.length, 2);
  for (const c of plan.conflicts) {
    assert.equal(c.winner, 'cde_schools');
    assert.ok(c.rationale, 'un conflicto sin razón escrita no se puede revisar');
  }

  // Y el orden no depende del orden de las claves del objeto.
  const alRevés = {
    cslb_contractors: stagings.cslb_contractors,
    hud_multifamily: stagings.hud_multifamily,
    cde_schools: stagings.cde_schools,
  };
  const plan2 = intake.reconcile({ stagings: alRevés, crmIndex: indiceVacio() });
  assert.deepEqual(plan2.create.map((c) => c.candidate.dedupKey), plan.create.map((c) => c.candidate.dedupKey));
});

test('la prioridad documentada cubre las tres fuentes y explica por qué', () => {
  assert.deepEqual(intake.SOURCE_PRIORITY, ['cde_schools', 'hud_multifamily', 'cslb_contractors']);
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
    perSource: { cde_schools: 3 }, disabledSources: [], staleSources: [], invalidStagings: [],
  };
  assert.deepEqual(intake.refusalsFor(base), []);

  const casos = [
    [{ objects: ['companies', 'people'] }, 'objeto_no_permitido'],
    [{ objects: ['companies', 'opportunities'] }, 'objeto_no_permitido'],
    [{ objects: ['companies', 'notes'] }, 'objeto_no_permitido'],
    [{ operations: ['create', 'update'] }, 'operacion_no_permitida'],
    [{ operations: ['create', 'delete'] }, 'operacion_no_permitida'],
    [{ perSource: { cde_schools: 51 } }, 'por_encima_del_tope'],
    [{ disabledSources: ['cslb_contractors'] }, 'fuente_deshabilitada'],
    [{ staleSources: ['hud_multifamily'] }, 'constancia_o_cuota_vencida'],
    [{ invalidStagings: ['cde_schools'] }, 'staging_alterado'],
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

// ══ La Routine diaria ═════════════════════════════════════════
test('la Routine diaria orquesta la fase 3 en secuencia, y nunca la escribe', () => {
  const src = fs.readFileSync(new URL('../scripts/routine-daily.js', import.meta.url), 'utf8');

  // Las dos fuentes de la fase anterior siguen primero y con su comando intacto.
  assert.match(src, /const ORDEN = \['sdcounty_food_facility_permits', 'sd_business_tax_certificates'\]/);
  // Y la fase 3 va después, consultando la puerta scout a scout.
  const i = src.indexOf("banner('ENRIQUECIMIENTO");
  const j = src.indexOf("banner('FASE 3");
  assert.ok(i > 0 && j > i, 'la fase 3 no va al final de la corrida');

  const bloque = src.slice(j, src.indexOf("banner('RESUMEN DE LA CORRIDA')"));
  assert.match(bloque, /phase3-run\.js/);
  assert.match(bloque, /'preview'/);
  assert.match(bloque, /'plan'/);
  assert.ok(!bloque.includes("'apply'"), 'la Routine podría lanzar el apply de la fase 3');
  assert.ok(!bloque.includes('--allow-writes'), 'la Routine podría escribir la fase 3');
  assert.ok(!bloque.includes('TWENTY_WRITE_ENABLED'), 'la Routine toca el flag de escritura de la fase 3');
  // Una fuente bloqueada se reporta y se sigue: no es una alerta.
  assert.match(bloque, /NO es una alerta/);
  assert.match(bloque, /checkScoutAllowed/);
});

// ══ El orquestador ════════════════════════════════════════════
test('el orquestador no escribe por defecto y el apply exige los cuatro cerrojos', () => {
  const src = fs.readFileSync(new URL('../scripts/phase3-run.js', import.meta.url), 'utf8');

  // El guard duro del outbound va antes de los subcomandos.
  assert.match(src, /assertOutboundDisabled\(config\)/);
  // Lock global en la orquestación.
  assert.match(src, /withPhaseLock/);

  // Los cuatro cerrojos, y se comprueban TODOS antes de rechazar, para que el
  // motivo que se reporta sea el real y no "el primero que falló".
  for (const cerrojo of ['--confirm', '--allow-writes', 'expect-hashes', 'TWENTY_WRITE_ENABLED=true']) {
    assert.ok(src.includes(cerrojo), `el apply no exige ${cerrojo}`);
  }
  assert.match(src, /faltan: \$\{faltan\.join/, 'no reporta todos los cerrojos que faltan');

  // El hash autorizado se compara con el del archivo: no vale "el último que haya".
  assert.match(src, /se aplica el staging que se revisó, no otro/);
  // Y una fuente no permitida no puede colar su staging.
  assert.match(src, /no está permitida .*no se aplica su staging/);

  // Preview y plan no escriben: solo el apply lo hace.
  const preview = src.slice(src.indexOf('async function preview()'), src.indexOf('async function plan()'));
  assert.ok(!/upsertCompany/.test(preview), 'la preview podría escribir');
});

test('la capa central no escribe, y el orquestador solo puede crear Companies', () => {
  // La capa central: ni un verbo de escritura. Planifica y nada más.
  const central = fs.readFileSync(new URL('../src/prospecting/scouts/intake.js', import.meta.url), 'utf8');
  for (const re of [/\.post\(/, /\.patch\(/, /\.delete\(/, /method:\s*'(POST|PATCH|DELETE)'/]) {
    assert.ok(!re.test(central), `la capa central contiene ${re}`);
  }

  // El orquestador sí escribe, porque es el único que puede. Lo que no puede es
  // mutar lo existente ni tocar otra colección, y las dos cosas están cerradas.
  const orq = fs.readFileSync(new URL('../scripts/phase3-run.js', import.meta.url), 'utf8');
  assert.ok(!/\.patch\(/.test(orq), 'el orquestador puede hacer PATCH');
  assert.ok(!/\.delete\(/.test(orq), 'el orquestador puede hacer DELETE');
  assert.match(orq, /counts\.PATCH \|\| counts\.DELETE \|\| counts\.PUT/,
    'no comprueba que no hubo métodos de mutación');
  assert.match(orq, /solo habla con \/rest\/companies/,
    'no impide hablar con otra colección');
  assert.match(orq, /solo se permite create/,
    'un upsert que resolviera "update" tiene que parar la carga');
  for (const prohibido of ['/people', '/opportunities', '/notes', '/messageCampaigns', 'outreach']) {
    assert.ok(!orq.includes(prohibido), `el orquestador menciona ${prohibido}`);
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
  // County, City y ahora HUD están verificadas; CSLB y CDE siguen pendientes.
  assert.match(salida, /3 válida\(s\) · 2 pendiente\(s\) por diseño · 0 con problemas/);
  assert.match(salida, /PENDIENTE por diseño/);
  assert.match(salida, /mantiene su fuente apagada/);
});
