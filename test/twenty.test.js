import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Adaptador de Twenty CRM.
 *
 * Todo corre contra un Twenty simulado que registra cada petición, así que las
 * afirmaciones sobre "no escribe nada" se comprueban mirando el registro, no
 * confiando en la función que se está probando.
 */

process.env.DB_PATH = ':memory:';
process.env.APP_SECRET = 'test-twenty';

const { createFakeTwenty, EXISTING_COMPANY } = await import('./fixtures/fake-twenty.js');
const {
  createClient, planCompanyUpsert, upsertCompany, findCompanyByDedupKey,
  mapProspectToCompany, mapProspectToPerson, mapProspectToOpportunity,
  diffCompany, redact, isDuplicateConflict, planProspect,
} = await import('../src/services/crm/twenty.js');
const {
  toLeadScore, toContactabilityStatus, toLeadStage, assertEnum, links, emails,
} = await import('../src/services/crm/twenty-schema.js');

const PROSPECT = {
  dedupKey: 'web:harborviewdental.com',
  businessName: 'Harbor View Dental',
  website: 'https://harborviewdental.com',
  sourceUrl: 'https://data.sandiego.gov/datasets/business-listings',
  source: 'sd_business_certificates',
  email: 'Front.Desk@HarborViewDental.com',
  phone: '+16195550142',
  address: '2100 Harbor Dr',
  city: 'San Diego',
  zip: '92101',
  serviceArea: 'San Diego County, CA',
  icpScore: 72,
  stage: 'qualified',
  channel: 'outbound',
  lastVerified: '2026-10-01 09:30:00',
  estAnnualValue: 24960,
  estVisitValue: 480,
};

// ── Mapeo de campos ──────────────────────────────────────────
test('mapea cada campo al nombre real de la API', () => {
  const body = mapProspectToCompany(PROSPECT);
  assert.equal(body.name, 'Harbor View Dental');
  assert.equal(body.dedupKey, 'harborviewdental.com', 'normalizada a la convención del CRM');
  assert.equal(body.serviceArea, 'San Diego County, CA');
  assert.equal(body.domainName.primaryLinkUrl, 'https://harborviewdental.com');
  assert.equal(body.sourceUrl.primaryLinkUrl, 'https://data.sandiego.gov/datasets/business-listings');
  assert.equal(body.businessEmail.primaryEmail, 'front.desk@harborviewdental.com', 'el correo se normaliza');
  assert.equal(body.contactabilityStatus, 'PUBLIC_BUSINESS_EMAIL');
  assert.equal(body.leadStage, 'READY_FOR_OUTREACH');
  assert.equal(body.leadScore, 'RATING_4');
  assert.equal(body.leadSource, 'PUBLIC_WEBSITE');
  assert.equal(body.lastVerified, new Date('2026-10-01T09:30:00Z').toISOString());
  assert.equal(body.address.addressPostcode, '92101');
});

test('los campos sin valor verificado no viajan en el cuerpo', () => {
  const body = mapProspectToCompany({
    dedupKey: 'name:abc123', businessName: 'Taller Sin Web', icpScore: 30, stage: 'discovered',
  });
  // Mandarlos vacíos borraría lo que ya hubiera en el CRM.
  for (const f of ['domainName', 'sourceUrl', 'businessEmail', 'serviceArea', 'lastVerified', 'address']) {
    assert.ok(!(f in body), `${f} no debería estar presente`);
  }
  assert.equal(body.contactabilityStatus, 'NO_VERIFIED_CHANNEL');
  assert.equal(body.leadStage, 'NEW');
});

test('sin clave de deduplicación no hay mapeo posible', () => {
  assert.throws(() => mapProspectToCompany({ businessName: 'X' }), /clave de deduplicación/);
  assert.throws(() => mapProspectToCompany({ dedupKey: '   ', businessName: 'X' }), /clave de deduplicación/);
});

