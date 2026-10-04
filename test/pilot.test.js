import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/**
 * Piloto del embudo: lo que estas pruebas tienen que demostrar.
 *
 *   · la calificación es explicable y solo usa campos que existen;
 *   · lo que no se puede afirmar, no se escribe: ni un canal de contacto, ni un
 *     RATING_5, ni un tag en un esquema que no tiene tags;
 *   · los nombres de Opportunity y de Task son deterministas, porque de eso
 *     depende que una segunda corrida no duplique;
 *   · el clasificador de correo no envía, y no puede: devuelve texto con
 *     `sendable: false` y no conoce ninguna ruta de envío;
 *   · el script exige sus cerrojos y no habla con colecciones que no le tocan.
 */

process.env.OUTBOUND_ENABLED = 'false';
process.env.DB_PATH = ':memory:';
process.env.APP_SECRET = 'test-pilot';

const q = await import('../src/prospecting/pilot/qualify.js');
const inbound = await import('../src/prospecting/pilot/inbound.js');

const AHORA = Date.parse('2026-10-04T20:00:00.000Z');

/** Una Company como las que el CRM tiene de verdad, tras la carga de ABC. */
const company = (patch = {}) => ({
  id: '11111111-2222-3333-4444-555555555555',
  name: 'HARBOR TAP HOUSE',
  dedupKey: 'ca-abc:00012345',
  leadSource: 'BUSINESS_DIRECTORY',
  leadStage: 'NEW',
  leadScore: null,
  contactabilityStatus: 'NO_VERIFIED_CHANNEL',
  serviceArea: 'San Diego County, CA',
  lastVerified: '2026-10-04T19:30:31.981Z',
  sourceUrl: { primaryLinkUrl: 'https://www.abc.ca.gov/licensing/licensing-reports' },
  address: {
    addressStreet1: '750 FIFTH AVE', addressStreet2: '', addressCity: 'SAN DIEGO',
    addressPostcode: '92101', addressState: 'CA', addressLat: null, addressLng: null,
  },
  ...patch,
});
const evidencia = (patch = {}) => ({ licenseType: '47', licenseTypeName: 'On-Sale General - Eating Place', ...patch });

// ══ Calificación ══════════════════════════════════════════════
test('una Company con todas las señales se califica, y la explicación se puede contrastar', () => {
  const r = q.qualifyCompany(company(), evidencia(), { now: AHORA });
  assert.equal(r.qualified, true, r.reasons.join('; '));
  assert.deepEqual(r.proposed, { leadScore: 'RATING_4', leadStage: 'QUALIFIED' });
  // La explicación nombra el tipo de licencia, los días y la ciudad: los tres se
  // pueden comprobar contra el CRM y el snapshot.
  assert.match(r.explanation, /RATING_4/);
  assert.match(r.explanation, /tipo de licencia 47/);
  assert.match(r.explanation, /verificada hace 0 día/);
  assert.match(r.explanation, /SAN DIEGO/);
  assert.equal(r.segment.licenseType, '47');
  assert.ok(r.segment.why, 'un peso de segmento sin razón escrita no se puede revisar');
});

test('la propuesta NUNCA toca contactabilityStatus ni inventa un canal', () => {
  for (const tipo of Object.keys(q.SEGMENT_RATING)) {
    const r = q.qualifyCompany(company(), evidencia({ licenseType: tipo }), { now: AHORA });
    assert.equal(r.qualified, true);
    assert.deepEqual(Object.keys(r.proposed).sort(), ['leadScore', 'leadStage'],
      'la propuesta escribe un campo que no debería');
    assert.equal(r.proposed.contactabilityStatus, undefined);
    assert.equal(r.proposed.tags, undefined, 'el esquema de Company no tiene tags');
    assert.equal(r.proposed.businessEmail, undefined);
    assert.equal(r.proposed.domainName, undefined);
  }
});

