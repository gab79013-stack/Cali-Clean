import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Base aislada y outbound encendido: este archivo ejercita el pipeline entero.
const dbFile = path.join(os.tmpdir(), `cc-prospect-${Date.now()}.db`);
const attFile = path.join(os.tmpdir(), `cc-prospect-att-${Date.now()}.json`);
const allowFile = path.join(os.tmpdir(), `cc-prospect-allow-${Date.now()}.json`);

// Allowlist propio del test: copia del real con la fuente SODA habilitada.
// El pipeline se ejercita cruzando la puerta de verdad, no esquivándola; el
// allowlist versionado sigue con todas las fuentes apagadas.
const realAllowlist = JSON.parse(
  fs.readFileSync(new URL('../config/source-allowlist.json', import.meta.url), 'utf8'),
);
realAllowlist.sources.sdcounty_food_facility_permits.enabled = true;
fs.writeFileSync(allowFile, JSON.stringify(realAllowlist, null, 2));

process.env.DB_PATH = dbFile;
process.env.SOURCE_ATTESTATION_PATH = attFile;
process.env.SOURCE_ALLOWLIST_PATH = allowFile;
// El estado de cuota, aparte: una prueba no puede gastarse la cuota del
// despliegue ni dejar bloqueada la fuente durante 24 h en data/.
process.env.SOURCE_RUNTIME_STATE_PATH = path.join(os.tmpdir(), `cc-prospect-quota-${Date.now()}.json`);
process.env.OUTBOUND_ENABLED = 'true';
process.env.OUTBOUND_REQUIRE_MX = 'false';
process.env.OUTBOUND_DAILY_LIMIT = '25';
process.env.SERVICE_ZIPS = '92101,92103,92113';
process.env.PROSPECT_CRAWL_DELAY_MS = '0';
process.env.MAIL_DRIVER = 'log';
process.env.APP_SECRET = 'test-secret-for-prospecting';

const { createFakeServer, DATOS_PROHIBIDOS } = await import('./fixtures/fake-sources.js');
const { db } = await import('../src/db.js');
const { setRequestRewriter } = await import('../src/prospecting/http.js');
const { discover, dedupeKey } = await import('../src/prospecting/agents/discover.js');
const { enrich, domainCandidates, extractEmails, verifyMatch } = await import('../src/prospecting/agents/enrich.js');
const { qualify } = await import('../src/prospecting/agents/qualify.js');
const { outreach } = await import('../src/prospecting/agents/outreach.js');
const { classify } = await import('../src/prospecting/icp.js');
const { parseRobots, robotsAllows } = await import('../src/prospecting/http.js');

/**
 * Cuota propia para cada corrida del descubridor.
 *
 * El límite de 1 corrida con éxito cada 24 h es correcto en producción y se
 * prueba en test/soda-quota.test.js y test/source-defense.test.js. Aquí
 * estorbaría: lo que se comprueba en este archivo es el pipeline, y hace falta
 * poder correrlo dos veces seguidas para ver que no duplica.
 */
let nCorrida = 0;
const cuotaAislada = () => {
  const f = path.join(os.tmpdir(), `cc-prospect-run-${Date.now()}-${nCorrida++}.json`);
  return { quotaOptions: { stateFile: f, lockFile: `${f}.lock` } };
};
const guards = await import('../src/prospecting/guards.js');
const { toPayload } = await import('../src/services/crm.js');
const { validateCopy, buildBrief } = await import('../src/prospecting/agents/write.js');
const { saveAttestation } = await import('../src/prospecting/sources/compliance.js');

// Las fuentes del fixture pasan por la misma puerta de cumplimiento que las
// reales: aquí se registra la constancia en lugar de esquivarla, para que el
// pipeline se pruebe tal y como se ejecuta en producción.
for (const key of ['sdcounty_food_facility_permits']) {
  saveAttestation(key, {
    robotsAllowed: true,
    endpointVerified: true,
    termsReviewed: true,
    verifiedAt: new Date().toISOString(),
    note: 'constancia de prueba contra el servidor local del fixture',
  });
}

const { server, port } = await createFakeServer();
const base = `http://127.0.0.1:${port}`;

// Las peticiones a los dominios simulados van al servidor local, conservando
// el host para que el fixture sepa qué sitio servir.
setRequestRewriter((url) => {
  const u = new URL(url);
  return { url: `${base}${u.pathname}${u.search}`, headers: { 'X-Forwarded-Host': u.host } };
});

test.after(() => {
  server.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
  fs.rmSync(allowFile, { force: true });
});

