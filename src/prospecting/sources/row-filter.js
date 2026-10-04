import { allowedFields, forbiddenFields } from './compliance.js';

/**
 * Filtrado de filas antes de que toquen nada.
 *
 * Tres capas, y las tres son necesarias por motivos distintos:
 *
 *   1. El `$select` pide solo las columnas permitidas. El servidor no llega a
 *      enviar lo prohibido.
 *   2. Al parsear se vuelve a filtrar, porque un servidor puede devolver de
 *      más y porque un `$select` mal construido no debe ser la única barrera.
 *   3. Antes de `raw_json` se filtra otra vez, que es el último punto antes de
 *      que algo quede escrito en disco.
 *
 * La lista es cerrada: lo que no está explícitamente permitido se descarta,
 * incluidas las claves que el portal añada en el futuro sin avisar. Una
 * columna nueva llamada `owner_phone_2` no tendría que esperar a que alguien
 * la añadiera a la lista de prohibidos para quedarse fuera.
 */

/**
 * Señales de que una fila corresponde a un domicilio particular.
 *
 * Las cocinas domésticas (Microenterprise Home Kitchen Operations, la figura
 * de la ley californiana AB 626) operan desde la vivienda del titular. Su
 * dirección es un domicilio y su titular una persona física, así que la fila
 * entera se descarta: no se mapea, no se guarda y no se cuenta como prospecto.
 */
const RESIDENTIAL_PATTERNS = [
  /microenterprise\s+home\s+kitchen/i,
  /\bmhko\b/i,
  /home\s+kitchen/i,
  /cottage\s+food/i,
  /\bresidential\b/i,
  /\bresidence\b/i,
  /private\s+home/i,
];

/** Campos donde puede aparecer la pista de que es un domicilio. */
const RESIDENTIAL_SCAN_FIELDS = ['business_type', 'record_name', 'permit_status', 'address'];

/**
 * Patrones de nombre que delatan a una persona física en lugar de a un negocio.
 *
 * En los registros de permisos aparecen titulares individuales escritos como
 * "Apellido, Nombre" o con sufijos de persona. No se puede verificar que sean
 * un negocio real, así que se omiten: perder un candidato dudoso cuesta mucho
 * menos que meter a un particular en una lista de prospección.
 */