test('nadie llega a RATING_5 ni a READY_FOR_OUTREACH', () => {
  const ratings = new Set(Object.values(q.SEGMENT_RATING).map((s) => s.rating));
  assert.ok(!ratings.has('RATING_5'),
    'un RATING_5 afirmaría un cliente probable, y para eso haría falta un canal verificado');
  for (const tipo of Object.keys(q.SEGMENT_RATING)) {
    const r = q.qualifyCompany(company(), evidencia({ licenseType: tipo }), { now: AHORA });
    assert.equal(r.proposed.leadStage, 'QUALIFIED',
      'READY_FOR_OUTREACH implica saber por dónde contactar, y no se sabe');
  }
});

test('cada señal que falta deja la Company sin calificar, y dice cuál', () => {
  for (const [patch, aguja] of [
    [{ leadSource: 'PUBLIC_WEBSITE' }, /procedencia/],
    [{ sourceUrl: null }, /procedencia/],
    [{ dedupKey: '' }, /procedencia/],
    [{ address: { ...company().address, addressStreet1: '' } }, /incompleta/],
    [{ address: { ...company().address, addressPostcode: '921' } }, /incompleta/],
    [{ address: { ...company().address, addressStreet1: 'P.O. BOX 9912' } }, /vivienda o un apartado/],
    [{ address: { ...company().address, addressStreet2: 'APT 7B' } }, /vivienda o un apartado/],
    [{ serviceArea: 'Los Angeles County, CA' }, /fuera del ámbito/],
    [{ lastVerified: '2026-01-01T00:00:00.000Z' }, /verificada hace \d+ días/],
    [{ lastVerified: '' }, /sin lastVerified/],
    [{ name: 'Ortega, Jose Ramon' }, /no se puede afirmar de un negocio/],
    [{ name: 'Jose R Ortega' }, /no se puede afirmar de un negocio/],
  ]) {
    const r = q.qualifyCompany(company(patch), evidencia(), { now: AHORA });
    assert.equal(r.qualified, false, `${JSON.stringify(patch)} se calificó`);
    assert.equal(r.proposed, null, 'una Company sin calificar no puede traer propuesta');
    assert.ok(r.reasons.some((m) => aguja.test(m)), `motivos: ${r.reasons.join('; ')}`);
  }
});

test('sin evidencia de segmento no se califica: el segmento no se adivina por el nombre', () => {
  const sinEvidencia = q.qualifyCompany(company(), undefined, { now: AHORA });
  assert.equal(sinEvidencia.qualified, false);
  assert.ok(sinEvidencia.reasons.some((m) => /no se adivina por el nombre/.test(m)));

  // Un tipo real pero sin peso documentado tampoco cuela.
  const tipoRaro = q.qualifyCompany(company(), evidencia({ licenseType: '02' }), { now: AHORA });
  assert.equal(tipoRaro.qualified, false);
  assert.ok(tipoRaro.reasons.some((m) => /no tiene peso de segmento documentado/.test(m)));
});

test('los pesos de segmento son los que la actividad justifica', () => {
  const r = (t) => q.SEGMENT_RATING[t]?.rating;
  // Restaurantes y barras por encima del comercio para llevar.
  for (const t of ['41', '47', '42', '48', '61', '75']) assert.equal(r(t), 'RATING_4', `tipo ${t}`);
  for (const t of ['50', '51', '52', '57', '70', '90']) assert.equal(r(t), 'RATING_3', `tipo ${t}`);
  for (const t of ['20', '21', '49', '59', '60']) assert.equal(r(t), 'RATING_2', `tipo ${t}`);
  // Y los tipos que el scout ya excluye no aparecen aquí tampoco.
  for (const t of ['02', '17', '54', '67', '77', '80', '99']) assert.equal(r(t), undefined, `tipo ${t}`);
});

