import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Recorrido completo del envío en frío: desde el prospecto cualificado hasta el
 * correo enviado, pasando por cada salvaguarda. Es la prueba que responde a
 * "¿de verdad sale el correo y de verdad se detiene cuando debe?".
 */

const dbFile = path.join(os.tmpdir(), `cc-outbound-${Date.now()}.db`);
process.env.DB_PATH = dbFile;
process.env.OUTBOUND_ENABLED = 'true';
process.env.OUTBOUND_REQUIRE_MX = 'false';
process.env.OUTBOUND_DAILY_LIMIT = '10';
process.env.SERVICE_ZIPS = '90026';
process.env.MAIL_DRIVER = 'log';
process.env.APP_SECRET = 'test-outbound-secret';
process.env.SEQUENCE_SEND_FROM = '0';
process.env.SEQUENCE_SEND_TO = '24';

const { db } = await import('../src/db.js');
const { config } = await import('../src/config.js');
const { outreach } = await import('../src/prospecting/agents/outreach.js');
const { processDueSteps } = await import('../src/services/sequences.js');
const guards = await import('../src/prospecting/guards.js');
const { newUid } = await import('../src/utils/tokens.js');

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
});

/** Inserta un prospecto ya cualificado, listo para contacto. */
function seedProspect(overrides = {}) {
  const uid = newUid();
  db.prepare(`
    INSERT INTO prospects (uid, source, dedupe_key, business_name, segment, address, city, zip,
      phone, website, email, email_source, locale, signal_type, signal_json, icp_score, stage)
    VALUES (?, 'la_active_businesses', ?, ?, ?, '1200 Sunset Blvd', 'Los Angeles', '90026',
      '+12135550142', ?, ?, 'published_on_website', 'es', 'new_business', ?, 72, 'qualified')`
  ).run(
    uid, `key-${uid}`, overrides.name || 'Sunset Dental Care', overrides.segment || 'office_clinic',
    overrides.website || 'https://sunsetdentalcare.com',
    overrides.email || `front.desk+${uid}@sunsetdentalcare-${uid}.com`,
    JSON.stringify({ type: 'new_business', openedAt: new Date().toISOString().slice(0, 10) }),
  );
  return db.prepare('SELECT * FROM prospects WHERE uid = ?').get(uid);
}

test('el primer correo en frío sale y queda registrado', async () => {
  const prospect = seedProspect();
  const engaged = await outreach({});
  assert.equal(engaged.engaged, 1);

  const result = await processDueSteps({ limit: 10 });
  assert.equal(result.sent, 1, 'debería salir exactamente el primer toque');

  const lead = db.prepare('SELECT * FROM leads WHERE prospect_uid = ?').get(prospect.uid);
  const email = db.prepare('SELECT * FROM emails WHERE lead_id = ?').get(lead.id);
  assert.equal(email.template, 'outbound_intro');
  assert.equal(email.status, 'sent');
  assert.ok(email.subject.includes('Sunset Dental Care'), 'el asunto nombra al negocio');

  // El registro de envío es lo que sostiene el cupo diario y el enfriamiento.
  const logged = db.prepare('SELECT * FROM outbound_log WHERE lead_id = ?').get(lead.id);
  assert.ok(logged, 'el envío debe quedar en outbound_log');
  assert.equal(logged.step, 'outbound_intro');
  assert.equal(logged.email, lead.email);

  // Los tres toques restantes quedan programados, no enviados.
  const pending = db.prepare("SELECT COUNT(*) AS n FROM sequence_steps WHERE lead_id=? AND status='pending'").get(lead.id).n;
  assert.equal(pending, 3);
});

test('el correo enviado lleva baja y aviso de procedencia', async () => {
  const lead = db.prepare("SELECT * FROM leads WHERE contact_channel='outbound' LIMIT 1").get();
  const { renderTemplate } = await import('../src/templates/emails.js');
  const prospect = db.prepare('SELECT * FROM prospects WHERE uid = ?').get(lead.prospect_uid);
  const copy = JSON.parse(prospect.copy_json);
  const rendered = renderTemplate('outbound_intro', {
    lead, copy, locale: 'es',
    links: { booking: 'https://x/b', unsubscribe: 'https://x/unsub', pixel: 'https://x/px' },
  });
  assert.ok(rendered.html.includes('https://x/unsub'), 'sin enlace de baja no se puede enviar en frío');
  assert.ok(rendered.html.includes('registros públicos'), 'debe decir por qué recibe el correo');
  assert.ok(rendered.html.includes(config.business.address) || !config.business.address);
});

