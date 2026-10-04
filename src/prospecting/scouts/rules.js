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

const AMBIGUOUS_RESIDENTIAL_ADDRESS = [
  /\bp\.?\s?o\.?\s*box\b/i,
  /\bpmb\b/i,
  /\bapt\b|\bapartment\s+\d/i,
  /\bunit\s*[0-9a-z]*\b/i,
  /\b#\s*\d+\b/,
  /\bspc\b|\bspace\b/i,
];

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

/** ¿Un ZIP cae en alguno de los rangos declarados del condado? */
export function zipInRanges(zip, ranges = []) {
  const n = Number(String(zip ?? '').slice(0, 5));
  if (!Number.isFinite(n)) return false;
  return ranges.some(([lo, hi]) => n >= lo && n <= hi);
}

export function evaluateHudRow(row, manifest, { cities, zips } = {}) {
  const val = (k) => clean(row?.[k]);
  const f = manifest.filters;
  // El ámbito sale del manifiesto, que está versionado y auditado. Los
  // parámetros solo sirven para que una prueba pueda acotarlo.
  const ciudadesOk = cities?.length ? cities : (f.cities || []);
  const rangos = f.zipRanges || [];

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
  const ciudadOk = ciudadesOk.some((c) => c.toLowerCase() === ciudad.toLowerCase());
  const zipOk = zips?.length ? zips.includes(zip) : zipInRanges(zip, rangos);
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

// ── 3. CaliClean Education & Childcare Facility Scout · CDE ──

/**
 * Marcadores que el volcado del directorio usa cuando una fila NO es un centro.
 *
 * El directorio incluye filas de distrito y de oficina de condado: no tienen
 * instalaciones propias y no son un cliente. Se reconocen por estos valores en el
 * nombre de la escuela, y una fila así se descarta.
 */
const CDE_NON_SCHOOL_MARKERS = [
  /^no\s*data$/i,
  /^no\s*school$/i,
  /^n\/?a$/i,
  /^none$/i,
  /^\s*$/,
];

/**
 * Tipos que son un DOMICILIO, no un centro.
 *
 * Están aquí porque el encargo lo pide explícitamente: si algún día se añade una
 * fuente de cuidado infantil, los Family Child Care Homes operan desde la
 * vivienda del titular. Quedan fuera por definición, igual que cualquier tipo
 * que no se pueda afirmar institucional.
 */
const CDE_HOME_BASED = [
  /family\s+child\s+care\s+home/i,
  /\bfcch\b/i,
  /child\s+care\s+home/i,
  /home[-\s]?based/i,
  /in[-\s]?home/i,
  /\bresiden(ce|tial)\b/i,
];

export function evaluateCdeRow(row, manifest) {
  const val = (k) => clean(row?.[k]);
  const f = manifest.filters;

  if (val('County').toLowerCase() !== String(f.county).toLowerCase()) {
    return { ok: false, kind: 'out_of_area', reason: `County="${val('County') || '—'}"` };
  }
  if (val('StatusType').toLowerCase() !== String(f.statusType).toLowerCase()) {
    return { ok: false, kind: 'inactive', reason: `StatusType="${val('StatusType') || '—'}"` };
  }

  // ── Tiene que ser un centro, no un distrito ──
  const escuela = val('School');
  if (f.requireSchoolRecord && CDE_NON_SCHOOL_MARKERS.some((re) => re.test(escuela))) {
    return { ok: false, kind: 'unverifiable', reason: 'la fila es de distrito u oficina, no de un centro' };
  }

  // ── Nada domiciliario, mire donde mire ──
  const paraDomicilio = [escuela, val('SOCType'), val('DOCType'), val('EILName'), val('Street')].join(' ');
  if (CDE_HOME_BASED.some((re) => re.test(paraDomicilio))) {
    return { ok: false, kind: 'residential', reason: 'el tipo o la dirección indican un domicilio' };
  }

  // ── Virtual: sin instalaciones que limpiar ──
  if (f.excludeVirtual && /^y(es)?$/i.test(val('Virtual'))) {
    return { ok: false, kind: 'unverifiable', reason: 'centro virtual: no hay instalaciones' };
  }

  // ── Dirección comercial completa ──
  const calle = val('Street');
  const ciudad = val('City');
  const zip = val('Zip').slice(0, 5);
  const faltan = [];
  if (!calle) faltan.push('Street');
  if (!ciudad) faltan.push('City');
  if (!/^\d{5}$/.test(zip)) faltan.push('Zip');
  if (f.requireBusinessAddress && faltan.length) {
    return { ok: false, kind: 'unverifiable', reason: `dirección incompleta: faltan ${faltan.join(', ')}` };
  }
  if (AMBIGUOUS_RESIDENTIAL_ADDRESS.some((re) => re.test(calle))) {
    return { ok: false, kind: 'residential', reason: 'la dirección señala una vivienda, no un centro' };
  }

  const cds = val('CDSCode');
  if (!cds) return { ok: false, kind: 'unverifiable', reason: 'sin CDSCode' };

  // El nombre de un centro educativo es institucional por naturaleza, pero se
  // comprueba igual: un volcado puede traer cualquier cosa en ese campo.
  const org = isOrganizationName(escuela);
  const esCentro = org.ok || /school|academy|elementary|middle|high|college|institute|center|centre|preschool|kinder|campus|charter|education/i.test(escuela);
  if (!esCentro) {
    return { ok: false, kind: 'personal', reason: `School: ${org.reason}` };
  }

  // El sitio oficial solo si viene de la fuente. No se adivina ni se construye.
  const web = val('Website');
  const website = /^https?:\/\//i.test(web) ? web : (web ? `https://${web.replace(/^\/+/, '')}` : null);

  return {
    ok: true, kind: null, reason: null,
    cdsCode: cds,
    businessName: escuela,
    district: val('District') || null,
    socType: val('SOCType') || null,
    docType: val('DOCType') || null,
    eilName: val('EILName') || null,
    charter: val('Charter') || null,
    gradesOffered: val('GSoffered') || null,
    openDate: val('OpenDate') || null,
    website,
    address: calle,
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

export default { evaluateCslbRow, evaluateHudRow, evaluateCdeRow };