// ── Clasificación ────────────────────────────────────────────
test('clasifica cada negocio en su segmento', () => {
  assert.equal(classify({ businessName: 'Harbor View Dental', naics: '621210' }).segment, 'office_clinic');
  assert.equal(classify({ businessName: 'Gaslamp Property Group', naics: '531311' }).segment, 'property_manager');
  assert.equal(classify({ businessName: 'Taqueria El Faro', naics: '722511' }).segment, 'restaurant_retail');
  assert.equal(classify({ signalType: 'permit_finaled', businessName: 'Cualquiera' }).segment, 'post_construction');
});

test('un negocio fuera del ICP no se clasifica', () => {
  const r = classify({ businessName: 'Quiet Books LLC', naics: '511130' });
  assert.equal(r.segment, null);
  assert.equal(r.confidence, 0);
});

// ── Deduplicación ────────────────────────────────────────────
test('el mismo negocio escrito de dos formas produce la misma clave', () => {
  const a = dedupeKey({ businessName: 'Harbor View Dental, Inc.', address: '1200 Harbor Blvd', zip: '92101' });
  const b = dedupeKey({ businessName: 'HARBOR VIEW DENTAL LLC', address: '1200 Harbor Blvd', zip: '92101' });
  assert.equal(a, b);
});

test('el dominio manda sobre el nombre al deduplicar', () => {
  const key = dedupeKey({ businessName: 'X', website: 'https://www.acme.com/contact' });
  assert.equal(key, 'web:acme.com');
});

// ── robots.txt ───────────────────────────────────────────────
test('respeta un robots.txt que prohíbe todo', () => {
  const { rules } = parseRobots('User-agent: *\nDisallow: /\n');
  assert.equal(robotsAllows(rules, '/'), false);
  assert.equal(robotsAllows(rules, '/contact'), false);
});

test('la regla más específica gana sobre la general', () => {
  const { rules } = parseRobots('User-agent: *\nDisallow: /\nAllow: /contact\n');
  assert.equal(robotsAllows(rules, '/contact'), true);
  assert.equal(robotsAllows(rules, '/private'), false);
});

test('sin robots.txt se permite el rastreo', () => {
  const { rules } = parseRobots('');
  assert.equal(robotsAllows(rules, '/cualquier-cosa'), true);
});

// ── Extracción ───────────────────────────────────────────────
test('prioriza el correo del propio dominio y descarta los de plantilla', () => {
  const html = `<a href="mailto:jobs@harborviewdental.com">jobs</a>
    <a href="mailto:front.desk@harborviewdental.com">contacto</a>
    name@example.com sentry@wixpress.com`;
  const emails = extractEmails(html, 'harborviewdental.com');
  assert.equal(emails[0], 'front.desk@harborviewdental.com');
  assert.ok(!emails.includes('name@example.com'));
  assert.ok(!emails.includes('sentry@wixpress.com'));
});

test('genera candidatos de dominio razonables', () => {
  const c = domainCandidates('Harbor View Dental, Inc.');
  assert.ok(c.includes('harborviewdental.com'));
});

test('no acepta una web que no corresponde al negocio', () => {
  const html = '<h1>Quiet Books of Vermont</h1><p>orders@quietbooks.com</p>';
  const m = verifyMatch(html, { businessName: 'Quiet Books LLC', zip: '93650', address: '5 Nowhere Rd' });
  assert.equal(m.matched, false);
});

test('una sola coincidencia no basta, dos sí', () => {
  const weak = verifyMatch('<p>Harbor View Dental</p>', { businessName: 'Harbor View Dental', zip: '92101' });
  assert.equal(weak.matched, false, 'solo el nombre no debería bastar');
  const strong = verifyMatch('<p>Harbor View Dental · 92101</p>', { businessName: 'Harbor View Dental', zip: '92101' });
  assert.equal(strong.matched, true);
});

// ── Pipeline completo ────────────────────────────────────────
test('el agente descubridor carga prospectos clasificables y descarta el resto', async () => {
  const stats = await discover({ sources: ['sdcounty_food_facility_permits'], sinceDays: 90, baseOverride: base, fetchOptions: cuotaAislada() });
  assert.ok(stats.inserted >= 4, `esperaba al menos 4 prospectos, hubo ${stats.inserted}`);
  assert.ok(stats.unclassified >= 1, 'la editorial debería quedar fuera del ICP');
  assert.deepEqual(stats.errors, []);

  const names = db.prepare('SELECT business_name FROM prospects').all().map((r) => r.business_name);
  assert.ok(names.some((n) => n.includes('Harbor View Dental')));
  assert.ok(!names.some((n) => n.includes('Quiet Books')), 'un negocio fuera del ICP no debe entrar');
});