const PERSON_NAME_PATTERNS = [
  // "Ortega, José Ramón" — dos bloques separados por coma, sin palabra de
  // empresa. Es la forma en que los registros guardan a un titular individual.
  /^[\p{Lu}][\p{L}'’-]+\s*,\s*[\p{Lu}][\p{L}'’-]+(\s+[\p{Lu}][\p{L}'’-]+)?$/u,
  /\b(jr|sr|iii|iv)\.?$/i,
  /\bdba\s*:?\s*$/i,
];

/** Palabras que confirman que el nombre es de un negocio, no de alguien. */
const BUSINESS_NAME_HINTS = /\b(inc|llc|l\.l\.c|corp|co|company|ltd|group|holdings|enterprises|partners|restaurant|taqueria|taquería|cafe|café|coffee|market|deli|bakery|panaderia|panadería|pizza|grill|bar|kitchen|catering|caterer|foods?|services?|school|hospital|center|centre|store|shop|mart|liquor|hotel|motel|club|association|church|university|college|district|county|city)\b/i;

/**
 * ¿Se puede afirmar que esta fila describe un negocio real?
 *
 * No basta con que no sea residencial: hace falta nombre, dirección, ZIP y
 * tipo de establecimiento. Sin esos cuatro no hay a quién escribir ni cómo
 * comprobar que existe, y un prospecto a medias ensucia el CRM para siempre.
 */
export function businessEvidence(row) {
  const val = (k) => String(row?.[k] ?? '').trim();
  const name = val('record_name');
  const missing = [];
  if (!name) missing.push('record_name');
  if (!val('address')) missing.push('address');
  if (!/^\d{5}/.test(val('zip'))) missing.push('zip');
  if (!val('business_type')) missing.push('business_type');
  if (missing.length) return { ok: false, reason: `faltan ${missing.join(', ')}` };

  // Un nombre con forma de persona solo pasa si además trae una palabra que
  // lo identifique como negocio ("Ortega, José" no; "Ortega & Sons Inc" sí).
  if (PERSON_NAME_PATTERNS.some((re) => re.test(name)) && !BUSINESS_NAME_HINTS.test(name)) {
    return { ok: false, reason: 'el nombre parece de una persona, no de un negocio' };
  }
  return { ok: true, reason: null };
}

/**
 * ¿El permiso está activo según la política de la fuente?
 *
 * En el dataset del condado `active_permit` vale 'A' también en las 351 filas
 * expiradas, así que se exigen las dos condiciones. Sin política declarada se
 * devuelve `null`: no se inventa un criterio de actividad.
 */
export function isActiveRow(row, policy) {
  if (!policy) return { active: null, reason: 'sin_politica' };
  const val = (k) => String(row?.[k] ?? '').trim();

  if (policy.flagField) {
    const flag = val(policy.flagField);
    const ok = (policy.flagValues || []).some((v) => v.toLowerCase() === flag.toLowerCase());
    if (!ok) return { active: false, reason: `${policy.flagField}="${flag || '—'}"` };
  }
  if (policy.statusField) {
    const status = val(policy.statusField);
    const excluded = (policy.excludedStatuses || []).some((v) => v.toLowerCase() === status.toLowerCase());
    if (excluded) return { active: false, reason: `${policy.statusField}="${status}"` };
    const allowed = policy.allowedStatuses || [];
    if (allowed.length && !allowed.some((v) => v.toLowerCase() === status.toLowerCase())) {
      return { active: false, reason: `${policy.statusField}="${status || '—'}" no está en la lista de activos` };
    }
  }
  return { active: true, reason: null };
}

export function isResidentialRow(row) {
  if (!row || typeof row !== 'object') return false;
  for (const field of RESIDENTIAL_SCAN_FIELDS) {
    const value = row[field];
    if (value === undefined || value === null) continue;
    const text = String(value);
    if (RESIDENTIAL_PATTERNS.some((re) => re.test(text))) {
      return true;
    }
  }
  return false;
}

/**
 * Deja la fila con exactamente las claves permitidas por la auditoría.
 * Devuelve `null` si la fila debe descartarse entera.
 */
export function filterRow(sourceKey, row, { activePolicy = null } = {}) {
  if (!row || typeof row !== 'object') {
    return { row: null, reason: 'invalid' };
  }

  // El descarte por domicilio se evalúa ANTES de recortar campos: la pista
  // puede estar en una columna que luego no se conserva.
  if (isResidentialRow(row)) {
    return { row: null, reason: 'residential' };
  }

  // Igual con el permiso y con la evidencia de que es un negocio: las dos
  // comprobaciones miran columnas que el recorte podría no conservar.
  if (activePolicy) {
    const { active, reason } = isActiveRow(row, activePolicy);
    if (active === false) return { row: null, reason: 'inactive', detail: reason };
  }
  const evidence = businessEvidence(row);
  if (!evidence.ok) return { row: null, reason: 'unverifiable', detail: evidence.reason };

  const allowed = allowedFields(sourceKey);
  if (!allowed.length) {
    // Sin lista de permitidos no se deja pasar nada: una fuente sin auditar
    // no puede colar campos por omisión.
    return { row: null, reason: 'sin_allowlist' };
  }

  const allowedSet = new Set(allowed.map((f) => f.toLowerCase()));
  const forbiddenSet = new Set(forbiddenFields(sourceKey).map((f) => f.toLowerCase()));

  const out = {};
  const dropped = { forbidden: [], unknown: [] };
  for (const [key, value] of Object.entries(row)) {
    const lower = key.toLowerCase();
    if (forbiddenSet.has(lower)) { dropped.forbidden.push(key); continue; }
    if (!allowedSet.has(lower)) { dropped.unknown.push(key); continue; }
    out[key] = value;
  }

  if (!Object.keys(out).length) {
    return { row: null, reason: 'invalid', dropped };
  }
  return { row: out, reason: null, dropped };
}

/**
 * Comprueba que un objeto no contiene ni un campo prohibido, a cualquier
 * profundidad. Es la aserción que usan las pruebas y el punto de guardia antes
 * de escribir `raw_json`.
 */
export function assertNoForbidden(sourceKey, value, where = 'objeto') {
  const forbidden = forbiddenFields(sourceKey).map((f) => f.toLowerCase());
  if (!forbidden.length) return true;

  const visit = (node, trail) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((v, i) => visit(v, `${trail}[${i}]`)); return; }
    for (const [k, v] of Object.entries(node)) {
      if (forbidden.includes(k.toLowerCase())) {
        throw new Error(`Campo prohibido "${k}" presente en ${where} (${trail}.${k})`);
      }
      visit(v, `${trail}.${k}`);
    }
  };
  visit(value, where);
  return true;
}

export default filterRow;