test('Notes y Owner nunca salen en un cuerpo de escritura', () => {
  const body = mapProspectToCompany({ ...PROSPECT, noteTargets: [{ id: 'x' }], accountOwnerId: 'otro-dueno' });
  assert.ok(!('noteTargets' in body));
  assert.ok(!('accountOwnerId' in body));
});

test('la escala del ICP cae en el peldaño correcto', () => {
  assert.equal(toLeadScore(0), 'RATING_1');
  assert.equal(toLeadScore(19), 'RATING_1');
  assert.equal(toLeadScore(20), 'RATING_2');
  assert.equal(toLeadScore(72), 'RATING_4');
  assert.equal(toLeadScore(100), 'RATING_5');
  assert.equal(toLeadScore(null), undefined);
});

test('la contactabilidad refleja la evidencia, no una suposición', () => {
  assert.equal(toContactabilityStatus({ businessEmail: true }), 'PUBLIC_BUSINESS_EMAIL');
  assert.equal(toContactabilityStatus({ phone: true }), 'PUBLIC_BUSINESS_PHONE');
  assert.equal(toContactabilityStatus({ contactFormOnly: true }), 'CONTACT_FORM_ONLY');
  assert.equal(toContactabilityStatus({}), 'NO_VERIFIED_CHANNEL');
  assert.equal(toContactabilityStatus({ optedOut: true, businessEmail: true }), 'OPTED_OUT_DO_NOT_CONTACT',
    'la baja manda sobre cualquier canal encontrado');
});

test('el adaptador no puede afirmar un consentimiento que no tiene', () => {
  assert.throws(() => assertEnum('contactabilityStatus', 'OPTED_IN'), /no ha verificado/);
  assert.throws(() => assertEnum('leadStage', 'INVENTADO'), /Valor inválido/);
});

test('una baja fuerza DO_NOT_CONTACT sea cual sea la etapa', () => {
  assert.equal(toLeadStage({ stage: 'qualified', optedOut: true, hasVerifiedChannel: true }), 'DO_NOT_CONTACT');
  const body = mapProspectToCompany({ ...PROSPECT, optedOut: true });
  assert.equal(body.leadStage, 'DO_NOT_CONTACT');
  assert.equal(body.contactabilityStatus, 'OPTED_OUT_DO_NOT_CONTACT');
});

test('los tipos compuestos se omiten en vez de enviarse vacíos', () => {
  assert.equal(links(''), undefined);
  assert.equal(emails(''), undefined);
  assert.deepEqual(emails('A@B.com'), { primaryEmail: 'a@b.com', additionalEmails: [] });
});

test('la clave de deduplicación se alinea con la convención del CRM', async () => {
  const { normalizeDedupKey } = await import('../src/services/crm/twenty.js');
  // El CRM ya tiene empresas con el dominio desnudo. Mantener el prefijo
  // interno habría creado un duplicado de cada una de ellas.
  assert.equal(normalizeDedupKey('web:cal-prop.com'), 'cal-prop.com');
  assert.equal(normalizeDedupKey('web:WWW.Cal-Prop.com'), 'cal-prop.com');
  assert.equal(normalizeDedupKey('cal-prop.com'), 'cal-prop.com');
  assert.equal(normalizeDedupKey('www.cal-prop.com'), 'cal-prop.com');
  // Las claves sin dominio conservan su espacio de nombres.
  assert.equal(normalizeDedupKey('tel:6195550142'), 'tel:6195550142');
  assert.equal(normalizeDedupKey('name:abc123def'), 'name:abc123def');
  assert.equal(normalizeDedupKey('  '), '');

  assert.equal(mapProspectToCompany({ ...PROSPECT, dedupKey: 'web:harborviewdental.com' }).dedupKey,
    'harborviewdental.com');
});

test('buscar y escribir usan la misma clave normalizada', async () => {
  const fake = await createFakeTwenty({ seed: [{ ...EXISTING_COMPANY, dedupKey: 'harborviewdental.com' }] });
  try {
    const client = createClient({ baseUrl: fake.baseUrl });
    // El prospecto llega con el prefijo interno; la empresa está guardada sin él.
    const plan = await planCompanyUpsert(client, { ...PROSPECT, dedupKey: 'web:harborviewdental.com' });
    assert.equal(plan.action, 'update', 'no encontró la empresa existente: crearía un duplicado');
    assert.equal(plan.id, EXISTING_COMPANY.id);
  } finally {
    fake.server.close();
  }
});