test('ningún dato personal sobrevive al pipeline, ni en raw_json', () => {
  // El servidor del fixture devuelve los campos prohibidos a propósito,
  // ignorando el $select. Esta prueba comprueba que el filtrado del cliente es
  // una red real: lo que llega a disco no puede contener un dato personal.
  const filas = db.prepare('SELECT * FROM prospects').all();
  assert.ok(filas.length >= 4);

  const volcado = JSON.stringify(filas);
  for (const aguja of DATOS_PROHIBIDOS) {
    assert.ok(!volcado.includes(aguja),
      `"${aguja}" quedó almacenado en la tabla prospects`);
  }

  // Y en concreto en raw_json, que es donde se guarda la fila tal cual vino.
  for (const fila of filas) {
    const raw = JSON.parse(fila.raw_json || '{}');
    for (const prohibido of ['permit_owner_full', 'permit_owner', 'permit_owner_email', 'latitude', 'longitude']) {
      assert.ok(!(prohibido in raw), `${prohibido} sobrevivió en raw_json de ${fila.business_name}`);
    }
    // Lo permitido sí tiene que estar: el filtro no puede vaciar la fila.
    assert.ok(raw.record_id, `raw_json de ${fila.business_name} perdió los campos útiles`);
  }
});

test('el nombre del negocio conserva sus tildes', () => {
  const taqueria = db.prepare("SELECT * FROM prospects WHERE business_name LIKE '%Faro%'").get();
  assert.equal(taqueria.business_name, 'Taquería El Faro');
});

test('una segunda corrida no duplica nada', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM prospects').get().n;
  const stats = await discover({ sources: ['sdcounty_food_facility_permits'], sinceDays: 90, baseOverride: base, fetchOptions: cuotaAislada() });
  const after = db.prepare('SELECT COUNT(*) AS n FROM prospects').get().n;
  assert.equal(after, before);
  assert.ok(stats.duplicates > 0);
});

test('el enriquecedor encuentra correos, respeta robots.txt y rechaza lo que no verifica', async () => {
  const stats = await enrich({ skipDns: true });
  assert.ok(stats.enriched >= 2, `esperaba al menos 2 enriquecidos, hubo ${stats.enriched}`);

  const dental = db.prepare("SELECT * FROM prospects WHERE business_name LIKE '%Harbor View Dental%'").get();
  assert.equal(dental.stage, 'enriched');
  assert.equal(dental.email, 'front.desk@harborviewdental.com');
  assert.equal(dental.email_source, 'published_on_website');

  // El sitio con Disallow: / publica un correo en su home, pero prohíbe el
  // rastreo: el agente no lo toma y deja constancia del motivo.
  const harbor = db.prepare("SELECT * FROM prospects WHERE business_name LIKE '%Gaslamp Property%'").get();
  assert.equal(harbor.stage, 'rejected');
  assert.equal(harbor.email, null);
  assert.equal(harbor.reject_reason, 'robots_disallow');

  // La taquería publica teléfono pero no correo: no se inventa uno.
  const taco = db.prepare("SELECT * FROM prospects WHERE business_name LIKE '%Faro%'").get();
  assert.equal(taco.stage, 'rejected');
  assert.equal(taco.reject_reason, 'no_public_email');
  assert.equal(taco.email, null);
});

test('el cualificador puntúa y filtra por umbral y zona', () => {
  const stats = qualify({});
  assert.ok(stats.qualified >= 1, `esperaba al menos 1 cualificado, hubo ${stats.qualified}`);

  const dental = db.prepare("SELECT * FROM prospects WHERE business_name LIKE '%Harbor View Dental%'").get();
  assert.equal(dental.stage, 'qualified');
  assert.ok(dental.icp_score >= 45);
  assert.ok(dental.est_annual_value > 0, 'un contrato recurrente debe tener valor anual');

  const reasons = JSON.parse(dental.evidence_json).qualify.reasons;
  assert.ok(reasons.some((r) => /abri|Segmento/i.test(r.reason)));
});

test('el agente de contacto crea el lead y encola la secuencia en frío', async () => {
  const stats = await outreach({});
  assert.ok(stats.engaged >= 1, `esperaba al menos 1 contactado, hubo ${stats.engaged}`);

  const dental = db.prepare("SELECT * FROM prospects WHERE business_name LIKE '%Harbor View Dental%'").get();
  assert.equal(dental.stage, 'contacted');
  assert.ok(dental.lead_id);

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(dental.lead_id);
  assert.equal(lead.contact_channel, 'outbound');
  assert.equal(lead.company, 'Harbor View Dental');
  assert.equal(lead.email, 'front.desk@harborviewdental.com');
  assert.equal(lead.utm_medium, 'cold_email');

  const steps = db.prepare('SELECT * FROM sequence_steps WHERE lead_id = ? ORDER BY scheduled_at').all(lead.id);
  assert.equal(steps.length, 4, 'la secuencia en frío son cuatro toques');
  assert.equal(steps[0].sequence, 'outbound');

  const copy = JSON.parse(dental.copy_json);
  for (const key of ['subject', 'opener', 'value', 'ask']) assert.ok(copy[key]);
  assert.ok(copy.opener.includes('Harbor View Dental'), 'el correo debe nombrar al negocio');
});

