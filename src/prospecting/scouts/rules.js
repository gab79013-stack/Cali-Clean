/**
 * Reglas de aceptación de los scouts, con el motivo de cada descarte.
 *
 * Todas devuelven `{ ok, reason, kind, ... }` con `kind` en un vocabulario
 * común, para que las métricas puedan contar rechazos por razón y alguien sepa,
 * al leer un informe, si descartamos particulares, instalaciones cerradas o
 * direcciones que no se pueden situar:
 *
 *   personal | inactive | residential | out_of_area | unverifiable
 *
 * La regla que las gobierna todas: si no se puede demostrar que la entidad es una
 * organización, se omite. En estos registros aparecen personas físicas —el
 * titular de una propiedad, el contacto de un permiso— y un filtro laxo no
 * produce leads mediocres: produce una lista de particulares.
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

// ── 1. CaliClean Property & Manager Scout · HUD ──────────────

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

// ── 2. CaliClean Education & Childcare Facility Scout · CDE ──

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

// ── 3. CaliClean Commercial Development Permit Scout · City ──
//
// Esta fuente es la más peligrosa de las tres, y conviene decir por qué antes de
// leer la regla. El diccionario oficial define `approval_permit_holder` como
// "Contact name whom the Approval is issued to": un nombre de CONTACTO. En la
// muestra real aparecen personas físicas tal cual, y hasta listas de personas.
// Así que aquí no basta con que un nombre no parezca una persona: hace falta una
// señal POSITIVA de que es una entidad. Lo demás se descarta.

/** Sufijo de forma jurídica al final del nombre. La señal más fuerte que hay. */
const LEGAL_SUFFIX = /[\s,.](l\.?l\.?c|l\.?l\.?p|l\.?p|p\.?c|p\.?l\.?l\.?c|inc|incorporated|corp|corporation|co|company|ltd|limited|partnership)\.?$/i;

/**
 * Designadores de actividad empresarial. Son nivel 2: valen solo si el nombre no
 * tiene además forma de persona, porque "Architect MD Lyon, Sara Hoffelt" trae
 * una palabra de oficio y sigue siendo un par de personas.
 */
const BUSINESS_ACTIVITY = /\b(construction|contracting|contractors?|builders?|building|development|developers?|properties|realty|group|enterprises?|industries|services|systems|solutions|electric(al)?|plumbing|roofing|mechanical|hvac|engineering|architects|interiors|restaurant|hospitality|brewing|coffee|market|retail|hotel|motel|clinic|dental|medical|laboratories|logistics|storage|automotive|manufacturing)\b/i;

/** Marcadores residenciales, en cualquier campo que los pueda delatar. */
const CITY_DEV_RESIDENTIAL = [
  /\bresidential?\b/i,
  /\bsingle[-\s]?family\b/i,
  /\bmulti[-\s]?family\b/i,
  /\bduplex\b|\btriplex\b/i,
  /\bapartments?\b/i,
  /\bcondo(minium)?s?\b/i,
  /\btownhomes?\b|\btownhouses?\b/i,
  /\bdwelling\b/i,
  /\bsdu\b/i,
  /\badu\b/i,
  /\bjadu\b/i,
  /\bcompanion\s+unit\b/i,
  /\baccessory\s+(dwelling|apt)\b/i,
];

/** Un rótulo no es una obra que haya que limpiar. */
const SIGN_MARKERS = [/\bsigns?\s*-\s*(permanent|temporary)\b/i, /\bsign\s+p(er)?mt\b/i];

/**
 * ¿El titular del permiso es inequívocamente una empresa?
 *
 * Devuelve el NIVEL que lo aceptó, porque la procedencia tiene que poder decir
 * con qué regla entró cada Company. "Lo aceptó una heurística" no es auditable;
 * "nivel 1, sufijo legal" sí.
 */
/** ¿Este trozo de nombre es, por sí solo, el nombre de una persona? */
const PARECE_PERSONA = (trozo) => {
  const t = trozo.trim().replace(/[.,]+$/, '');
  if (!t) return false;
  if (PERSON_SHAPES.some((re) => re.test(t))) return true;
  // "Nombre Apellido" pelado, sin nada que lo convierta en empresa.
  return /^[\p{Lu}][\p{L}'’-]+\s+[\p{Lu}][\p{L}'’-]+$/u.test(t) && !BUSINESS_ACTIVITY.test(t);
};