// ── El secreto nunca se registra ─────────────────────────────
test('la credencial no aparece en errores ni en lo que se imprime', async () => {
  const SECRET = 'tw_sk_PRUEBA_12345_no_debe_verse_jamas';
  const previous = process.env.TWENTY_API_KEY;
  process.env.TWENTY_API_KEY = SECRET;

  // Un servidor que devuelve la cabecera recibida en el cuerpo del error:
  // el peor caso realista para una filtración.
  const http = await import('node:http');
  const leaky = http.createServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ statusCode: 500, messages: [`fallo procesando ${req.headers.authorization}`] }));
  });
  await new Promise((r) => leaky.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${leaky.address().port}`;

  const printed = [];
  const origLog = console.log; const origErr = console.error;
  console.log = (...a) => printed.push(a.join(' '));
  console.error = (...a) => printed.push(a.join(' '));

  let caught;
  try {
    const client = createClient({ baseUrl });
    await findCompanyByDedupKey(client, 'cualquiera');
  } catch (err) {
    caught = err;
    console.error(`error capturado: ${err.message}`);
    console.error(`serializado: ${JSON.stringify(err.body)}`);
  } finally {
    console.log = origLog; console.error = origErr;
    leaky.close();
    if (previous === undefined) delete process.env.TWENTY_API_KEY; else process.env.TWENTY_API_KEY = previous;
  }

  assert.ok(caught, 'debería haber fallado');
  assert.ok(!caught.message.includes(SECRET), 'el mensaje de error filtra la credencial');
  assert.ok(!JSON.stringify(caught.body ?? null).includes(SECRET), 'el cuerpo del error filtra la credencial');
  assert.ok(!JSON.stringify(caught).includes(SECRET), 'el error serializado filtra la credencial');
  for (const line of printed) assert.ok(!line.includes(SECRET), `se imprimió la credencial: ${line.slice(0, 80)}`);
  assert.ok(caught.message.includes('[REDACTADO]'), 'debería quedar la marca de redacción');
});

test('redact limpia las formas habituales de filtración', () => {
  assert.ok(!redact('Authorization: Bearer abcdef1234567890').includes('abcdef1234567890'));
  assert.ok(!redact('{"authorization":"Bearer zzzzzzzzzzzz"}').includes('zzzzzzzzzzzz'));
  assert.ok(!redact('x-api-key: supersecretvalue123').includes('supersecretvalue123'));
  assert.equal(redact('texto normal sin secretos'), 'texto normal sin secretos');
});

// ── Dry-run: cero escrituras ─────────────────────────────────
test('el dry-run no emite una sola petición de escritura', async () => {
  const fake = await createFakeTwenty({ seed: [EXISTING_COMPANY] });
  try {
    const client = createClient({ baseUrl: fake.baseUrl });

    const update = await upsertCompany(client, PROSPECT, { dryRun: true });
    assert.equal(update.action, 'update');
    assert.equal(update.executed, false);

    const create = await upsertCompany(client, { ...PROSPECT, dedupKey: 'web:nuevo.com', businessName: 'Nuevo SD' }, { dryRun: true });
    assert.equal(create.action, 'create');
    assert.equal(create.executed, false);

    assert.deepEqual(fake.writes(), [], 'el dry-run hizo peticiones de escritura');
    assert.ok(fake.requests.every((r) => r.method === 'GET'), 'todo debería ser GET');
    assert.equal(fake.companies.length, 1, 'el número de empresas no puede cambiar');
  } finally {
    fake.server.close();
  }
});

// ── Idempotencia ─────────────────────────────────────────────
test('crea una vez y luego actualiza: nunca duplica', async () => {
  const fake = await createFakeTwenty();
  try {
    const client = createClient({ baseUrl: fake.baseUrl });

    const first = await upsertCompany(client, PROSPECT, { dryRun: false });
    assert.equal(first.action, 'create');
    assert.equal(first.executed, true);
    assert.equal(fake.companies.length, 1);

    // Mismo prospecto otra vez: no hay nada que cambiar.
    const second = await upsertCompany(client, PROSPECT, { dryRun: false });
    assert.equal(second.action, 'noop');
    assert.equal(fake.companies.length, 1, 'se creó un duplicado');

    // Cambia un dato: debe actualizar el mismo registro, no crear otro.
    const third = await upsertCompany(client, { ...PROSPECT, icpScore: 95 }, { dryRun: false });
    assert.equal(third.action, 'update');
    assert.equal(fake.companies.length, 1);
    assert.equal(fake.companies[0].leadScore, 'RATING_5');

    assert.equal(fake.writes().filter((w) => w.method === 'POST').length, 1, 'solo debería haber un POST en total');
  } finally {
    fake.server.close();
  }
});

test('el update solo manda los campos que cambian', async () => {
  const fake = await createFakeTwenty({ seed: [EXISTING_COMPANY] });
  try {
    const client = createClient({ baseUrl: fake.baseUrl });
    const plan = await planCompanyUpsert(client, PROSPECT);
    assert.equal(plan.action, 'update');
    assert.equal(plan.id, EXISTING_COMPANY.id);
    // serviceArea y domainName ya coinciden: no deben reescribirse.
    assert.ok(!('serviceArea' in plan.changes), 'reescribe un valor idéntico');
    assert.ok(!('domainName' in plan.changes), 'reescribe un valor idéntico');
    assert.ok('businessEmail' in plan.changes, 'el correo nuevo sí debe escribirse');
    assert.ok(!('dedupKey' in plan.changes), 'la clave de deduplicación no se reescribe');
  } finally {
    fake.server.close();
  }
});

test('no se pisa el dueño que ya tiene el registro', async () => {
  const fake = await createFakeTwenty({ seed: [EXISTING_COMPANY] });
  try {
    const client = createClient({ baseUrl: fake.baseUrl });
    const plan = await planCompanyUpsert(client, { ...PROSPECT, accountOwnerId: 'otro-comercial' });
    assert.ok(!('accountOwnerId' in plan.changes), 'estaba a punto de robar la asignación del comercial');

    const sinDueno = await createFakeTwenty({ seed: [{ ...EXISTING_COMPANY, accountOwnerId: null }] });
    try {
      const c2 = createClient({ baseUrl: sinDueno.baseUrl });
      const p2 = await planCompanyUpsert(c2, { ...PROSPECT, accountOwnerId: 'comercial-nuevo' });
      assert.equal(p2.changes.accountOwnerId, 'comercial-nuevo', 'sin dueño sí se puede asignar');
    } finally { sinDueno.server.close(); }
  } finally {
    fake.server.close();
  }
});

test('diffCompany ignora lo que no se propone', () => {
  const changes = diffCompany(EXISTING_COMPANY, { name: 'Harbor View Dental', serviceArea: undefined, leadScore: 'RATING_5' });
  assert.deepEqual(Object.keys(changes), ['leadScore']);
});

// ── Conflicto de clave duplicada ─────────────────────────────
test('un 409 se resuelve consultando otra vez y actualizando', async () => {
  const fake = await createFakeTwenty({ conflictOnce: true });
  try {
    const client = createClient({ baseUrl: fake.baseUrl });
    const res = await upsertCompany(client, PROSPECT, { dryRun: false });

    assert.equal(res.resolvedFromConflict, true);
    assert.equal(res.action, 'update');
    assert.equal(fake.companies.length, 1, 'el conflicto acabó creando un duplicado');

    const posts = fake.writes().filter((w) => w.method === 'POST');
    assert.equal(posts.length, 1, 'no debe reintentarse la creación');
    assert.equal(fake.writes().filter((w) => w.method === 'PATCH').length, 1);
  } finally {
    fake.server.close();
  }
});

test('reconoce las formas en que un CRM reporta una clave duplicada', () => {
  assert.equal(isDuplicateConflict({ status: 409 }), true);
  assert.equal(isDuplicateConflict({ message: 'duplicate key value violates unique constraint' }), true);
  assert.equal(isDuplicateConflict({ code: '23505' }), true);
  assert.equal(isDuplicateConflict({ status: 400, message: 'campo inválido' }), false);
  assert.equal(isDuplicateConflict(null), false);
});

test('una clave ambigua detiene la sincronización en vez de elegir al azar', async () => {
  const fake = await createFakeTwenty({
    seed: [
      { ...EXISTING_COMPANY, id: 'a-1' },
      { ...EXISTING_COMPANY, id: 'a-2' },
    ],
  });
  try {
    const client = createClient({ baseUrl: fake.baseUrl });
    await assert.rejects(() => planCompanyUpsert(client, PROSPECT), /devuelve 2 empresas/);
    assert.deepEqual(fake.writes(), [], 'no debe tocar nada ante la ambigüedad');
  } finally {
    fake.server.close();
  }
});

test('nunca se consulta con una clave vacía', async () => {
  const fake = await createFakeTwenty({ seed: [{ ...EXISTING_COMPANY, dedupKey: '' }] });
  try {
    const client = createClient({ baseUrl: fake.baseUrl });
    // En la instancia real hay registros con dedupKey vacío: buscar por ""
    // los emparejaría con cualquier prospecto sin clave.
    await assert.rejects(() => findCompanyByDedupKey(client, ''), /clave no vacía/);
    assert.deepEqual(fake.requests, [], 'ni siquiera debería salir la petición');
  } finally {
    fake.server.close();
  }
});

// ── People y Opportunities ───────────────────────────────────
test('solo se crea persona con nombre real, canal y origen en su propia web', () => {
  const base = { ...PROSPECT, contactName: 'Ana Ruiz', contactSource: 'business_website' };
  const person = mapProspectToPerson(base, 'company-1');
  assert.equal(person.name.firstName, 'Ana');
  assert.equal(person.name.lastName, 'Ruiz');
  assert.equal(person.emails.primaryEmail, 'front.desk@harborviewdental.com');
  assert.equal(person.companyId, 'company-1');

  // Un nombre sacado de un registro público no entra: nadie lo publicó para
  // recibir publicidad.
  assert.equal(mapProspectToPerson({ ...base, contactSource: 'public_record' }, 'c1'), null);
  assert.equal(mapProspectToPerson({ ...base, contactName: 'Recepción' }, 'c1'), null);
  assert.equal(mapProspectToPerson({ ...base, email: '', phone: '' }, 'c1'), null);
  assert.equal(mapProspectToPerson(base, null), null);
});

test('solo se crea oportunidad cuando hay importe estimado', () => {
  const opp = mapProspectToOpportunity(PROSPECT, 'company-1');
  assert.equal(opp.stage, 'NEW');
  assert.equal(opp.amount.amountMicros, 24960 * 1e6);
  assert.equal(opp.companyId, 'company-1');
  assert.equal(mapProspectToOpportunity({ ...PROSPECT, estAnnualValue: 0, estVisitValue: 0 }, 'c1'), null);
  assert.equal(mapProspectToOpportunity(PROSPECT, null), null);
});

test('el plan completo tampoco escribe nada', async () => {
  const fake = await createFakeTwenty({ seed: [EXISTING_COMPANY] });
  try {
    const client = createClient({ baseUrl: fake.baseUrl });
    const plan = await planProspect(client, { ...PROSPECT, contactName: 'Ana Ruiz', contactSource: 'business_website' });
    assert.equal(plan.company.action, 'update');
    assert.ok(plan.person);
    assert.ok(plan.opportunity);
    assert.deepEqual(fake.writes(), []);
  } finally {
    fake.server.close();
  }
});
