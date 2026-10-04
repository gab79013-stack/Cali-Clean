/**
 * Reglas de la fuente: certificados de actividad de la Ciudad de San Diego.
 *
 * Este archivo existe porque el CSV municipal es mucho más peligroso que el
 * dataset del condado. El condado publica establecimientos; la ciudad publica
 * **titulares**: `business_owner_name` es el nombre de una persona física en un
 * número enorme de filas, y una parte grande de los certificados son
 * autónomos trabajando desde su casa. Un filtro laxo aquí no produce leads
 * mediocres: produce una lista de particulares con su domicilio.
 *
 * De ahí las cuatro reglas que gobiernan todo lo de abajo:
 *
 *   1. El titular se puede **mirar de paso** para una sola cosa —comprobar que
 *      el nombre comercial no es el de la persona— y no se guarda en ningún
 *      sitio: ni en el prospecto, ni en `raw_json`, ni en el snapshot, ni en un
 *      log, ni en el texto de un error.
 *   2. Solo pasan **formas jurídicas inequívocas**. SOLE (autónomo), H-W
 *      (matrimonio) y TRUST son personas, no empresas, y quedan fuera. Lo que
 *      no esté en la lista se descarta, no se interpreta.
 *   3. Solo pasan **sectores NAICS** donde un contrato de limpieza comercial
 *      tiene sentido, y la lista se justifica sector a sector.
 *   4. Solo pasan **direcciones comerciales completas**. Sin apartado de
 *      correos, sin PMB, sin número de vivienda, y con calle, ciudad y ZIP.
 *
 * Si algo no se puede demostrar, se omite. Perder un candidato dudoso cuesta
 * mucho menos que escribirle a alguien en su casa.
 */

/** Columnas que se pueden conservar. Lista cerrada. */
export const CITY_ALLOWED_FIELDS = Object.freeze([
  'account_key',
  'account_status',
  'date_account_creation',
  'date_cert_expiration',
  'date_cert_effective',
  'date_business_start',
  'ownership_type',
  'dba_name',
  'naics_sector',
  'naics_code',
  'naics_description',
  'address_no',
  'address_pd',
  'address_road',
  'address_sfx',
  'address_city',
  'address_state',
  'address_zip',
  'council_district',
]);

/**
 * Columnas prohibidas, con el motivo. `business_owner_name` está aquí: se puede
 * leer de paso en la fila cruda, pero NUNCA conservarse.
 */
export const CITY_FORBIDDEN_FIELDS = Object.freeze([
  'business_owner_name',   // persona física
  'lat',                   // geolocaliza el domicilio
  'lng',
  'address_pmb_box',       // buzón privado: indicio de domicilio
  'address_po_box',
  'address_suite',         // número de vivienda o de despacho, innecesario
  'address_no_fraction',   // "1/2": partición de vivienda
  'bid',                   // distrito de mejora comercial: no aporta y es ruido
]);

/**
 * Formas jurídicas que SÍ son una entidad, no una persona.
 *
 * Cada una, con lo que significa en este dataset:
 *   CORP  sociedad anónima          LLC   sociedad de responsabilidad limitada
 *   SCORP sociedad del subcapítulo S LP   sociedad comanditaria
 *   NO    organización sin ánimo de lucro
 *   PRF   sociedad profesional
 *
 * Lo que queda fuera y por qué: SOLE es un autónomo (persona física), H-W es un
 * matrimonio (dos personas), TRUST es un patrimonio familiar. Cualquier otro
 * código se descarta hasta que alguien demuestre qué es: el valor por defecto
 * de una forma jurídica desconocida no puede ser "adelante".
 */
export const CITY_ENTITY_ALLOWED = Object.freeze(['CORP', 'LLC', 'SCORP', 'LP', 'NO', 'PRF']);
export const CITY_ENTITY_REJECTED_PERSONAL = Object.freeze(['SOLE', 'H-W', 'HW', 'TRUST', 'IND', 'INDIVIDUAL']);

/**
 * Sectores NAICS de dos dígitos donde una empresa de limpieza comercial tiene
 * algo que vender, con la razón de cada uno.
 */