export function corporateHolder(name) {
  const value = clean(name);
  if (!value) return { ok: false, tier: null, reason: 'sin titular' };

  // ── Compuestos "persona + empresa" ──
  //
  // Esta comprobación está aquí porque la primera versión de la regla no la hacía
  // y la preview real lo demostró: entre 50 candidatos aceptados había tres con
  // una persona dentro del nombre, en las tres formas que usa este registro —
  // "Persona - Empresa", "Empresa / Persona" y "Persona/Empresa". Tenían sufijo
  // legal o palabra de actividad, así que pasaban, y habrían metido el nombre de
  // alguien en el CRM como si fuera el de una empresa. Si CUALQUIER trozo es una
  // persona, se rechaza el titular entero: un compuesto así no es inequívoco.
  const trozos = value.split(/\s*[/|]\s*|\s+-\s+|\s*\b(?:and|&)\b\s*/i).filter(Boolean);
  if (trozos.length > 1 && trozos.some(PARECE_PERSONA)) {
    return { ok: false, tier: null, reason: 'el titular mezcla el nombre de una persona con el de una empresa' };
  }

  const limpio = value.replace(/[.,\s]+$/, '');
  if (PARECE_PERSONA(limpio)) {
    return { ok: false, tier: null, reason: 'el titular tiene forma de nombre de persona' };
  }
  if (LEGAL_SUFFIX.test(limpio)) return { ok: true, tier: 1, reason: null };
  if (PERSON_SHAPES.some((re) => re.test(limpio))) {
    return { ok: false, tier: null, reason: 'el titular tiene forma de nombre de persona' };
  }
  if (BUSINESS_ACTIVITY.test(limpio)) return { ok: true, tier: 2, reason: null };
  return { ok: false, tier: null, reason: 'el titular no se puede afirmar empresa sin ambigüedad' };
}

/**
 * Una aprobación emitida se acepta solo si las seis cosas se cumplen: estado
 * emitido, emisión reciente, clasificación de edificación comercial explícita,
 * dirección completa, identificador, y titular empresarial.
 *
 * Ningún `reason` lleva el valor de la fila dentro: una fila rechazada no se
 * registra, y un motivo que cite el nombre del titular sería registrarla.
 */
export function evaluateCityDevRow(row, manifest, { now = Date.now() } = {}) {
  const val = (k) => clean(row?.[k]);
  const f = manifest.filters;

  if (val('APPROVAL_STATUS') !== f.approvalStatus) {
    return { ok: false, kind: 'inactive', reason: `estado "${val('APPROVAL_STATUS') || '—'}", no "${f.approvalStatus}"` };
  }

  const emitida = val('APPROVAL_ISSUE_DATE').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(emitida)) {
    return { ok: false, kind: 'unverifiable', reason: 'sin fecha de emisión legible' };
  }
  const ms = Date.parse(`${emitida}T00:00:00Z`);
  if (!Number.isFinite(ms)) return { ok: false, kind: 'unverifiable', reason: 'fecha de emisión inválida' };
  const dias = Math.floor((now - ms) / 86400000);
  if (dias > f.issuedWithinDays) {
    return { ok: false, kind: 'stale', reason: `emitida hace ${dias} días (ventana: ${f.issuedWithinDays})` };
  }
  if (dias < 0) {
    return { ok: false, kind: 'unverifiable', reason: 'fecha de emisión en el futuro' };
  }

  const aprobacion = val('APPROVAL_ID');
  if (!aprobacion) return { ok: false, kind: 'unverifiable', reason: 'sin APPROVAL_ID' };

  // ── Señal comercial: de la clasificación del propio permiso ──
  const bc = val('JOB_BC_CODE_DESCRIPTION');
  if (!bc) {
    return { ok: false, kind: 'unverifiable', reason: 'sin clasificación de edificación: no hay señal comercial' };
  }
  if ((f.ambiguousBcCodes || []).includes(bc)) {
    return { ok: false, kind: 'mixed_use_ambiguous', reason: 'la clasificación no distingue residencial de comercial' };
  }
  if (f.excludeSignPermits && SIGN_MARKERS.some((re) => re.test(bc) || re.test(val('APPROVAL_TYPE')))) {
    return { ok: false, kind: 'not_relevant', reason: 'permiso de rótulo: no es obra que haya que limpiar' };
  }
  if (!(f.commercialBcCodes || []).includes(bc)) {
    return { ok: false, kind: 'not_commercial', reason: 'la clasificación de edificación no está en la lista comercial' };
  }

  // ── Nada residencial, mire donde mire ──
  const paraResidencial = [bc, val('APPROVAL_SCOPE'), val('PROJECT_SCOPE'),
    val('PROJECT_TITLE'), val('PROJECT_TYPE'), val('APPROVAL_TYPE')].join(' ');
  if (CITY_DEV_RESIDENTIAL.some((re) => re.test(paraResidencial))) {
    return { ok: false, kind: 'residential', reason: 'el alcance o el tipo señalan uso residencial' };
  }

  // ── Dirección: solo después de la señal comercial ──
  const direccion = val('GIS_ADDRESS');
  if (!direccion) return { ok: false, kind: 'unverifiable', reason: 'sin GIS_ADDRESS' };
  if (/\[pending\]/i.test(direccion)) {
    return { ok: false, kind: 'unverifiable', reason: 'la dirección está marcada [Pending]: aún no está asignada' };
  }
  if (AMBIGUOUS_RESIDENTIAL_ADDRESS.some((re) => re.test(direccion))) {
    return { ok: false, kind: 'residential', reason: 'la dirección señala una vivienda concreta' };
  }

  // ── Titular: señal positiva de entidad, o nada ──
  const titular = corporateHolder(row?.APPROVAL_PERMIT_HOLDER);
  if (!titular.ok) return { ok: false, kind: 'personal', reason: `titular: ${titular.reason}` };

  const valoracion = Number(String(val('APPROVAL_VALUATION')).replace(/[^0-9.]/g, ''));

  return {
    ok: true, kind: null, reason: null,
    approvalId: aprobacion,
    businessName: clean(row?.APPROVAL_PERMIT_HOLDER).replace(/[.,\s]+$/, ''),
    holderTier: titular.tier,
    address: direccion,
    issueDate: emitida,
    issuedDaysAgo: dias,
    approvalType: val('APPROVAL_TYPE') || null,
    buildingClass: bc,
    buildingClassCode: val('JOB_BC_CODE') || null,
    projectId: val('PROJECT_ID') || null,
    projectType: val('PROJECT_TYPE') || null,
    valuation: Number.isFinite(valoracion) && valoracion > 0 ? valoracion : null,
  };
}

