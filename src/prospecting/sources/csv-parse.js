/**
 * Parser CSV incremental, conforme a RFC 4180.
 *
 * Por qué no un `split(',')`: el CSV de la ciudad tiene nombres comerciales con
 * comas dentro de comillas, comillas escapadas duplicándolas y —comprobado en
 * datos reales de registros municipales— saltos de línea dentro de un campo
 * entrecomillado. Un split parte esas filas por la mitad y el resultado no es
 * un error visible: es una dirección pegada a un nombre, que entra en el CRM
 * como si fuera cierta.
 *
 * Es incremental porque el archivo pesa ~19 MB: se alimenta por trozos y va
 * entregando filas completas, sin tener que sostener el documento entero ni
 * cortar un campo al llegar al final de un trozo.
 *
 * Qué considera malformado, y lo dice en lugar de adivinar:
 *   · una comilla en medio de un campo sin entrecomillar;
 *   · texto después de la comilla de cierre;
 *   · un campo entrecomillado que nunca cierra (se detecta en `end()`);
 *   · un número de columnas distinto al del encabezado.
 */

export class CsvFormatError extends Error {
  constructor(message, { line } = {}) {
    super(message);
    this.name = 'CsvFormatError';
    this.line = line;
  }
}

const QUOTE = '"';

export class CsvParser {
  constructor({ maxFieldBytes = 1 << 20, maxColumns = 512 } = {}) {
    this.maxFieldBytes = maxFieldBytes;
    this.maxColumns = maxColumns;
    this.field = '';
    this.row = [];
    this.inQuotes = false;
    // Tras la comilla de cierre: solo valen coma, salto de línea o fin.
    this.afterQuote = false;
    this.line = 1;
    this.pendingCr = false;
  }

  /** Alimenta un trozo y devuelve las filas completas que haya salido. */
  push(chunk) {
    const rows = [];
    const text = String(chunk);

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      // Un \r\n puede llegar partido entre dos trozos.
      if (this.pendingCr) {
        this.pendingCr = false;
        if (ch === '\n') { rows.push(this.#endRow()); continue; }
        rows.push(this.#endRow());
        // y se sigue procesando `ch` normalmente
      }

      if (this.inQuotes) {
        if (ch === QUOTE) { this.inQuotes = false; this.afterQuote = true; continue; }
        this.#appendChar(ch);
        if (ch === '\n') this.line++;
        continue;
      }

      if (this.afterQuote) {
        this.afterQuote = false;
        if (ch === QUOTE) { this.#appendChar(QUOTE); this.inQuotes = true; continue; }
        if (ch === ',') { this.#endField(); continue; }
        if (ch === '\n') { rows.push(this.#endRow()); continue; }
        if (ch === '\r') { this.pendingCr = true; continue; }
        throw new CsvFormatError(
          `texto después de la comilla de cierre en la línea ${this.line}`,
          { line: this.line },
        );
      }

      if (ch === QUOTE) {
        if (this.field.length) {
          throw new CsvFormatError(
            `comilla en medio de un campo sin entrecomillar, línea ${this.line}`,
            { line: this.line },
          );
        }
        this.inQuotes = true;
        continue;
      }
      if (ch === ',') { this.#endField(); continue; }
      if (ch === '\n') { rows.push(this.#endRow()); continue; }
      if (ch === '\r') { this.pendingCr = true; continue; }
      this.#appendChar(ch);
    }
    return rows;
  }

  /** Cierra el documento. Devuelve la última fila si quedaba alguna abierta. */
  end() {
    if (this.inQuotes) {
      throw new CsvFormatError('el archivo acaba con un campo entrecomillado sin cerrar', { line: this.line });
    }
    if (this.pendingCr) { this.pendingCr = false; return [this.#endRow()]; }
    if (this.field.length || this.row.length) return [this.#endRow()];
    return [];
  }

  #appendChar(ch) {
    if (this.field.length >= this.maxFieldBytes) {
      throw new CsvFormatError(
        `un campo supera ${this.maxFieldBytes} bytes en la línea ${this.line}: el archivo no tiene la forma esperada`,
        { line: this.line },
      );
    }
    this.field += ch;
  }

  #endField() {
    if (this.row.length >= this.maxColumns) {
      throw new CsvFormatError(`más de ${this.maxColumns} columnas en la línea ${this.line}`, { line: this.line });
    }
    this.row.push(this.field);
    this.field = '';
  }

  #endRow() {
    this.#endField();
    const row = this.row;
    this.row = [];
    this.line++;
    return row;
  }
}

/**
 * Convierte filas de array a objeto usando el encabezado.
 *
 * Un recuento de columnas distinto al del encabezado NO se rellena ni se
 * recorta: se devuelve el error. Rellenar desplaza los valores una posición y
 * entonces la ciudad de una fila acaba en el campo del estado.
 */
export function rowToObject(header, row) {
  if (row.length !== header.length) {
    return { ok: false, reason: `la fila tiene ${row.length} columnas y el encabezado ${header.length}` };
  }
  const out = {};
  for (let i = 0; i < header.length; i++) out[header[i]] = row[i];
  return { ok: true, row: out };
}

/** Parseo completo de un texto. Para pruebas y archivos pequeños. */
export function parseCsv(text, { ...opts } = {}) {
  const parser = new CsvParser(opts);
  const rows = [...parser.push(text), ...parser.end()];
  // Una fila final vacía (el archivo acaba en salto de línea) no es una fila.
  if (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();
  return rows;
}

export default CsvParser;
