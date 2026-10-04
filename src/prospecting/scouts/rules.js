/**
 * Reglas de aceptación de los tres scouts, con el motivo de cada descarte.
 *
 * Todas devuelven `{ ok, reason, kind, ... }` con `kind` en un vocabulario
 * común, para que las métricas puedan contar rechazos por razón y alguien sepa,
 * al leer un informe, si descartamos particulares, instalaciones cerradas o
 * direcciones que no se pueden situar:
 *
 *   personal | inactive | residential | out_of_area | unverifiable
 *
 * La regla que gobierna las tres: si no se puede demostrar que la entidad es una
 * organización, se omite. En estos tres registros aparecen personas físicas
 * —un contratista autónomo, el titular de una propiedad, un profesional con
 * licencia— y un filtro laxo no produce leads mediocres: produce una lista de
 * particulares.
 */

import { normalizeForMatch } from '../sources/city-btc-rules.js';

const clean = (v) => String(v ?? '').trim();

/**
 * Señales de que un nombre es de una persona y no de una organización.
 *
 * La prueba no es "parece un nombre": es "no hay nada que lo identifique como
 * entidad". Un nombre con forma de persona que además dice `Inc` es una empresa
 * con el apellido de su fundador, y esa sí pasa.
 */
const PERSON_SHAPES = [
  // "Ortega, Jose Ramon" — apellido, nombre.
  /^[\p{Lu}][\p{L}'’-]+\s*,\s*[\p{Lu}][\p{L}'’-]+(\s+[\p{Lu}][\p{L}'’-]+)?$/u,
  // "Jose R Ortega" — nombre, inicial, apellido.
  /^[\p{Lu}][\p{L}'’-]+\s+[\p{Lu}]\.?\s+[\p{Lu}][\p{L}'’-]+$/u,
  /\b(jr|sr|iii|iv|md|dds|dmd|do|esq)\.?$/i,
];

const ENTITY_HINTS = /\b(inc|incorporated|llc|l\.l\.c|llp|lp|plc|pc|corp|corporation|co|company|ltd|limited|group|holdings?|enterprises?|partners?|associates?|services?|systems?|solutions?|properties|apartments?|villas?|manor|plaza|center|centre|centro|hospital|clinic|medical|health|care|hospice|surgery|laboratory|pharmacy|school|university|college|church|foundation|trust\s+co|authority|district|village|terrace|gardens?|towers?|commons|residences|housing|senior|living|construction|builders?|contracting|contractors?|electric|plumbing|roofing|mechanical|industries)\b/i;

/** ¿El nombre identifica a una organización de forma inequívoca? */
export function isOrganizationName(name) {
  const value = clean(name);
  if (!value) return { ok: false, reason: 'sin nombre' };
  if (ENTITY_HINTS.test(value)) return { ok: true, reason: null };
  if (PERSON_SHAPES.some((re) => re.test(value))) {
    return { ok: false, reason: 'el nombre tiene forma de persona y no dice ser una entidad' };
  }
  // Ni palabra de entidad ni forma de persona: no se puede afirmar. Se omite,
  // que es más barato que escribirle a alguien a su casa.
  return { ok: false, reason: 'el nombre no identifica una organización de forma inequívoca' };
}

// ── 1. CaliClean State License Scout · CSLB ──────────────────

/**
 * ¿`Classifications(s)` contiene la clase pedida como token exacto?
 *
 * El guion NO separa: las clases de CSLB son códigos con guion y son clases
 * distintas. `B` es General Building y `B-2` es Residential Remodeling, que es
 * otra cosa y además apunta a vivienda. Partir por cualquier carácter no
 * alfanumérico convertía "B-2" en ["B","2"] y aceptaba como clase B a un
 * contratista que no la tiene.
 *
 * Se separa solo por los delimitadores que el campo usa de verdad —coma, punto y
 * coma, barra vertical y espacios— y se compara el token entero.
 */
export function hasClassification(field, wanted) {
  const tokens = clean(field).split(/[,;|\s]+/).filter(Boolean);
  const buscado = String(wanted).toUpperCase();
  return tokens.some((t) => t.toUpperCase() === buscado);
}

export function evaluateCslbRow(row, manifest) {
  const val = (k) => clean(row?.[k]);
  const f = manifest.filters;

  if (val('County').toLowerCase() !== String(f.county).toLowerCase()) {
    return { ok: false, kind: 'out_of_area', reason: `County="${val('County') || '—'}"` };
  }
  if (val('PrimaryStatus').toUpperCase() !== String(f.primaryStatus).toUpperCase()) {
    return { ok: false, kind: 'inactive', reason: `PrimaryStatus="${val('PrimaryStatus') || '—'}"` };
  }
  const tipo = val('BusinessType');
  if (!f.businessTypeAllowed.some((t) => t.toLowerCase() === tipo.toLowerCase())) {
    // Una forma jurídica que no se reconoce se descarta: admitir variantes sin
    // documentarlas es cómo entra un "Sole Owner" en una lista de empresas.
    return { ok: false, kind: 'personal', reason: `BusinessType="${tipo || '—'}" no está en la lista de entidades` };
  }
  if (!hasClassification(row?.['Classifications(s)'], f.classificationRequired)) {
    return {
      ok: false,
      kind: 'unverifiable',
      reason: `sin la clase ${f.classificationRequired} como token exacto`,
    };
  }

  const licencia = val('LicenseNo');
  if (!licencia) return { ok: false, kind: 'unverifiable', reason: 'sin LicenseNo' };

  // El nombre comercial completo es preferible al corto, pero ninguno de los dos
  // puede ser una persona.
  const nombre = val('FullBusinessName') || val('BusinessName');
  const org = isOrganizationName(nombre);
  if (!org.ok) return { ok: false, kind: 'personal', reason: org.reason };

  return {
    ok: true, kind: null, reason: null,
    licenseNo: licencia,
    businessName: nombre,
    businessType: tipo,
    primaryStatus: val('PrimaryStatus'),
    secondaryStatus: val('SecondaryStatus') || null,
    classifications: clean(row?.['Classifications(s)']),
    lastUpdate: val('LastUpdate') || null,
  };
}

// ── 2. CaliClean Property & Manager Scout · HUD ──────────────

const NON_INSTITUTIONAL_CATEGORY = /single\s*family|vacant|land|mobile\s*home|duplex|triplex/i;
const AMBIGUOUS_RESIDENTIAL_ADDRESS = [
  /\bp\.?\s?o\.?\s*box\b/i,
  /\bpmb\b/i,
  /\bapt\b|\bapartment\s+\d/i,
  /\bunit\s*[0-9a-z]*\b/i,
  /\b#\s*\d+\b/,
  /\bspc\b|\bspace\b/i,
];

export function evaluateHudRow(row, manifest, { cities, zips } = {}) {
  const val = (k) => clean(row?.[k]);
  const f = manifest.filters;

  if (val('STD_ST').toUpperCase() !== String(f.state).toUpperCase()) {
    return { ok: false, kind: 'out_of_area', reason: `STD_ST="${val('STD_ST') || '—'}"` };
  }

  const unidades = Number(val('TOTAL_UNIT_COUNT'));
  if (!Number.isFinite(unidades)) {
    return { ok: false, kind: 'unverifiable', reason: 'TOTAL_UNIT_COUNT ilegible' };
  }
  if (unidades < f.minUnits) {
    // Menos de cinco unidades no es una propiedad institucional: es una casa o
    // un dúplex, y detrás hay un particular.
    return { ok: false, kind: 'residential', reason: `${unidades} unidades, menos de ${f.minUnits}` };
  }

  const categoria = val('PROPERTY_CATEGORY_NAME');
  if (NON_INSTITUTIONAL_CATEGORY.test(categoria)) {
    return { ok: false, kind: 'residential', reason: `categoría "${categoria}"` };
  }

  const ciudad = val('STD_CITY');
  const zip = val('STD_ZIP5').slice(0, 5);
  const ciudadOk = (cities || []).some((c) => c.toLowerCase() === ciudad.toLowerCase());
  const zipOk = (zips || []).includes(zip);
  if (!ciudadOk && !zipOk) {
    // El condado no viene en la allowlist de campos, así que el ámbito se
    // comprueba contra listas explícitas de ciudades y ZIP validados. Sin una de
    // las dos no se puede afirmar que esté en el condado.
    return { ok: false, kind: 'out_of_area', reason: `${ciudad || '—'} ${zip || '—'} fuera del ámbito validado` };
  }

  const direccion = val('STD_ADDR');
  if (!direccion || !ciudad || !/^\d{5}$/.test(zip)) {
    return { ok: false, kind: 'unverifiable', reason: 'dirección de la propiedad incompleta' };
  }
  if (AMBIGUOUS_RESIDENTIAL_ADDRESS.some((re) => re.test(direccion))) {
    return { ok: false, kind: 'residential', reason: 'la dirección señala una vivienda concreta, no la propiedad' };
  }

  const propiedadId = val('PROPERTY_ID');
  if (!propiedadId) return { ok: false, kind: 'unverifiable', reason: 'sin PROPERTY_ID' };

  // La Company representa la PROPIEDAD, no a quien la gestiona.
  const nombre = val('PROPERTY_NAME_TEXT');
  const org = isOrganizationName(nombre);
  if (!org.ok) {
    return { ok: false, kind: 'personal', reason: `PROPERTY_NAME_TEXT: ${org.reason}` };
  }

  // El gestor solo sobrevive si es una entidad inequívoca. Y aun así no se
  // escribe en ningún sitio: no hay campo seguro en el CRM para un gestor, y
  // añadirlo sería cambiar el esquema del cliente. Se conserva en el staging
  // para que una decisión futura lo tenga, marcado como no escribible.
  const gestor = val('MGMT_AGENT_ORG_NAME');
  const gestorOk = gestor ? isOrganizationName(gestor).ok : false;

  return {
    ok: true, kind: null, reason: null,
    propertyId: propiedadId,
    businessName: nombre,
    units: unidades,
    category: categoria || null,
    address: direccion,
    city: ciudad,
    zip,
    managementAgent: gestorOk ? gestor : null,
    managementAgentWritable: false,
  };
}

// ── 3. CaliClean Commercial Facility Scout · HCAI ────────────

export function evaluateHcaiRow(row, manifest) {
  const val = (k) => clean(row?.[k]);
  const f = manifest.filters;

  if (val('COUNTY_NAME').toLowerCase() !== String(f.county).toLowerCase()) {
    return { ok: false, kind: 'out_of_area', reason: `COUNTY_NAME="${val('COUNTY_NAME') || '—'}"` };
  }
  if (val('FACILITY_STATUS_DESC').toLowerCase() !== String(f.facilityStatus).toLowerCase()) {
    return { ok: false, kind: 'inactive', reason: `FACILITY_STATUS_DESC="${val('FACILITY_STATUS_DESC') || '—'}"` };
  }

  const nivel = val('FACILITY_LEVEL_DESC');
  if (!f.facilityLevelAllowed.some((n) => n.toLowerCase() === nivel.toLowerCase())) {
    // Un nivel que no se reconoce se descarta. Admitir "otra categoría
    // institucional" exige documentarla y traer un fixture primero.
    return { ok: false, kind: 'unverifiable', reason: `FACILITY_LEVEL_DESC="${nivel || '—'}" no está en la lista` };
  }

  if (f.requireLicense && !val('LICENSE_NUM')) {
    return { ok: false, kind: 'unverifiable', reason: 'sin LICENSE_NUM' };
  }

  const direccion = val('DBA_ADDRESS1');
  const ciudad = val('DBA_CITY');
  const zip = val('DBA_ZIP_CODE').slice(0, 5);
  if (f.requireBusinessAddress && (!direccion || !ciudad || !/^\d{5}$/.test(zip))) {
    return { ok: false, kind: 'unverifiable', reason: 'dirección de la instalación incompleta' };
  }
  if (AMBIGUOUS_RESIDENTIAL_ADDRESS.some((re) => re.test(direccion))) {
    return { ok: false, kind: 'residential', reason: 'la dirección señala una vivienda, no una instalación' };
  }

  const oshpd = val('OSHPD_ID');
  if (!oshpd) return { ok: false, kind: 'unverifiable', reason: 'sin OSHPD_ID' };

  const nombre = val('FACILITY_NAME');
  const org = isOrganizationName(nombre);
  if (!org.ok) return { ok: false, kind: 'personal', reason: `FACILITY_NAME: ${org.reason}` };

  return {
    ok: true, kind: null, reason: null,
    oshpdId: oshpd,
    businessName: nombre,
    licenseNum: val('LICENSE_NUM'),
    facilityLevel: nivel,
    licenseType: val('LICENSE_TYPE_DESC') || null,
    licenseCategory: val('LICENSE_CATEGORY_DESC') || null,
    address: direccion,
    city: ciudad,
    zip,
  };
}

/** Clave de comparación cruzada: nombre + calle, normalizados. */
export function crossKey(name, street) {
  const n = normalizeForMatch(name);
  if (!n) return null;
  return `${n}|${normalizeForMatch(street)}`;
}

/** Solo el nombre, para cuando una fuente no conserva dirección (CSLB). */
export function nameKey(name) {
  const n = normalizeForMatch(name);
  return n || null;
}

export default { evaluateCslbRow, evaluateHudRow, evaluateHcaiRow };