export const CITY_NAICS_SECTORS = Object.freeze({
  23: 'Construcción — limpieza de obra y entrega de llaves',
  42: 'Comercio mayorista — almacenes y oficinas',
  44: 'Comercio minorista — locales con público',
  45: 'Comercio minorista — locales con público',
  53: 'Inmobiliario y alquiler — administradores de fincas y oficinas',
  54: 'Servicios profesionales, científicos y técnicos — oficinas',
  55: 'Gestión de empresas — sedes y oficinas',
  56: 'Servicios administrativos y de apoyo — edificios y servicios a empresas',
  62: 'Sanidad y asistencia social — consultorios y clínicas',
  71: 'Arte, ocio y recreación — instalaciones con público',
  72: 'Alojamiento y restauración — hoteles y restaurantes',
  81: 'Otros servicios — talleres, peluquerías, reparación (locales comerciales)',
});

/**
 * Códigos NAICS que quedan fuera aunque su sector esté permitido.
 *
 * Son actividades que se ejercen en el domicilio o sobre personas, donde un
 * contrato de limpieza de local no aplica y el titular suele ser un particular.
 */
export const CITY_NAICS_EXCLUDED = Object.freeze([
  '814110',   // hogares con empleados domésticos
  '624410',   // guarderías (a menudo en domicilio)
  '812990',   // otros servicios personales
  '711510',   // artistas y autores independientes
  '531110',   // alquiler de vivienda
  '531210',   // agentes inmobiliarios (persona)
  '812112',   // salones de belleza unipersonales
  '812113',   // manicura y pedicura
]);

/** Señales de que una dirección no es un local comercial. */
const NON_COMMERCIAL_ADDRESS = [
  /\bp\.?\s?o\.?\s*box\b/i,
  /\bpmb\b/i,
  /\bprivate\s+mail\b/i,
  /\bapt\b|\bapartment\b/i,
  /\bunit\s*[0-9a-z]*\b/i,
  /\b#\s*\d+\b/,
  /\bspc\b|\bspace\b/i,
  /\bmobile\s+home\b/i,
  /\btrailer\b/i,
  /\bresidence\b|\bresidential\b/i,
];

const clean = (v) => String(v ?? '').trim();

/** Normalización para comparar nombres y direcciones entre fuentes. */
export function normalizeForMatch(value) {
  return clean(value)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(inc|llc|l\.l\.c|corp|corporation|company|co|ltd|lp|the|and|de|del|la|el|dba)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/** ¿El nombre comercial es, en realidad, el nombre del titular? */
export function dbaIsOwnerName(dbaName, ownerName) {
  const dba = normalizeForMatch(dbaName);
  const owner = normalizeForMatch(ownerName);
  if (!dba || !owner) return false;
  if (dba === owner) return true;

  // "Ortega, Jose" vs "Jose Ortega": mismo conjunto de palabras.
  const words = (v) => clean(v).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z]+/).filter((w) => w.length > 1).sort().join(' ');
  return words(dbaName) === words(ownerName) && words(dbaName) !== '';
}

/** Sector NAICS a partir del código, con su etiqueta si está permitido. */
export function naicsSector(code) {
  const digits = clean(code).replace(/\D/g, '');
  if (digits.length < 2) return { sector: null, label: null, allowed: false };
  const sector = Number(digits.slice(0, 2));
  const label = CITY_NAICS_SECTORS[sector] || null;
  return { sector, label, allowed: Boolean(label) };
}

/** Segmento del ICP deducido del NAICS. Reglas explícitas, sin inferencia libre. */
export function segmentFromNaics(code) {
  const digits = clean(code).replace(/\D/g, '');
  const sector = Number(digits.slice(0, 2));
  if (digits.startsWith('7225') || digits.startsWith('7223')) return 'restaurants';
  if (sector === 72) return 'restaurants';
  if (sector === 62) return 'offices';
  if (sector === 54 || sector === 55) return 'offices';
  if (sector === 53) return 'property_managers';
  if (sector === 23) return 'post_construction';
  if (sector === 44 || sector === 45 || sector === 42) return 'retail';
  if (sector === 56 || sector === 71 || sector === 81) return 'offices';
  return null;
}

