/**
 * Lectura de fuentes publicadas como CSV.
 *
 * Los Ángeles y San Francisco publican en Socrata, con API y filtros en el
 * servidor. San Diego publica ficheros CSV planos: no hay $where ni $order, así
 * que el filtrado y el orden se hacen aquí, después de descargar.
 */

/**
 * Parser de CSV con comillas, comas dentro de comillas y saltos de línea
 * dentro de campo. No usamos una librería porque el formato que hay que
 * soportar es exactamente este y cabe en cincuenta líneas.
 */
export function parseCsv(text, { maxRows = Infinity } = {}) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;

  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { row.push(field); rows.push(row); row = []; field = ''; };

  while (i < text.length) {
    const c = text[i];

    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }

    if (c === '"' && field === '') { quoted = true; i++; continue; }
    if (c === ',') { pushField(); i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') {
      pushRow(); i++;
      if (rows.length - 1 >= maxRows) break;
      continue;
    }
    field += c; i++;
  }
  if (field !== '' || row.length) pushRow();

  if (!rows.length) return [];
  const header = rows[0].map((h) => String(h || '').trim().toLowerCase().replace(/^﻿/, ''));
  return rows.slice(1)
    .filter((r) => r.length > 1)
    .map((r) => Object.fromEntries(header.map((h, idx) => [h, r[idx] ?? ''])));
}

/**
 * Toma el primer campo que exista de una lista de nombres posibles.
 *
 * Los portales renombran columnas entre versiones del dataset (`dba_name` pasa
 * a `business_name`, `address_zip` a `zip`). Declarar las variantes en vez de
 * una sola columna hace que la fuente sobreviva a ese cambio en lugar de
 * devolver filas vacías sin avisar.
 */
export function pick(row, names, fallback = '') {
  for (const name of names) {
    const v = row[name];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return fallback;
}

/** Fecha de una fila, tolerante al formato que use el portal. */
export function pickDate(row, names) {
  const raw = pick(row, names);
  if (!raw) return null;
  const d = new Date(raw.length <= 10 ? `${raw}T00:00:00Z` : raw);
  return Number.isNaN(d.getTime()) ? null : d;
}
