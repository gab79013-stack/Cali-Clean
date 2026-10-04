import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Enriquecimiento: lo que se puede afirmar sin salir a buscar nada.
 *
 * La regla que estas pruebas defienden: el planificador propone solo lo que ya
 * se sabe. No visita webs, no adivina dominios a partir del nombre, no construye
 * correos y no inventa teléfonos. Un campo sin sustento se queda sin proponer, y
 * eso se comprueba aquí para que ningún cambio futuro lo convierta en una
 * "mejora" que rellena huecos.
 */

process.env.DB_PATH = ':memory:';
process.env.APP_SECRET = 'test-enrich';
process.env.SERVICE_ZIPS = '92101,92103,92110,92113';

const {
  planEnrichment, planEnrichmentBatch, segmentFor, typeIndexFromSnapshots, SCORE_RULES,
} = await import('../src/prospecting/enrich-planner.js');

const base = {
  dedupKey: 'sdcounty-ffp:DEH-900',
  name: 'Bahía Taquería',
  serviceArea: 'San Diego County, CA',
  leadScore: null,
  leadStage: null,
  sourceUrl: { primaryLinkUrl: 'https://data.sandiegocounty.gov/resource/c5ez-ufrd.json' },
  businessEmail: null,
  domainName: null,
  address: { addressStreet1: '1450 Harbor Dr', addressCity: 'San Diego', addressPostcode: '92101' },
};

test('las reglas de puntuación están tabuladas y suman 85 sin canal de contacto', () => {
  const total = SCORE_RULES.reduce((s, r) => s + r.points, 0);
  assert.equal(total, 85);
  for (const r of SCORE_RULES) {
    assert.ok(r.id && r.why && typeof r.points === 'number', 'una regla sin motivo no es explicable');
  }
  // El canal de contacto vale más que cualquier otra señal: sin él no se puede
  // escribir a nadie, y con él el prospecto es accionable.
  const canal = SCORE_RULES.find((r) => r.id === 'canal_verificado');
  assert.ok(SCORE_RULES.every((r) => r.id === 'canal_verificado' || r.points <= canal.points));
});

test('sin canal de contacto una empresa no puede estar cualificada', () => {
  const p = planEnrichment(base);
  assert.equal(p.changes.leadStage, 'DISCOVERED');
  assert.match(p.reasons.join(' '), /sin canal de contacto/);

  const conCorreo = planEnrichment({ ...base, businessEmail: { primaryEmail: 'info@ejemplo.com' } });
  assert.equal(conCorreo.changes.leadStage, 'QUALIFIED');
});

test('el score sube solo con señales que se pueden comprobar', () => {
  const sinNada = planEnrichment({
    dedupKey: 'x', name: 'Algo', serviceArea: 'San Diego', address: {},
  });
  assert.equal(sinNada.score, 0);
  assert.equal(sinNada.rating, 'RATING_1');

  const conTodo = planEnrichment({
    ...base,
    naics: '722511',
    entityType: 'LLC',
    businessEmail: { primaryEmail: 'info@ejemplo.com' },
  });
  assert.equal(conTodo.score, 85);
  assert.equal(conTodo.rating, 'RATING_4');
  assert.equal(conTodo.segment, 'restaurants');
});

test('no se propone nada que no esté sustentado, y se dice por qué', () => {
  const p = planEnrichment(base);
  assert.equal(p.changes.businessEmail, undefined, 'un correo inventado es peor que ninguno');
  assert.equal(p.changes.domainName, undefined, 'el dominio no se adivina desde el nombre');
  assert.equal(p.changes.phone, undefined);
  const texto = p.notProposed.join(' | ');
  assert.match(texto, /businessEmail/);
  assert.match(texto, /no se adivina un dominio/);
  assert.match(texto, /phone/);
});

test('el área de servicio solo se rellena si está vacía', () => {
  const vacia = planEnrichment({ ...base, serviceArea: '' });
  assert.equal(vacia.changes.serviceArea, 'San Diego County, CA');

  // Si alguien escribió otra cosa a mano, manda lo suyo.
  const aMano = planEnrichment({ ...base, serviceArea: 'San Diego County (Jamul)' });
  assert.equal(aMano.changes.serviceArea, undefined, 'se sobrescribió lo que puso una persona');
});

test('el segmento sale del NAICS o del tipo oficial, nunca del nombre', () => {
  assert.equal(segmentFor({ naics: '722511' }).segment, 'restaurants');
  assert.equal(segmentFor({ businessType: 'Restaurant Food Facility' }).segment, 'restaurants');
  assert.equal(segmentFor({ businessType: 'Licensed Health Care Facility' }).segment, 'offices');
  assert.equal(segmentFor({ businessType: 'Satellite Food Service Operation' }).segment, 'restaurants');

  // Un nombre que suena a restaurante, sin tipo ni NAICS, NO asigna segmento.
  assert.equal(segmentFor({ name: 'Lucys Bakery And Pizza' }).segment, null,
    'el nombre comercial no es evidencia del tipo de negocio');
});

test('el tipo oficial se toma de los snapshots, no de ninguna otra parte', () => {
  const index = typeIndexFromSnapshots([{
    sourceId: 'sdcounty_food_facility_permits',
    createdAt: '2026-10-04T06:49:55.122Z',
    rows: [{ dedupKey: 'sdcounty-ffp:DEH-900', raw: { business_type: 'Restaurant Food Facility' } }],
  }]);
  assert.equal(index.size, 1);

  const conIndice = planEnrichment(base, { typeIndex: index });
  assert.equal(conIndice.segment, 'restaurants');
  assert.match(conIndice.typeBasis, /snapshot sdcounty_food_facility_permits del 2026-10-04/);

  const sinIndice = planEnrichment(base);
  assert.equal(sinIndice.segment, null);
  assert.match(sinIndice.notProposed.join(' '), /el CRM no guarda tipo ni NAICS/);
});

test('una segunda pasada no propone nada: el plan es idempotente', () => {
  const primera = planEnrichment({ ...base, naics: '722511', entityType: 'LLC' });
  assert.equal(primera.action, 'update');

  // Se aplica mentalmente lo propuesto y se vuelve a planificar.
  const aplicado = { ...base, naics: '722511', entityType: 'LLC', ...primera.changes };
  const segunda = planEnrichment(aplicado);
  assert.equal(segunda.action, 'noop', `seguiría proponiendo: ${JSON.stringify(segunda.changes)}`);
  assert.deepEqual(segunda.changes, {});
});

test('el lote cuenta por acción y no pierde ninguna', () => {
  const { plans, tally } = planEnrichmentBatch([
    { ...base, naics: '722511' },
    { ...base, dedupKey: 'y', leadScore: 'RATING_2', leadStage: 'DISCOVERED' },
  ]);
  assert.equal(plans.length, 2);
  assert.equal(tally.update + tally.noop, 2);
});

test('el plan no lleva ni un dato personal', () => {
  const p = planEnrichment({
    ...base,
    // Si alguien metiera un campo con un nombre de persona, no puede aparecer en
    // el plan: el planificador solo mira los campos que conoce.
    business_owner_name: 'Fernandez, Ana Lucia',
    lat: '32.7157',
  });
  const texto = JSON.stringify(p);
  assert.ok(!texto.includes('Fernandez'), 'un dato personal llegó al plan');
  assert.ok(!texto.includes('32.7157'));
});
