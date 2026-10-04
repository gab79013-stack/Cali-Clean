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
export function filterRow(sourceKey, row) {
  if (!row || typeof row !== 'object') {
    return { row: null, reason: 'invalid' };
  }

  // El descarte por domicilio se evalúa ANTES de recortar campos: la pista
  // puede estar en una columna que luego no se conserva.
  if (isResidentialRow(row)) {
    return { row: null, reason: 'residential' };
  }

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