// ── Salvaguardas ─────────────────────────────────────────────
test('un correo suprimido nunca vuelve a entrar en el embudo', async () => {
  guards.suppress('blocked@example.com', { reason: 'test' });
  const check = await guards.canSendOutbound('blocked@example.com');
  assert.equal(check.allowed, false);
  assert.ok(check.reason.startsWith('email_suppressed'));
});

test('un dominio suprimido bloquea todos sus buzones', async () => {
  guards.suppress('competencia.com', { kind: 'domain', reason: 'competidor' });
  const check = await guards.canSendOutbound('quien.sea@competencia.com');
  assert.equal(check.allowed, false);
  assert.ok(check.reason.startsWith('domain_suppressed'));
});

test('no se contacta dos veces al mismo dominio', async () => {
  guards.recordOutbound({ email: 'uno@midominio.com' });
  const check = await guards.canSendOutbound('otro@midominio.com');
  assert.equal(check.allowed, false);
  assert.equal(check.reason, 'domain_cooldown');
});

test('el interruptor general detiene todo envío en frío', async () => {
  const { config } = await import('../src/config.js');
  config.outbound.enabled = false;
  const check = await guards.canSendOutbound('alguien@nuevodominio.com');
  assert.equal(check.allowed, false);
  assert.equal(check.reason, 'outbound_disabled');
  config.outbound.enabled = true;
});

test('el calentamiento sube el cupo un escalón por día', async () => {
  const { config } = await import('../src/config.js');
  const original = { ...config.outbound };
  config.outbound.warmupStartDate = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  config.outbound.warmupStart = 10;
  config.outbound.warmupStep = 5;
  config.outbound.dailyLimit = 100;
  assert.equal(guards.dailyAllowance(), 25, '10 + 3 días × 5');

  config.outbound.dailyLimit = 20;
  assert.equal(guards.dailyAllowance(), 20, 'nunca supera el tope configurado');
  Object.assign(config.outbound, original);
});

test('el cupo agotado frena el contacto sin descartar prospectos', async () => {
  const { config } = await import('../src/config.js');
  const original = config.outbound.dailyLimit;
  config.outbound.dailyLimit = 0;
  const stats = await outreach({});
  assert.equal(stats.engaged, 0);
  assert.ok(stats.reasons.daily_limit_reached);
  config.outbound.dailyLimit = original;
});

// ── Redacción ────────────────────────────────────────────────
test('rechaza un texto del modelo con marcadores sin rellenar', () => {
  const brief = buildBrief({ business_name: 'Harbor View Dental', signal_json: '{}', locale: 'es' }, null);
  const bad = validateCopy({ subject: 'Hola {{nombre}}', opener: 'x', value: 'y', ask: 'z' }, brief);
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'unfilled_placeholder');
});

test('rechaza un texto que no nombra al negocio', () => {
  const brief = buildBrief({ business_name: 'Harbor View Dental', signal_json: '{}', locale: 'es' }, null);
  const generic = validateCopy({ subject: 'Limpieza profesional', opener: 'Hola', value: 'Somos buenos', ask: '¿Hablamos?' }, brief);
  assert.equal(generic.ok, false);
  assert.equal(generic.reason, 'business_name_missing');
});

test('acepta un texto correcto', () => {
  const brief = buildBrief({ business_name: 'Harbor View Dental', signal_json: '{}', locale: 'es' }, null);
  const ok = validateCopy({
    subject: 'Harbor View Dental: limpieza de consultorio',
    opener: 'Vi que Harbor View Dental abrió hace poco.',
    value: 'Trabajamos con consultorios en Los Ángeles.',
    ask: '¿Le paso un número esta semana?',
  }, brief);
  assert.equal(ok.ok, true);
});

// ── CRM ──────────────────────────────────────────────────────
test('el payload del CRM lleva el rastro completo de la prospección', () => {
  const prospect = db.prepare("SELECT * FROM prospects WHERE stage='contacted'").get();
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(prospect.lead_id);
  const payload = toPayload(lead, prospect);

  assert.equal(payload.channel, 'outbound');
  assert.equal(payload.contact.email, lead.email);
  assert.equal(payload.company, prospect.business_name);
  assert.ok(payload.value.annual >= 0);
  assert.equal(payload.prospecting.prospect_id, prospect.uid);
  assert.equal(payload.prospecting.email_source, 'published_on_website');
  assert.ok(payload.prospecting.signal);
  assert.ok(Array.isArray(payload.scoring.reasons));
});