// ══ Nombres deterministas ═════════════════════════════════════
test('los nombres de Opportunity y Task son deterministas y llevan la clave', () => {
  const c = company();
  assert.equal(q.opportunityName(c), q.opportunityName({ ...c }));
  assert.match(q.opportunityName(c), /HARBOR TAP HOUSE/);
  assert.match(q.opportunityName(c), /ca-abc:00012345/);
  assert.equal(q.reviewTaskTitle(c), q.reviewTaskTitle({ ...c }));
  assert.match(q.reviewTaskTitle(c), /ca-abc:00012345/);
  // Dos Companies distintas no pueden compartir nombre: de eso depende el dedupe.
  assert.notEqual(q.opportunityName(c), q.opportunityName(company({ dedupKey: 'ca-abc:00099999' })));
  assert.equal(q.OPPORTUNITY_INITIAL_STAGE, 'NEW');
});

// ══ Clasificador de correo ════════════════════════════════════
test('el clasificador reconoce lo que sabe y admite lo que no', () => {
  for (const [asunto, extracto, esperada] of [
    ['Quote for nightly cleaning', 'Can you send pricing for our restaurant?', 'solicitud_presupuesto'],
    ['Presupuesto limpieza', 'Necesitamos una cotización', 'solicitud_presupuesto'],
    ['Do you offer floor care?', 'What areas do you cover?', 'pregunta_servicio'],
    ['Not interested', 'We already have a vendor, thanks', 'respuesta_negativa'],
    ['Unsubscribe', 'Please remove me from your list', 'baja_explicita'],
    ['Invoice 4417', 'Attached is the W-9 you requested', 'administrativo'],
    ['Lunch tomorrow?', 'see you at 1', 'no_relacionado'],
    ['', '', 'no_relacionado'],
  ]) {
    const r = inbound.classifyInbound({ asunto, extracto });
    assert.equal(r.categoria, esperada, `"${asunto}" → ${r.categoria}`);
    assert.ok(r.why, 'una clasificación sin razón no se puede revisar');
    assert.ok(inbound.INBOUND_CATEGORIES.includes(r.categoria));
  }
});

test('una baja explícita gana a cualquier otra señal del mismo correo', () => {
  // Un correo que pide precio Y pide la baja es una baja. Al revés sería usar una
  // pregunta como excusa para seguir escribiendo.
  const r = inbound.classifyInbound({
    asunto: 'Pricing question - and unsubscribe',
    extracto: 'How much for weekly service? Also please opt-out me from future emails.',
  });
  assert.equal(r.categoria, 'baja_explicita');
});

test('un borrador nunca es enviable, y las bajas no tienen borrador', () => {
  const b = inbound.suggestDraft('solicitud_presupuesto', { companyName: 'HARBOR TAP HOUSE' });
  assert.equal(b.sendable, false, 'un borrador enviable no es un borrador');
  assert.equal(b.channel, 'none');
  assert.equal(b.draft.para, null, 'un borrador con destinatario es un correo a medio enviar');
  assert.ok(b.draft.asunto && b.draft.cuerpo);
  // El cuerpo no promete precio ni plazo: eso lo decide una persona.
  assert.ok(!/\$|\bprecio de\b|\bcontrato\b/i.test(b.draft.cuerpo));

  for (const sin of ['baja_explicita', 'respuesta_negativa', 'no_relacionado']) {
    const r = inbound.suggestDraft(sin, { companyName: 'X' });
    assert.equal(r.draft, null, `${sin} no puede tener plantilla`);
    assert.equal(r.sendable, false);
    assert.ok(r.why);
  }
});

test('el módulo de correo no conoce ninguna ruta de envío', () => {
  const src = fs.readFileSync(new URL('../src/prospecting/pilot/inbound.js', import.meta.url), 'utf8');
  for (const prohibido of ['fetch(', 'nodemailer', 'sendMail', 'smtp', '/messages', 'messageCampaigns',
    'createMessage', 'transport']) {
    assert.ok(!src.includes(prohibido), `el clasificador menciona ${prohibido}`);
  }
});

