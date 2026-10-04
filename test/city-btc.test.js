import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Fuente 2: certificados de actividad de la Ciudad de San Diego.
 *
 * Lo que estas pruebas tienen que demostrar, porque es lo que separa una
 * política de un comentario:
 *
 *   · el titular del certificado NO sale por ninguna ruta, ni al prospecto, ni
 *     a raw_json, ni al snapshot, ni a un log, ni al texto de un error;
 *   · solo pasan entidades jurídicas inequívocas y sectores NAICS comerciales;
 *   · un CSV con comillas, saltos de línea, columnas nuevas, filas malformadas,
 *     tamaño excesivo o conexión cortada no produce datos a medias;
 *   · la cuota de la ciudad y la del condado son independientes en los dos
 *     sentidos;
 *   · nada de esto escribe en el CRM.
 *
 * El allowlist versionado tiene la ciudad APAGADA. Estas pruebas usan una copia
 * con enabled=true, porque el pipeline se ejercita cruzando la puerta de verdad,
 * no esquivándola.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-city-'));
const allowFile = path.join(tmpDir, 'allowlist.json');

const realAllowlist = JSON.parse(
  fs.readFileSync(new URL('../config/source-allowlist.json', import.meta.url), 'utf8'),
);
realAllowlist.sources.sd_business_tax_certificates.enabled = true;
fs.writeFileSync(allowFile, JSON.stringify(realAllowlist, null, 2));

process.env.SOURCE_ALLOWLIST_PATH = allowFile;
process.env.SOURCE_RUNTIME_STATE_PATH = path.join(tmpDir, 'state.json');
process.env.SOURCE_SNAPSHOT_DIR = path.join(tmpDir, 'snapshots');
process.env.SOURCE_CSV_TMP_DIR = path.join(tmpDir, 'csv');
process.env.SOURCE_SESSION_ID = 'sesion-city';
process.env.DB_PATH = ':memory:';
process.env.APP_SECRET = 'test-city';
process.env.SERVICE_ZIPS = '92101,92103,92110,92113';
fs.mkdirSync(process.env.SOURCE_CSV_TMP_DIR, { recursive: true });

const { SOURCES, fetchFromSource, buildCsvUrl, crossKey, emptyMetrics } = await import('../src/prospecting/sources/index.js');
const { allowedFields, forbiddenFields, allowlistEntry } = await import('../src/prospecting/sources/compliance.js');
const rules = await import('../src/prospecting/sources/city-btc-rules.js');
const { CsvParser, parseCsv, rowToObject, CsvFormatError } = await import('../src/prospecting/sources/csv-parse.js');
const csvClient = await import('../src/prospecting/sources/csv-client.js');
const { checkDurableQuota } = await import('../src/prospecting/sources/durable-quota.js');
const quota = await import('../src/prospecting/sources/quota.js');
const snap = await import('../src/prospecting/sources/snapshot.js');
const { attestationFor } = await import('../src/prospecting/sources/attestation.js');
const fixture = await import('./fixtures/fake-city-csv.js');
const { createFakeTwenty, EXISTING_COMPANY } = await import('./fixtures/fake-twenty.js');
const { createClient, latestVerifiedWithPrefix, loadCrmIndex, planCompanyUpsert } = await import('../src/services/crm/twenty.js');

const CITY = 'sd_business_tax_certificates';
const COUNTY = 'sdcounty_food_facility_permits';
const AHORA = Date.parse('2026-10-04T12:00:00.000Z');

test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const nuevoEstado = () => {
  const f = path.join(tmpDir, `q-${Math.random().toString(36).slice(2)}.json`);
  return { stateFile: f, lockFile: `${f}.lock` };
};

const indiceVacio = () => ({ dedupKeys: new Set(), crossKeys: new Set(), total: 0, pages: 1, complete: true });

/**
 * Corre la fuente de la ciudad contra un servidor simulado.
 * Devuelve `{ result, servidor }` y cierra el servidor al terminar.
 */
async function corridaCity({ mode = 'ok', crmIndex = indiceVacio(), etag = null, lastModified = null, limit, body = null } = {}) {
  const servidor = await fixture.createFakeCityServer({ mode, body });
  // Se apunta la definición al servidor simulado, y se restaura después: el
  // recurso permitido es UNO, y la comprobación de buildCsvUrl es sobre él.
  const original = SOURCES[CITY].downloadUrl;
  const entry = allowlistEntry(CITY);
  const permitidasOriginal = entry.robots.allowedResources;
  SOURCES[CITY].downloadUrl = servidor.csvUrl;
  entry.robots.allowedResources = [servidor.csvUrl];
  const { stateFile, lockFile } = nuevoEstado();
  try {
    const result = await fetchFromSource(CITY, {
      crmIndex, etag, lastModified, limit,
      quotaOptions: { stateFile, lockFile },
      clock: () => AHORA,
      userAgent: 'CaliCleanProspector/1.0 (+https://cali-clean.net)',
    });
    return { result, servidor, stateFile };
  } finally {
    SOURCES[CITY].downloadUrl = original;
    entry.robots.allowedResources = permitidasOriginal;
    servidor.close();
  }
}