/**
 * ¿Esta fila es un negocio comercial que se puede demostrar?
 *
 * Devuelve `{ ok, reason, kind }`, con `kind` en:
 *   personal | inactive | residential | unverifiable
 * para que las métricas puedan contarlos por separado y alguien sepa, al mirar
 * un informe, si descartamos particulares o direcciones malas.
 *
 * `ownerName` llega aparte y a propósito: así se ve en la firma que es un
 * parámetro efímero y que no forma parte de la fila que seguirá viva.
 */
export function evaluateCityRow(row, ownerName, { now = Date.now() } = {}) {
  const val = (k) => clean(row?.[k]);

  // ── Certificado vigente ──
  if (val('account_status').toLowerCase() !== 'active') {
    return { ok: false, kind: 'inactive', reason: `account_status="${val('account_status') || '—'}"` };
  }
  const expiration = val('date_cert_expiration');
  if (expiration) {
    const until = Date.parse(expiration);
    if (!Number.isFinite(until)) {
      return { ok: false, kind: 'unverifiable', reason: 'date_cert_expiration ilegible' };
    }
    if (until < now) return { ok: false, kind: 'inactive', reason: 'certificado caducado' };
  }
  const effective = val('date_cert_effective');
  if (effective) {
    const from = Date.parse(effective);
    if (Number.isFinite(from) && from > now) {
      return { ok: false, kind: 'inactive', reason: 'certificado aún no vigente' };
    }
  }

  // ── Forma jurídica ──
  const entity = val('ownership_type').toUpperCase();
  if (!entity) return { ok: false, kind: 'unverifiable', reason: 'sin ownership_type' };
  if (CITY_ENTITY_REJECTED_PERSONAL.includes(entity)) {
    return { ok: false, kind: 'personal', reason: `ownership_type="${entity}" es una persona, no una entidad` };
  }
  if (!CITY_ENTITY_ALLOWED.includes(entity)) {
    return { ok: false, kind: 'unverifiable', reason: `ownership_type="${entity}" no está en la lista de entidades` };
  }

  // ── Nombre comercial ──
  const dba = val('dba_name');
  if (!dba) return { ok: false, kind: 'unverifiable', reason: 'sin dba_name' };
  if (ownerName && dbaIsOwnerName(dba, ownerName)) {
    return { ok: false, kind: 'personal', reason: 'el nombre comercial es el del titular' };
  }

  // ── NAICS ──
  const code = val('naics_code');
  if (!code) return { ok: false, kind: 'unverifiable', reason: 'sin naics_code' };
  if (CITY_NAICS_EXCLUDED.includes(code.replace(/\D/g, ''))) {
    return { ok: false, kind: 'residential', reason: `naics_code ${code} es actividad domiciliaria o personal` };
  }
  const sector = naicsSector(code);
  if (!sector.allowed) {
    return { ok: false, kind: 'unverifiable', reason: `sector NAICS ${sector.sector ?? '—'} fuera de la allowlist` };
  }
  const segment = segmentFromNaics(code);
  if (!segment) return { ok: false, kind: 'unverifiable', reason: `NAICS ${code} sin segmento asignable` };

  // ── Dirección comercial completa ──
  const road = val('address_road');
  const number = val('address_no');
  const city = val('address_city');
  const zip = val('address_zip').slice(0, 5);
  const missing = [];
  if (!number) missing.push('address_no');
  if (!road) missing.push('address_road');
  if (!city) missing.push('address_city');
  if (!/^\d{5}$/.test(zip)) missing.push('address_zip');
  if (missing.length) {
    return { ok: false, kind: 'unverifiable', reason: `dirección incompleta: faltan ${missing.join(', ')}` };
  }
  if (!/san\s*diego/i.test(city)) {
    return { ok: false, kind: 'unverifiable', reason: `address_city="${city}" fuera de San Diego` };
  }

  const full = [number, val('address_pd'), road, val('address_sfx')].filter(Boolean).join(' ');
  for (const re of NON_COMMERCIAL_ADDRESS) {
    if (re.test(full) || re.test(dba)) {
      return { ok: false, kind: 'residential', reason: 'la dirección o el nombre apuntan a un domicilio o a un buzón' };
    }
  }

  return {
    ok: true, kind: null, reason: null,
    segment,
    naicsSector: sector.sector,
    naicsSectorLabel: sector.label,
    entity,
    address: full,
    city,
    zip,
  };
}

export default evaluateCityRow;