// ── 4. CaliClean ABC Active License Scout · California ABC ───
//
// Aquí la Company es el NEGOCIO con premisa, no el titular de la licencia. La
// distinción importa porque `Primary Name` es el titular y puede ser una persona
// física: en este registro conviven "J DUSI INC" y el nombre y apellido de quien
// tiene la licencia a su nombre. El `DBA Name` —el nombre comercial— es el que
// describe el establecimiento, así que se prefiere, y el titular solo se usa
// cuando es inequívocamente una entidad.

/** Una dirección que no es una premisa física donde haya algo que limpiar. */
const ABC_NON_PREMISE = [
  /\bp\.?\s?o\.?\s*box\b/i,
  /\bpost\s+office\s+box\b/i,
  /\bpmb\b/i,
  /^\s*(?:none|n\/?a|unknown|same)\s*$/i,
];

/** Marcadores de vivienda en una dirección de premisa. */
const ABC_RESIDENTIAL = [
  /\bapt\b|\bapartment\s+\d/i,
  /\bresiden(ce|tial)\b/i,
  /\bmobile\s*home\b/i,
  /\btrailer\b/i,
];

/**
 * ¿Este nombre sirve como nombre de empresa?
 *
 * Mismo criterio que el de los permisos de desarrollo y por la misma razón: hace
 * falta una señal POSITIVA de entidad, porque la ausencia de forma de persona no
 * basta cuando el campo admite personas. Devuelve el nivel que lo aceptó para que
 * la procedencia pueda decir con qué regla entró cada Company.
 */