// ── Parser CSV ───────────────────────────────────────────────
test('el parser aguanta comillas, comas y saltos de línea dentro de un campo', () => {
  assert.deepEqual(parseCsv('a,b,c\n1,"dos, con coma",3\n'), [['a', 'b', 'c'], ['1', 'dos, con coma', '3']]);
  assert.deepEqual(parseCsv('a,b\n"multi\nlinea",x\r\n'), [['a', 'b'], ['multi\nlinea', 'x']]);
  assert.deepEqual(parseCsv('a\n"con ""comillas"" dentro"\n'), [['a'], ['con "comillas" dentro']]);
  assert.deepEqual(parseCsv('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
});

test('el parser no adivina: un CSV malformado es un error', () => {
  assert.throws(() => parseCsv('a\n"sin cerrar\n'), CsvFormatError);
  assert.throws(() => parseCsv('a\nmal"medio\n'), CsvFormatError);
  assert.throws(() => parseCsv('a\n"x"basura\n'), CsvFormatError);
});

test('un campo que no cabe en los topes para el parseo, no lo recorta', () => {
  const parser = new CsvParser({ maxFieldBytes: 10 });
  assert.throws(() => parser.push('a'.repeat(20)), /supera 10 bytes/);
});

test('el parser entrega filas aunque los trozos corten por medio de un campo', () => {
  const parser = new CsvParser();
  const filas = [
    ...parser.push('nombre,ciu'),
    ...parser.push('dad\n"Bahía Taq'),
    ...parser.push('uería, SA",San Di'),
    ...parser.push('ego\n'),
    ...parser.end(),
  ];
  assert.deepEqual(filas, [['nombre', 'ciudad'], ['Bahía Taquería, SA', 'San Diego']]);
});

test('una fila con otro número de columnas no se rellena ni se recorta', () => {
  const header = ['a', 'b', 'c'];
  assert.equal(rowToObject(header, ['1', '2']).ok, false);
  assert.equal(rowToObject(header, ['1', '2', '3', '4']).ok, false);
  // Rellenar desplazaría los valores y la ciudad acabaría en el campo del estado.
  assert.deepEqual(rowToObject(header, ['1', '2', '3']).row, { a: '1', b: '2', c: '3' });
});

// ── Reglas de la fuente ──────────────────────────────────────
test('solo pasan formas jurídicas inequívocas', () => {
  for (const ok of rules.CITY_ENTITY_ALLOWED) {
    const r = rules.evaluateCityRow(fixture.cityRow({ account_key: 'X', dba_name: 'Negocio Real', ownership_type: ok }), '', { now: AHORA });
    assert.equal(r.ok, true, `${ok} debería pasar: ${r.reason}`);
  }
  for (const no of ['SOLE', 'H-W', 'TRUST', 'IND']) {
    const r = rules.evaluateCityRow(fixture.cityRow({ account_key: 'X', dba_name: 'Negocio Real', ownership_type: no }), '', { now: AHORA });
    assert.equal(r.ok, false, `${no} no debería pasar`);
    assert.equal(r.kind, 'personal');
  }
  // Una forma desconocida se descarta, no se interpreta.
  const raro = rules.evaluateCityRow(fixture.cityRow({ account_key: 'X', dba_name: 'Negocio Real', ownership_type: 'ZZZ' }), '', { now: AHORA });
  assert.equal(raro.ok, false);
  assert.equal(raro.kind, 'unverifiable');
});

test('el nombre comercial que es el del titular se descarta', () => {
  assert.equal(rules.dbaIsOwnerName('Vega Marisol', 'Vega Marisol'), true);
  assert.equal(rules.dbaIsOwnerName('Salazar, Ramon', 'Ramon Salazar'), true, 'mismo nombre, otro orden');
  assert.equal(rules.dbaIsOwnerName('Bahía Taquería', 'Fernandez, Ana Lucia'), false);
  assert.equal(rules.dbaIsOwnerName('', 'Alguien'), false);

  const r = rules.evaluateCityRow(
    fixture.cityRow({ account_key: 'X', dba_name: 'Salazar, Ramon', ownership_type: 'CORP' }),
    'Ramon Salazar', { now: AHORA },
  );
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'personal');
});

test('los sectores NAICS permitidos están documentados y los demás se descartan', () => {
  for (const sector of Object.keys(rules.CITY_NAICS_SECTORS)) {
    const r = rules.naicsSector(`${sector}1234`);
    assert.equal(r.allowed, true, `sector ${sector} debería estar permitido`);
    assert.ok(r.label, `sector ${sector} sin motivo documentado`);
  }
  for (const sector of ['11', '21', '22', '31', '48', '52', '61', '92']) {
    assert.equal(rules.naicsSector(`${sector}1234`).allowed, false, `sector ${sector} no debería pasar`);
  }
});

test('los códigos NAICS domiciliarios o personales se descartan aunque su sector valga', () => {
  for (const code of rules.CITY_NAICS_EXCLUDED) {
    const r = rules.evaluateCityRow(
      fixture.cityRow({ account_key: 'X', dba_name: 'Negocio Real', naics_code: code, naics_sector: code.slice(0, 2) }),
      '', { now: AHORA },
    );
    assert.equal(r.ok, false, `${code} no debería pasar`);
    assert.ok(['residential', 'unverifiable'].includes(r.kind));
  }
});

test('el certificado tiene que estar activo y vigente', () => {
  const casos = [
    [{ account_status: 'Inactive' }, 'inactive'],
    [{ date_cert_expiration: '2025-06-30' }, 'inactive'],
    [{ date_cert_effective: '2027-12-01' }, 'inactive'],
    [{ date_cert_expiration: 'ayer' }, 'unverifiable'],
  ];
  for (const [patch, kind] of casos) {
    const r = rules.evaluateCityRow(
      fixture.cityRow({ account_key: 'X', dba_name: 'Negocio Real', ...patch }), '', { now: AHORA },
    );
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.equal(r.kind, kind, JSON.stringify(patch));
  }
});

test('la dirección tiene que ser comercial, completa y de San Diego', () => {
  const casos = [
    [{ address_no: '' }, 'unverifiable'],
    [{ address_road: '' }, 'unverifiable'],
    [{ address_zip: '' }, 'unverifiable'],
    [{ address_city: 'Chula Vista' }, 'unverifiable'],
    [{ address_road: 'Island Apt 7B' }, 'residential'],
    [{ address_road: 'Convoy St PMB 440' }, 'residential'],
    [{ address_road: 'Residence' }, 'residential'],
    [{ address_sfx: 'St Unit 4' }, 'residential'],
  ];
  for (const [patch, kind] of casos) {
    const r = rules.evaluateCityRow(
      fixture.cityRow({ account_key: 'X', dba_name: 'Negocio Real', ...patch }), '', { now: AHORA },
    );
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.equal(r.kind, kind, JSON.stringify(patch));
  }
});

test('el segmento sale del NAICS con reglas explícitas', () => {
  assert.equal(rules.segmentFromNaics('722511'), 'restaurants');
  assert.equal(rules.segmentFromNaics('621210'), 'offices');
  assert.equal(rules.segmentFromNaics('531312'), 'property_managers');
  assert.equal(rules.segmentFromNaics('238220'), 'post_construction');
  assert.equal(rules.segmentFromNaics('445110'), 'retail');
  assert.equal(rules.segmentFromNaics('111998'), null, 'un sector fuera de la lista no tiene segmento');
});

// ── Cliente CSV ──────────────────────────────────────────────
test('un GET por corrida, con el recurso oficial y nada más', async () => {
  const { result, servidor } = await corridaCity();
  assert.equal(result.blocked, null);
  assert.equal(servidor.requests.length, 1, 'tenía que ser exactamente un GET');
  assert.equal(servidor.requests[0].method, 'GET');
  assert.match(servidor.requests[0].url, /sd_businesses_active_datasd\.csv/);
  assert.ok(servidor.requests[0].userAgent, 'sin User-Agent no se identifica quién pide');
  assert.equal(result.metrics.attempted, 1);
});

test('buildCsvUrl se niega a pedir cualquier cosa que no sea el recurso permitido', () => {
  assert.equal(buildCsvUrl(SOURCES[CITY], CITY), SOURCES[CITY].downloadUrl);

  const otra = { ...SOURCES[CITY], downloadUrl: 'https://seshat.datasd.org/otra_cosa.csv' };
  assert.throws(() => buildCsvUrl(otra, CITY), /no está en los recursos permitidos/);

  const html = { ...SOURCES[CITY], downloadUrl: 'https://data.sandiego.gov/datasets/business-tax-certificates/' };
  assert.throws(() => buildCsvUrl(html, CITY), /no está en los recursos permitidos/);
});

test('el hash es del archivo completo y acompaña a la corrida', async () => {
  const { result } = await corridaCity();
  assert.equal(result.csv.sha256, fixture.CITY_CSV_SHA256);
  assert.equal(result.csv.bytes, Buffer.byteLength(fixture.CITY_CSV));
  assert.equal(result.metrics.fetched_bytes, result.csv.bytes);
  assert.ok(result.csv.headers.etag, 'el ETag de la respuesta se conserva para la próxima vez');
  assert.ok(result.csv.headers.lastModified);
});

test('con ETag conocido el servidor responde 304 y no se procesa nada', async () => {
  const servidor = await fixture.createFakeCityServer({ mode: 'ok' });
  const original = SOURCES[CITY].downloadUrl;
  const entry = allowlistEntry(CITY);
  const permitidas = entry.robots.allowedResources;
  SOURCES[CITY].downloadUrl = servidor.csvUrl;
  entry.robots.allowedResources = [servidor.csvUrl];
  const { stateFile, lockFile } = nuevoEstado();
  try {
    const r = await fetchFromSource(CITY, {
      crmIndex: indiceVacio(), etag: servidor.etag,
      quotaOptions: { stateFile, lockFile }, clock: () => AHORA,
    });
    assert.equal(r.blocked.reason, 'sin_cambios_304');
    assert.equal(r.metrics.fetched, 0);
    assert.equal(r.rows.length, 0);
    assert.equal(servidor.requests[0].ifNoneMatch, servidor.etag, 'no se envió el If-None-Match');
    // Un 304 no gasta la ventana del día: no había nada que mirar.
    assert.equal(quota.readState(stateFile).sources[CITY], undefined);
  } finally {
    SOURCES[CITY].downloadUrl = original;
    entry.robots.allowedResources = permitidas;
    servidor.close();
  }
});

test('un archivo que anuncia más del tope se rechaza antes de leerlo', async () => {
  await assert.rejects(() => corridaCity({ mode: 'oversize' }), /tope|TOO_LARGE|bytes/i);
});

test('una descarga cortada a medias es un error, no media verdad', async () => {
  // Lo que importa no es el texto del error —undici puede cortar antes o
  // después de las cabeceras y el mensaje cambia— sino que no quede nada: ni
  // filas a medias, ni un temporal con nombres de personas en el disco.
  await assert.rejects(() => corridaCity({ mode: 'truncated' }), (err) => {
    assert.equal(err.name, 'CsvFetchError');
    for (const aguja of fixture.CITY_DATOS_PROHIBIDOS) {
      assert.ok(!err.message.includes(aguja), `el error filtró "${aguja}"`);
    }
    return true;
  });
  assert.deepEqual(
    fs.readdirSync(process.env.SOURCE_CSV_TMP_DIR).filter((f) => f.startsWith('cc-csv-')), [],
    'quedó un CSV a medias en disco',
  );
});

test('un CSV vacío es un error', async () => {
  await assert.rejects(() => corridaCity({ mode: 'empty' }), /vac/i);
});

test('el temporal del CSV no se queda en disco', async () => {
  const antes = fs.readdirSync(process.env.SOURCE_CSV_TMP_DIR).length;
  await corridaCity();
  const despues = fs.readdirSync(process.env.SOURCE_CSV_TMP_DIR);
  assert.deepEqual(despues.filter((f) => f.startsWith('cc-csv-')), [],
    'el CSV contiene nombres de personas y no puede quedarse en disco');
  assert.ok(despues.length <= antes + 0);

  // Y también se limpia si una corrida anterior murió a medias.
  const huerfano = path.join(process.env.SOURCE_CSV_TMP_DIR, 'cc-csv-viejo.csv');
  fs.writeFileSync(huerfano, 'titular,privado\n');
  fs.utimesSync(huerfano, new Date(Date.now() - 7200000), new Date(Date.now() - 7200000));
  const limpiados = csvClient.cleanupStaleCsvTemps({ dir: process.env.SOURCE_CSV_TMP_DIR });
  assert.ok(limpiados >= 1);
  assert.equal(fs.existsSync(huerfano), false);
});

// ── Defensa de datos, de punta a punta ───────────────────────
test('la corrida deja solo los negocios demostrables', async () => {
  const { result } = await corridaCity();
  const nombres = result.rows.map((r) => r.businessName);
  assert.deepEqual(nombres.sort(), [
    'Bahía Taquería', 'Gaslamp Coffee, "The Original"', 'Harbor View\nDental Group',
    'Pacific Property Partners Lp',
  ].sort());

  assert.equal(result.metrics.mapped, 4);
  assert.ok(result.metrics.skipped_personal >= 4, `personales: ${result.metrics.skipped_personal}`);
  assert.ok(result.metrics.skipped_residential >= 3, `domicilio: ${result.metrics.skipped_residential}`);
  assert.equal(result.metrics.skipped_inactive, 3);
  assert.ok(result.metrics.skipped_unverifiable >= 5);
  assert.equal(result.metrics.deduped, 1, 'la fila repetida de la corrida');
});

test('ni un dato personal sobrevive: ni al prospecto, ni a raw, ni al snapshot', async () => {
  const { result } = await corridaCity();
  const volcado = JSON.stringify(result.rows);
  for (const aguja of fixture.CITY_DATOS_PROHIBIDOS) {
    assert.ok(!volcado.includes(aguja), `"${aguja}" sobrevivió a la corrida`);
  }
  for (const row of result.rows) {
    for (const k of Object.keys(row.raw)) {
      assert.ok(allowedFields(CITY).includes(k), `raw conserva "${k}", que no está permitido`);
      assert.ok(!forbiddenFields(CITY).includes(k));
    }
  }

  // Y tampoco al snapshot.
  const w = snap.writeSnapshot({
    sourceId: CITY, mode: 'indice_crm', cursorIn: null, cursorOut: null,
    rows: result.rows, metrics: result.metrics,
  });
  const texto = fs.readFileSync(w.file, 'utf8');
  for (const aguja of fixture.CITY_DATOS_PROHIBIDOS) {
    assert.ok(!texto.includes(aguja), `"${aguja}" entró en el snapshot`);
  }
});

test('una columna nueva con datos personales se cae sin que nadie la prohíba', async () => {
  const { result } = await corridaCity({ mode: 'unknownColumns' });
  const volcado = JSON.stringify(result.rows);
  assert.ok(!volcado.includes('+16195550101'), 'un teléfono de una columna nueva sobrevivió');
  assert.ok(!volcado.includes('privado@ejemplo.invalid'));
  assert.ok(!volcado.includes('owner_mobile_phone'));
  for (const row of result.rows) {
    for (const k of Object.keys(row.raw)) assert.ok(allowedFields(CITY).includes(k));
  }
});

test('las métricas son recuentos y no llevan ni un dato personal', async () => {
  const { result } = await corridaCity();
  const texto = JSON.stringify(result.metrics);
  for (const aguja of fixture.CITY_DATOS_PROHIBIDOS) assert.ok(!texto.includes(aguja));
  for (const v of Object.values(result.metrics)) assert.equal(typeof v, 'number');
});

test('el error de un CSV malformado no lleva contenido de la fila', async () => {
  await assert.rejects(() => corridaCity({ mode: 'malformed' }), (err) => {
    for (const aguja of fixture.CITY_DATOS_PROHIBIDOS) {
      assert.ok(!err.message.includes(aguja), `el error filtró "${aguja}"`);
    }
    return true;
  });
});

// ── Clave de deduplicación y mapeo ───────────────────────────
test('la clave es determinista y sale del account_key', async () => {
  const a = await corridaCity();
  const b = await corridaCity();
  assert.deepEqual(a.result.rows.map((r) => r.dedupKey), b.result.rows.map((r) => r.dedupKey));
  for (const row of a.result.rows) {
    assert.match(row.dedupKey, /^city-btc:B2026-/);
    assert.ok(!/\.com|\.net|^web:/.test(row.dedupKey), 'la clave no puede apoyarse en un dominio');
  }
});

test('el rastro de procedencia apunta al dataset oficial y el área es San Diego', async () => {
  const { result } = await corridaCity();
  for (const row of result.rows) {
    assert.equal(row.sourceUrl, 'https://data.sandiego.gov/datasets/business-tax-certificates/');
    assert.equal(row.serviceArea, 'San Diego');
    assert.ok(row.segment, 'sin segmento no se puede vender nada');
    assert.ok(row.entityType);
    assert.equal(row.signal.type, 'active_certificate');
  }
});

test('el tope de 50 candidatos no se puede subir desde el llamante', async () => {
  const muchas = [];
  for (let i = 0; i < 80; i++) {
    muchas.push(fixture.cityRow({ account_key: `B-LOTE-${String(i).padStart(3, '0')}`, dba_name: `Negocio Lote ${i} LLC` }));
  }
  const { result } = await corridaCity({ body: fixture.toCsv(muchas), limit: 5000 });
  assert.equal(result.rows.length, 50, `salieron ${result.rows.length}`);
  assert.equal(result.metrics.mapped, 50);
});

// ── Deduplicación cruzada ────────────────────────────────────
test('lo que ya está en el CRM no se vuelve a proponer', async () => {
  const sinIndice = await corridaCity();
  const yaEstan = sinIndice.result.rows.slice(0, 2);

  const crmIndex = indiceVacio();
  crmIndex.dedupKeys.add(yaEstan[0].dedupKey);
  crmIndex.crossKeys.add(crossKey(yaEstan[1].businessName, yaEstan[1].address));

  const { result } = await corridaCity({ crmIndex });
  // Tres, no dos: la fila repetida de B2026-001 también cae aquí, porque la
  // comprobación contra el CRM va antes de registrar la clave como vista. Que
  // cuente como "ya existe" en vez de como "duplicada en la corrida" es
  // correcto: ya existe.
  assert.equal(result.metrics.skipped_duplicate_existing, 3);
  assert.equal(result.metrics.deduped, 0);
  const claves = result.rows.map((r) => r.dedupKey);
  assert.ok(!claves.includes(yaEstan[0].dedupKey), 'se repitió uno que ya estaba por clave');
  assert.ok(!claves.includes(yaEstan[1].dedupKey), 'se repitió uno que ya estaba por nombre+dirección');
});

test('un solapamiento con una empresa del condado se omite, no la modifica', async () => {
  const crmIndex = indiceVacio();
  // La misma empresa, ya ingerida desde el condado con otra clave.
  crmIndex.dedupKeys.add('sdcounty-ffp:DEH-OTRO');
  crmIndex.crossKeys.add(crossKey('Bahía Taquería', '1450 Harbor Dr'));

  const { result } = await corridaCity({ crmIndex });
  const nombres = result.rows.map((r) => r.businessName);
  assert.ok(!nombres.includes('Bahía Taquería'), 'se propuso una empresa que ya existe con otra procedencia');
  // Dos: la fila original y su repetición en el mismo CSV.
  assert.equal(result.metrics.skipped_duplicate_existing, 2);
  // Y no se propone ninguna actualización de la existente: se omite y punto.
  assert.equal(result.metrics.planned_update, 0);
});

test('sin índice del CRM la fuente no corre', async () => {
  const servidor = await fixture.createFakeCityServer();
  const original = SOURCES[CITY].downloadUrl;
  const entry = allowlistEntry(CITY);
  const permitidas = entry.robots.allowedResources;
  SOURCES[CITY].downloadUrl = servidor.csvUrl;
  entry.robots.allowedResources = [servidor.csvUrl];
  try {
    const r = await fetchFromSource(CITY, { crmIndex: null, quotaOptions: nuevoEstado(), clock: () => AHORA });
    assert.equal(r.blocked.reason, 'sin_indice_crm');
    assert.equal(servidor.requests.length, 0, 'salió a la red sin saber qué tenía el CRM');
  } finally {
    SOURCES[CITY].downloadUrl = original;
    entry.robots.allowedResources = permitidas;
    servidor.close();
  }
});

test('crossKey normaliza lo suficiente para reconocer el mismo negocio', () => {
  assert.equal(crossKey('Bahía Taquería LLC', '1450 Harbor Dr'), crossKey('bahia taqueria', '1450 HARBOR DR'));
  assert.notEqual(crossKey('Bahía Taquería', '1450 Harbor Dr'), crossKey('Bahía Taquería', '620 Fifth Ave'));
  assert.equal(crossKey('', 'x'), null);
});

// ── Cuotas independientes ────────────────────────────────────
test('la cuota de la ciudad y la del condado no se estorban', async () => {
  const cityState = nuevoEstado();
  const countyState = nuevoEstado();

  // La ciudad corre y gasta SU ventana.
  const servidor = await fixture.createFakeCityServer();
  const original = SOURCES[CITY].downloadUrl;
  const entry = allowlistEntry(CITY);
  const permitidas = entry.robots.allowedResources;
  SOURCES[CITY].downloadUrl = servidor.csvUrl;
  entry.robots.allowedResources = [servidor.csvUrl];
  try {
    const primera = await fetchFromSource(CITY, {
      crmIndex: indiceVacio(), quotaOptions: cityState, clock: () => AHORA,
    });
    assert.equal(primera.blocked, null);

    const segunda = await fetchFromSource(CITY, {
      crmIndex: indiceVacio(), quotaOptions: cityState, clock: () => AHORA,
    });
    assert.equal(segunda.blocked.reason, 'cuota_24h', 'la segunda corrida de la ciudad tenía que bloquearse');
  } finally {
    SOURCES[CITY].downloadUrl = original;
    entry.robots.allowedResources = permitidas;
    servidor.close();
  }

  // Y el estado de la ciudad no dice nada del condado.
  assert.ok(quota.readState(cityState.stateFile).sources[CITY]);
  assert.equal(quota.readState(cityState.stateFile).sources[COUNTY], undefined);
  assert.equal(quota.readState(countyState.stateFile).sources[CITY], undefined);
});

test('el guard durable de la ciudad usa su prefijo y no el del condado', async () => {
  const crm = await createFakeTwenty({
    seed: [
      { ...EXISTING_COMPANY, id: 'c1', name: 'County Uno', dedupKey: 'sdcounty-ffp:DEH-900', lastVerified: new Date(AHORA - 3600000).toISOString(), deletedAt: null },
    ],
  });
  try {
    const client = createClient({ baseUrl: crm.baseUrl });

    // La ciudad no tiene ninguna empresa: su guard permite, aunque el condado
    // acabe de correr hace una hora.
    const city = await checkDurableQuota({
      namespace: 'city-btc', now: AHORA,
      lookup: (p) => latestVerifiedWithPrefix(client, p),
    });
    assert.equal(city.allowed, true, 'el guard de la ciudad se dejó bloquear por el condado');

    // Y el del condado sigue bloqueando.
    const county = await checkDurableQuota({
      namespace: 'sdcounty-ffp', now: AHORA,
      lookup: (p) => latestVerifiedWithPrefix(client, p),
    });
    assert.equal(county.allowed, false);
    assert.equal(county.reason, 'cuota_24h_durable');
    assert.deepEqual(crm.writes(), []);
  } finally {
    crm.server.close();
  }
});

test('y al revés: una carga de la ciudad no bloquea al condado', async () => {
  const crm = await createFakeTwenty({
    seed: [
      { ...EXISTING_COMPANY, id: 'b1', name: 'City Uno', dedupKey: 'city-btc:B2026-001', lastVerified: new Date(AHORA - 3600000).toISOString(), deletedAt: null },
    ],
  });
  try {
    const client = createClient({ baseUrl: crm.baseUrl });
    const county = await checkDurableQuota({
      namespace: 'sdcounty-ffp', now: AHORA, lookup: (p) => latestVerifiedWithPrefix(client, p),
    });
    assert.equal(county.allowed, true);
    const city = await checkDurableQuota({
      namespace: 'city-btc', now: AHORA, lookup: (p) => latestVerifiedWithPrefix(client, p),
    });
    assert.equal(city.allowed, false);
    assert.equal(city.reason, 'cuota_24h_durable');
  } finally {
    crm.server.close();
  }
});

// ── Attestation de la fuente ─────────────────────────────────
test('la attestation de la ciudad vale por sí sola, en su propio archivo', () => {
  const r = attestationFor(CITY);
  assert.equal(r.ok, true, `problemas: ${(r.problems || []).join('; ')}`);
  assert.match(r.file, /source-attestation-city\.json$/);

  const e = r.entry;
  assert.equal(e.license.licenseId, 'ODC-PDDL-1.0');
  assert.equal(e.datasetPage, 'https://data.sandiego.gov/datasets/business-tax-certificates/');
  assert.equal(e.downloadUrl, SOURCES[CITY].downloadUrl);
  assert.equal(e.artifacts.csvHead.httpStatus, 200);
  assert.equal(e.artifacts.csvHead.contentLength, 18861591);
  assert.equal(e.artifacts.csvHead.lastModified, 'Sat, 03 Oct 2026 09:06:24 GMT');
  assert.equal(e.artifacts.csvHead.sha256, '5c3e7e6a94848582dbd827936e8ff0a7d1fca2f2fee793c0a47bc27e3781109b');
  assert.equal(e.artifacts.csvHead.etagPresent, true);
  assert.equal(e.artifacts.csvHead.acceptRanges, 'bytes');
  assert.deepEqual(e.observedHeader, fixture.CITY_HEADER);

  // El robots ilegible NO se lee como permiso.
  assert.equal(e.robots.dataPortalStatus, 404);
  assert.equal(e.robots.downloadHostStatus, 403);
  assert.equal(e.robots.htmlCrawlingAllowed, false);
  assert.match(e.robots.interpretation, /NO se interpreta como permiso/);
  assert.deepEqual(e.robots.allowedResources, [SOURCES[CITY].downloadUrl]);

  // Y queda escrito que el hash es de un volcado, no una constante.
  assert.match(e.artifacts.csvHead.sha256Scope, /no una constante/);
  assert.match(e.personalDataNotice, /business_owner_name/);
});

test('la attestation de la ciudad no bloquea a la del condado ni al contrario', () => {
  assert.equal(attestationFor(CITY).ok, true);
  assert.equal(attestationFor(COUNTY).ok, true);
  assert.notEqual(attestationFor(CITY).file, attestationFor(COUNTY).file);
  assert.notEqual(attestationFor(CITY).attestation.digest, attestationFor(COUNTY).attestation.digest);
});

test('una evidencia caducada o con digest roto falla cerrado', async () => {
  const { verifyAttestation, computeDigest } = await import('../src/prospecting/sources/attestation.js');
  const base = attestationFor(CITY).attestation;

  const vieja = structuredClone(base);
  vieja.evidenceCollectedAt = '2024-01-01T00:00:00.000Z';
  vieja.digest = computeDigest(vieja);
  assert.equal(verifyAttestation(vieja).valid, false);

  const tocada = structuredClone(base);
  tocada.sources[CITY].artifacts.csvHead.contentLength = 1;
  assert.equal(verifyAttestation(tocada).valid, false, 'un byte cambiado tiene que invalidar el digest');

  const malformada = structuredClone(base);
  delete malformada.sources[CITY].license;
  malformada.digest = computeDigest(malformada);
  assert.equal(verifyAttestation(malformada).valid, false);
});

// ── Snapshot, plan y contención ──────────────────────────────
test('el snapshot de la ciudad lleva hash, caduca y solo vale en su sesión', async () => {
  const { result } = await corridaCity();
  const w = snap.writeSnapshot({
    sourceId: CITY, mode: 'indice_crm', cursorIn: null, cursorOut: null,
    rows: result.rows, metrics: result.metrics,
  });
  assert.match(w.hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(snap.readSnapshot(w.file).ok, true);

  const doc = JSON.parse(fs.readFileSync(w.file, 'utf8'));
  doc.rows.push({ businessName: 'Colada a mano', dedupKey: 'city-btc:Z' });
  fs.writeFileSync(w.file, JSON.stringify(doc, null, 2));
  assert.equal(snap.readSnapshot(w.file).ok, false);
});

test('planificar la ciudad contra el CRM no escribe nada y solo toca Companies', async () => {
  const { result } = await corridaCity();
  const fake = await createFakeTwenty({ seed: [] });
  try {
    const client = createClient({ baseUrl: fake.baseUrl });
    const planes = [];
    for (const row of result.rows) {
      planes.push(await planCompanyUpsert(client, {
        dedupKey: row.dedupKey, businessName: row.businessName, sourceUrl: row.sourceUrl,
        serviceArea: row.serviceArea, address: row.address, city: row.city, zip: row.zip,
        state: 'CA', country: 'US', stage: 'discovered', channel: 'public_record',
        lastVerified: '2026-10-04T12:00:00.000Z',
      }));
    }
    assert.deepEqual(planes.map((p) => p.action), result.rows.map(() => 'create'));
    assert.deepEqual(fake.writes(), [], 'planificar escribió');
    assert.ok(fake.requests.every((q) => q.method === 'GET'));
    assert.equal(fake.companies.length, 0);

    // Solo Companies: ninguna petición a otra colección.
    for (const q of fake.requests) assert.match(q.path, /^\/rest\/companies/);

    // Y la procedencia es la del directorio público.
    const body = planes[0].body;
    assert.equal(body.leadSource, 'BUSINESS_DIRECTORY');
  } finally {
    fake.server.close();
  }
});

test('la corrida de la ciudad no escribe ni envía nada', async () => {
  const { result } = await corridaCity();
  assert.equal(result.metrics.crm_writes, 0);
  assert.equal(result.metrics.outbound, 0);
  const { config } = await import('../src/config.js');
  assert.equal(config.outbound.enabled, false);
});

test('el índice del CRM se lee sin escribir y pagina hasta el final', async () => {
  const seed = [];
  for (let i = 0; i < 130; i++) {
    seed.push({ ...EXISTING_COMPANY, id: `id-${String(i).padStart(3, '0')}`, name: `Empresa ${i}`, dedupKey: `city-btc:B-${i}`, deletedAt: null });
  }
  const fake = await createFakeTwenty({ seed });
  try {
    const client = createClient({ baseUrl: fake.baseUrl });
    const index = await loadCrmIndex(client, { normalize: rules.normalizeForMatch });
    assert.equal(index.complete, true);
    assert.equal(index.dedupKeys.size, 130, `indexó ${index.dedupKeys.size}`);
    assert.ok(index.pages >= 3, `páginas: ${index.pages}`);
    assert.deepEqual(fake.writes(), []);
  } finally {
    fake.server.close();
  }
});

// ── La ciudad sigue apagada en el repositorio ────────────────
test('en el allowlist versionado la ciudad está apagada', () => {
  const versionado = JSON.parse(
    fs.readFileSync(new URL('../config/source-allowlist.json', import.meta.url), 'utf8'),
  );
  assert.equal(versionado.sources[CITY].enabled, false,
    'la ciudad no puede quedar encendida en el repositorio');
  assert.equal(versionado.sources[CITY].implemented, true);
  assert.equal(versionado.sources[COUNTY].enabled, true, 'el condado sigue encendido');
  const habilitadas = Object.entries(versionado.sources).filter(([, e]) => e.enabled).map(([k]) => k);
  assert.deepEqual(habilitadas, [COUNTY]);
});

test('las métricas traen los campos de las dos fuentes y ninguno sobra', () => {
  assert.deepEqual(Object.keys(emptyMetrics()).sort(), [
    'attempted', 'crm_writes', 'deduped', 'duration_ms', 'errors', 'fetched',
    'fetched_bytes', 'http429', 'mapped', 'outbound', 'planned_create',
    'planned_noop', 'planned_update', 'quota_blocked', 'retries',
    'skipped_duplicate_existing', 'skipped_inactive', 'skipped_invalid',
    'skipped_personal', 'skipped_residential', 'skipped_sensitive',
    'skipped_unverifiable',
  ]);
});
