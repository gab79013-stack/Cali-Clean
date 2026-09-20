import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Adaptadores y detector de CRM, contra servidores que imitan las respuestas
 * documentadas de cada producto.
 */

const dbFile = path.join(os.tmpdir(), `cc-crm-${Date.now()}.db`);
process.env.DB_PATH = dbFile;
process.env.APP_SECRET = 'test-crm-secret';
process.env.MAIL_DRIVER = 'log';

const { createFakeCrmServer, CREATED } = await import('./fixtures/fake-crms.js');
const { adapters } = await import('../src/services/crm/adapters.js');
const { detectCrm } = await import('../src/services/crm/detect.js');
const { toPayload, http, crmStatus } = await import('../src/services/crm.js');
const { config } = await import('../src/config.js');

const { server, port } = await createFakeCrmServer();
const base = `http://127.0.0.1:${port}`;

test.after(() => {
  server.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
});

const LEAD = {
  id: 1, uid: 'lead-1', created_at: '2026-09-20 10:00:00',
  contact_channel: 'outbound', company: 'Sunset Dental Care',
  name: 'Ana Ruiz', email: 'front.desk@sunsetdentalcare.com', phone: '+12135550142',
  website: 'https://sunsetdentalcare.com', address: '1200 Sunset Blvd',
  city: 'Los Angeles', zip: '90026', locale: 'es',
  segment: 'commercial', service_type: 'office', frequency: 'weekly', addons: '[]',
  quote_price: 480, quote_low: 420, quote_high: 540, annual_value: 24960,
  score: 72, temperature: 'hot',
  score_reasons: JSON.stringify([{ points: 26, reason: 'Segmento objetivo' }, { points: 14, reason: 'Abrió hace 20 días' }]),
  status: 'new', source: 'outbound:la_active_businesses', utm_source: 'outbound',
  utm_medium: 'cold_email', utm_campaign: 'new_business', in_service_area: 1,
};
const PROSPECT = {
  uid: 'prospect-1', source: 'la_active_businesses', icp_score: 72,
  email_source: 'published_on_website',
  signal_json: JSON.stringify({ type: 'new_business', openedAt: '2026-08-31' }),
  evidence_json: '{}',
};

const payload = () => toPayload(LEAD, PROSPECT);

// ── Detección ────────────────────────────────────────────────
test('reconoce EspoCRM', async () => {
  const r = await detectCrm(`${base}/espocrm`);
  assert.equal(r.ok, true);
  assert.equal(r.candidates[0].crm, 'espocrm');
});

test('reconoce SuiteCRM', async () => {
  const r = await detectCrm(`${base}/suitecrm`);
  assert.equal(r.candidates[0].crm, 'suitecrm');
});

test('reconoce Perfex', async () => {
  const r = await detectCrm(`${base}/perfex`);
  assert.equal(r.candidates[0].crm, 'perfex');
});

test('reconoce Vtiger', async () => {
  const r = await detectCrm(`${base}/vtiger`);
  assert.equal(r.candidates[0].crm, 'vtiger');
});

test('reconoce Odoo', async () => {
  const r = await detectCrm(`${base}/odoo`);
  assert.equal(r.candidates[0].crm, 'odoo');
});

test('las sondas respetan un CRM instalado en un subdirectorio', async () => {
  // En Hostinger es habitual instalarlo en midominio.com/crm/ en lugar de la
  // raíz. Una ruta absoluta se comería el prefijo y sondearía el sitio público.
  // (Los tests de detección de arriba ya corren contra subdirectorios.)
  const { probeUrl } = await import('../src/services/crm/detect.js');
  assert.equal(probeUrl(new URL('https://cali-clean.net/crm'), '/api/v1/App/user'),
    'https://cali-clean.net/crm/api/v1/App/user');
  assert.equal(probeUrl(new URL('https://cali-clean.net/crm/'), '/'), 'https://cali-clean.net/crm/');
  assert.equal(probeUrl(new URL('https://cali-clean.net'), '/'), 'https://cali-clean.net/');
  assert.equal(probeUrl(new URL('https://cali-clean.net/crm'), '/webservice.php?operation=getchallenge'),
    'https://cali-clean.net/crm/webservice.php?operation=getchallenge');
});

test('un servidor que no es un CRM no se confunde con uno', async () => {
  const r = await detectCrm(`${base}/desconocido`);
  assert.equal(r.ok, false);
  assert.equal(r.reachable, true);
  assert.equal(r.error, 'crm_no_reconocido');
});

test('un servidor inalcanzable se reporta como tal, no como CRM desconocido', async () => {
  const r = await detectCrm('http://127.0.0.1:1', { probe: async () => ({ ok: false, error: 'ECONNREFUSED', status: 0, headers: {}, body: '' }) });
  assert.equal(r.reachable, false);
  assert.equal(r.error, 'servidor_inalcanzable');
});

test('una URL inválida no revienta el detector', async () => {
  const r = await detectCrm('no es una url ::');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'url_invalida');
});