export function abcBusinessName(dba, primary) {
  const comercial = clean(dba);
  const titular = clean(primary);

  // 1. El nombre comercial, si existe y no es el nombre de alguien.
  if (comercial) {
    const c = comercial.replace(/[.,\s]+$/, '');
    if (!PERSON_SHAPES.some((re) => re.test(c))
      && !(/^[\p{Lu}][\p{L}'’-]+\s+[\p{Lu}][\p{L}'’-]+$/u.test(c) && !BUSINESS_ACTIVITY.test(c) && !ENTITY_HINTS.test(c))) {
      return { ok: true, name: c, rule: 'nombre comercial (DBA)', tier: 'dba' };
    }
    // Un DBA con forma de persona no descalifica la fila: puede haber un titular
    // que sí sea una entidad. Se sigue mirando.
  }

  // 2. El titular, solo si es una entidad inequívoca.
  if (titular) {
    const t = titular.replace(/[.,\s]+$/, '');
    const compuesto = t.split(/\s*[/|]\s*|\s+-\s+|\s*\b(?:and|&)\b\s*/i).filter(Boolean);
    const parecePersona = (x) => {
      const y = x.trim().replace(/[.,]+$/, '');
      if (!y) return false;
      if (PERSON_SHAPES.some((re) => re.test(y))) return true;
      return /^[\p{Lu}][\p{L}'’-]+\s+[\p{Lu}][\p{L}'’-]+$/u.test(y) && !BUSINESS_ACTIVITY.test(y) && !ENTITY_HINTS.test(y);
    };
    if (compuesto.length > 1 && compuesto.some(parecePersona)) {
      return { ok: false, reason: 'el titular mezcla el nombre de una persona con el de una empresa' };
    }
    if (!parecePersona(t) && ENTITY_HINTS.test(t)) {
      return { ok: true, name: t, rule: 'razón social del titular, con marca de entidad', tier: 'entity' };
    }
    if (parecePersona(t)) {
      return { ok: false, reason: 'el titular es una persona física' };
    }
  }

  return { ok: false, reason: 'ni el nombre comercial ni el del titular se pueden afirmar empresa' };
}

/**
 * Una licencia de ABC se acepta solo si las seis cosas se cumplen: condado,
 * estado activo, tipo de licencia con premisa fija, dirección de premisa real,
 * número de expediente y nombre de negocio defendible.
 *
 * Ningún `reason` lleva el valor de la fila dentro.
 */
export function evaluateAbcRow(row, manifest) {
  const val = (k) => clean(row?.[k]);
  const f = manifest.filters;

  if (val('Prem County').toUpperCase() !== String(f.county).toUpperCase()) {
    return { ok: false, kind: 'out_of_area', reason: `condado "${val('Prem County') || '—'}"` };
  }
  if (f.premiseState && val('Prem State').toUpperCase() !== String(f.premiseState).toUpperCase()) {
    return { ok: false, kind: 'out_of_area', reason: `estado de la premisa "${val('Prem State') || '—'}"` };
  }
  if (val('Type Status').toUpperCase() !== String(f.typeStatus).toUpperCase()) {
    return { ok: false, kind: 'inactive', reason: `estado "${val('Type Status') || '—'}", no "${f.typeStatus}"` };
  }

  // ── Tipo de licencia: premisa fija y relevante ──
  const tipo = val('License Type').padStart(2, '0');
  const descripcion = f.licenseTypesAllowed?.[tipo];
  if (!descripcion) {
    return { ok: false, kind: 'not_relevant', reason: `tipo de licencia ${tipo || '—'} sin premisa fija relevante` };
  }

  const expediente = val('File Number');
  if (!expediente) return { ok: false, kind: 'unverifiable', reason: 'sin File Number' };

  // ── Dirección de la premisa, nunca la postal ──
  const calle = [val('Prem Addr 1'), val('Prem Addr 2')].filter(Boolean).join(' ').trim();
  const ciudad = val('Prem City');
  const zip = val('Prem Zip').slice(0, 5);
  if (f.requirePremiseAddress && (!calle || !ciudad || !/^\d{5}$/.test(zip))) {
    return { ok: false, kind: 'unverifiable', reason: 'dirección de la premisa incompleta' };
  }
  if (f.excludePoBoxPremise && ABC_NON_PREMISE.some((re) => re.test(calle))) {
    return { ok: false, kind: 'unverifiable', reason: 'la premisa no es una dirección física' };
  }
  if (ABC_RESIDENTIAL.some((re) => re.test(calle))) {
    return { ok: false, kind: 'residential', reason: 'la dirección de la premisa señala una vivienda' };
  }

  // ── Nombre de negocio ──
  const nombre = abcBusinessName(row?.['DBA Name'], row?.['Primary Name']);
  if (!nombre.ok) return { ok: false, kind: 'personal', reason: `nombre: ${nombre.reason}` };

  return {
    ok: true, kind: null, reason: null,
    fileNumber: expediente,
    businessName: nombre.name,
    nameRule: nombre.rule,
    nameTier: nombre.tier,
    licenseType: tipo,
    licenseTypeName: descripcion,
    typeStatus: val('Type Status').toUpperCase(),
    issueDate: /^\s*$/.test(val('Type Orig Iss Date')) ? null : val('Type Orig Iss Date'),
    expirationDate: /^\s*$/.test(val('Expir Date')) ? null : val('Expir Date'),
    address: calle,
    city: ciudad,
    zip,
    county: val('Prem County'),
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

export default { evaluateHudRow, evaluateCdeRow, evaluateCityDevRow, evaluateAbcRow };