test('darse de baja detiene la secuencia en el acto', async () => {
  const lead = db.prepare("SELECT * FROM leads WHERE contact_channel='outbound' LIMIT 1").get();
  db.prepare('UPDATE leads SET unsubscribed = 1 WHERE id = ?').run(lead.id);
  // Adelanta los pasos pendientes para que les toque salir ahora.
  db.prepare("UPDATE sequence_steps SET scheduled_at = datetime('now','-1 minute') WHERE lead_id = ?").run(lead.id);

  const result = await processDueSteps({ limit: 10 });
  assert.equal(result.sent, 0, 'no debe salir ni un correo más');

  const remaining = db.prepare("SELECT COUNT(*) AS n FROM sequence_steps WHERE lead_id=? AND status='pending'").get(lead.id).n;
  assert.equal(remaining, 0, 'los pasos pendientes se cancelan');
});

test('una baja registrada con mayúsculas sigue bloqueando el contacto', async () => {
  const prospect = seedProspect({ name: 'Mayusculas SA', email: 'Contacto.Directo@EjemploMixto.com' });
  // Ese mismo buzón ya se dio de baja, guardado con otra caja.
  db.prepare(`INSERT INTO leads (uid, email, unsubscribed, locale, segment)
              VALUES (?, 'CONTACTO.DIRECTO@ejemplomixto.com', 1, 'es', 'commercial')`).run(newUid());

  const check = await guards.canSendOutbound('contacto.directo@ejemplomixto.com');
  assert.equal(check.allowed, false);
  assert.equal(check.reason, 'previously_unsubscribed');

  const stats = await outreach({});
  const after = db.prepare('SELECT * FROM prospects WHERE uid = ?').get(prospect.uid);
  assert.equal(after.stage, 'rejected');
  assert.equal(after.reject_reason, 'previously_unsubscribed');
  assert.equal(stats.engaged, 0);
});

test('un prospecto en la lista de supresión nunca llega a contactarse', async () => {
  const prospect = seedProspect({ name: 'Bloqueado SA' });
  guards.suppress(prospect.email, { reason: 'queja previa' });

  const stats = await outreach({});
  assert.equal(stats.engaged, 0);
  const after = db.prepare('SELECT * FROM prospects WHERE uid = ?').get(prospect.uid);
  assert.equal(after.stage, 'rejected');
  assert.ok(after.reject_reason.startsWith('email_suppressed'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM leads WHERE email = ?').get(prospect.email).n, 0);
});

test('agotado el cupo del día, los pasos se posponen en vez de perderse', async () => {
  const prospect = seedProspect({ name: 'Cupo Lleno SL' });
  await outreach({});
  const lead = db.prepare('SELECT * FROM leads WHERE prospect_uid = ?').get(prospect.uid);
  assert.ok(lead, 'el prospecto debe haberse convertido en lead');

  const original = config.outbound.dailyLimit;
  config.outbound.dailyLimit = 0;   // simula el cupo consumido
  const result = await processDueSteps({ limit: 10 });
  config.outbound.dailyLimit = original;

  assert.equal(result.sent, 0);
  assert.ok(result.deferred >= 1, 'el paso se pospone');
  const step = db.prepare("SELECT * FROM sequence_steps WHERE lead_id=? AND status='pending'").get(lead.id);
  assert.ok(step, 'el paso sigue pendiente, no cancelado');
  assert.ok(step.error.includes('daily_limit_reached'));
});

test('el interruptor general no cancela nada, solo aplaza', async () => {
  const lead = db.prepare("SELECT * FROM leads WHERE contact_channel='outbound' AND unsubscribed=0 LIMIT 1").get();
  db.prepare("UPDATE sequence_steps SET scheduled_at=datetime('now','-1 minute'), status='pending' WHERE lead_id=?").run(lead.id);

  config.outbound.enabled = false;
  const result = await processDueSteps({ limit: 10 });
  config.outbound.enabled = true;

  assert.equal(result.sent, 0);
  const pending = db.prepare("SELECT COUNT(*) AS n FROM sequence_steps WHERE lead_id=? AND status='pending'").get(lead.id).n;
  assert.ok(pending > 0, 'apagar el sistema no debe destruir la cola');
});