// ── Adaptadores ──────────────────────────────────────────────
test('EspoCRM recibe el lead con sus campos propios', async () => {
  CREATED.calls.length = 0;
  const { ref } = await adapters.espocrm.push(payload(), { baseUrl: `${base}/espocrm`, apiKey: 'ESPO-KEY' }, http);
  assert.equal(ref, 'espo-lead-77');

  const sent = CREATED.calls.at(-1).body;
  assert.equal(sent.emailAddress, LEAD.email);
  assert.equal(sent.accountName, 'Sunset Dental Care');
  assert.equal(sent.source, 'Cold Call', 'un lead outbound no es "Web Site"');
  assert.equal(sent.opportunityAmount, 24960);
  assert.ok(sent.description.includes('Puntuación: 72/100'));
  assert.ok(sent.description.includes('negocio abierto'), 'la señal de prospección viaja al CRM');
});

test('EspoCRM siempre recibe apellido, aunque no haya nombre de contacto', async () => {
  CREATED.calls.length = 0;
  const anon = toPayload({ ...LEAD, name: '' }, PROSPECT);
  await adapters.espocrm.push(anon, { baseUrl: `${base}/espocrm`, apiKey: 'ESPO-KEY' }, http);
  // Espo rechaza un lead sin lastName: se rellena con la empresa.
  assert.equal(CREATED.calls.at(-1).body.lastName, 'Sunset Dental Care');
});

test('una clave incorrecta en EspoCRM falla con un error legible', async () => {
  await assert.rejects(
    adapters.espocrm.push(payload(), { baseUrl: `${base}/espocrm`, apiKey: 'MALA' }, http),
    /HTTP 403/,
  );
});

test('SuiteCRM pide token antes de escribir y lo usa', async () => {
  CREATED.calls.length = 0;
  const { ref } = await adapters.suitecrm.push(payload(), {
    baseUrl: `${base}/suitecrm`, apiKey: 'SUITE-ID', apiSecret: 'SUITE-SECRET',
  }, http);
  assert.equal(ref, 'suite-lead-88');
  const attrs = CREATED.calls.at(-1).body.data.attributes;
  assert.equal(attrs.email1, LEAD.email);
  assert.equal(attrs.lead_source, 'Cold Call');
  assert.equal(attrs.last_name, 'Ruiz');
});

test('SuiteCRM con credenciales malas no crea nada', async () => {
  CREATED.calls.length = 0;
  await assert.rejects(
    adapters.suitecrm.push(payload(), { baseUrl: `${base}/suitecrm`, apiKey: 'X', apiSecret: 'Y' }, http),
    /HTTP 401/,
  );
  assert.equal(CREATED.calls.length, 0);
});

test('Perfex recibe el lead', async () => {
  CREATED.calls.length = 0;
  const { ref } = await adapters.perfex.push(payload(), { baseUrl: `${base}/perfex`, apiKey: 'PERFEX-TOKEN' }, http);
  assert.equal(ref, 'perfex-lead-99');
  assert.equal(CREATED.calls.at(-1).body.email, LEAD.email);
  assert.equal(CREATED.calls.at(-1).body.company, 'Sunset Dental Care');
});

test('Vtiger completa el desafío, el login y la creación', async () => {
  CREATED.calls.length = 0;
  const { ref } = await adapters.vtiger.push(payload(), {
    baseUrl: `${base}/vtiger`, apiUser: 'admin', apiKey: 'VT-KEY',
  }, http);
  assert.equal(ref, '10x123');
  const el = CREATED.calls.at(-1).body;
  assert.equal(el.email, LEAD.email);
  assert.equal(el.company, 'Sunset Dental Care');
});

test('el webhook genérico firma el cuerpo', async () => {
  CREATED.calls.length = 0;
  await adapters.webhook.push(payload(), {
    webhookUrl: `${base}/webhook`, webhookSecret: 'secreto-compartido',
  }, http);
  const call = CREATED.calls.at(-1);
  assert.ok(call.signature?.startsWith('sha256='), 'debe ir firmado');
  assert.equal(call.body.contact.email, LEAD.email);
  assert.equal(call.body.prospecting.prospect_id, 'prospect-1');
});

test('sin secreto el webhook va sin firma, pero va', async () => {
  CREATED.calls.length = 0;
  await adapters.webhook.push(payload(), { webhookUrl: `${base}/webhook` }, http);
  assert.equal(CREATED.calls.at(-1).signature, undefined);
});

// ── Configuración ────────────────────────────────────────────
test('crmStatus dice exactamente qué falta', () => {
  const original = { ...config.crm };

  config.crm.driver = 'espocrm';
  config.crm.baseUrl = '';
  config.crm.apiKey = '';
  let s = crmStatus();
  assert.equal(s.ready, false);
  assert.deepEqual(s.missing, ['baseUrl', 'apiKey']);

  config.crm.baseUrl = 'https://crm.example.com';
  s = crmStatus();
  assert.deepEqual(s.missing, ['apiKey'], 'solo debe faltar lo que falta');

  config.crm.apiKey = 'k';
  assert.equal(crmStatus().ready, true);

  config.crm.driver = 'inventado';
  assert.match(crmStatus().reason, /adaptador_desconocido/);

  Object.assign(config.crm, original);
});

test('sin CRM configurado no se intenta nada', () => {
  const original = config.crm.driver;
  config.crm.driver = 'none';
  const s = crmStatus();
  assert.equal(s.ready, false);
  assert.equal(s.reason, 'sin_configurar');
  config.crm.driver = original;
});