// ══ El script del piloto ══════════════════════════════════════
test('el piloto exige sus cerrojos y no habla con colecciones que no le tocan', () => {
  const src = fs.readFileSync(new URL('../scripts/pilot-run.js', import.meta.url), 'utf8');

  for (const cerrojo of ['--confirm', '--allow-writes', '--expect-hash', 'TWENTY_WRITE_ENABLED=true']) {
    assert.ok(src.includes(cerrojo), `el apply no exige ${cerrojo}`);
  }
  assert.match(src, /faltan: \$\{faltan\.join/, 'no reporta todos los cerrojos que faltan');
  assert.match(src, /assertOutboundDisabled\(\)/);
  assert.match(src, /se aplica lo que se revisó, no otra cosa/);

  // Tope del piloto, comprobado en el código y no solo en la documentación.
  assert.match(src, /Math\.min\(Number\(flag\('limit', 10\)\), 10\)/);
  assert.match(src, /el tope del piloto es 10/);

  // La allowlist de rutas: cualquier otra colección lanza.
  assert.match(src, /\^\\\/\(companies\|opportunities\|tasks\|taskTargets\|open-api\)/);
  assert.match(src, /el piloto no habla con/);

  // Lo que no puede aparecer: borrados, People, mensajes, campañas, precios.
  assert.ok(!/client\.delete|method:\s*'DELETE'/.test(src), 'el piloto puede borrar');
  for (const prohibido of ["'/people'", "'/messages'", "'/messageCampaigns'", "'/notes'",
    'amountMicros', 'currencyCode']) {
    assert.ok(!src.includes(prohibido), `el piloto menciona ${prohibido}`);
  }

  // La copia de seguridad va ANTES de la primera escritura, con 600.
  const iBackup = src.indexOf('guardarBackup(p, existente');
  const iEscritura = src.indexOf("title('Escribiendo')");
  assert.ok(iBackup > 0 && iEscritura > iBackup, 'la copia de seguridad no precede a la escritura');
  assert.match(src, /mode: 0o600/);
  assert.match(src, /chmodSync\(file, 0o600\)/);
  assert.match(src, /sin secretos ni contenido de correo/);
});

test('la copia de seguridad está fuera de git', () => {
  const gi = fs.readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
  assert.match(gi, /^data\/backups\/$/m, 'data/backups/ no está en .gitignore');
});

test('la Opportunity que el piloto crea no lleva precio ni fecha prometida', () => {
  const src = fs.readFileSync(new URL('../scripts/pilot-run.js', import.meta.url), 'utf8');
  const i = src.indexOf("await client.post('/opportunities'");
  assert.ok(i > 0, 'no se encontró la creación de la Opportunity');
  const cuerpo = src.slice(i, i + 220);
  assert.match(cuerpo, /name: s\.opportunityName/);
  assert.match(cuerpo, /stage: OPPORTUNITY_INITIAL_STAGE/);
  assert.match(cuerpo, /companyId: s\.companyId/);
  assert.ok(!/amount/.test(cuerpo), 'la Opportunity lleva amount');
  assert.ok(!/closeDate/.test(cuerpo), 'la Opportunity promete una fecha de cierre');
  assert.ok(!/pointOfContactId/.test(cuerpo), 'la Opportunity apunta a una persona');
});

test('la tarea no se asigna a nadie y nace pendiente', () => {
  const src = fs.readFileSync(new URL('../scripts/pilot-run.js', import.meta.url), 'utf8');
  const i = src.indexOf("await client.post('/tasks'");
  assert.ok(i > 0);
  const cuerpo = src.slice(i, i + 200);
  assert.match(cuerpo, /status: 'TODO'/);
  assert.match(cuerpo, /dueAt: vence/);
  assert.ok(!/assigneeId/.test(cuerpo), 'la tarea se asigna a alguien que nadie verificó');
});
