import http from 'node:http';
import crypto from 'node:crypto';

/**
 * CSV municipal simulado, con el encabezado real de 27 columnas verificado el
 * 2026-10-04 y filas que reproducen los casos que de verdad aparecen.
 *
 * El servidor es deliberadamente hostil en los aspectos que importan:
 *   · devuelve TODAS las columnas, incluidas las prohibidas y la del titular;
 *   · soporta ETag / If-None-Match y Last-Modified / If-Modified-Since con 304;
 *   · puede cortar la respuesta a medias o servir más bytes de los anunciados.
 */

export const CITY_HEADER = [
  'account_key', 'account_status', 'date_account_creation', 'date_cert_expiration',
  'date_cert_effective', 'business_owner_name', 'ownership_type', 'date_business_start',
  'dba_name', 'naics_sector', 'naics_code', 'naics_description', 'address_no', 'address_pd',
  'address_road', 'address_sfx', 'address_no_fraction', 'address_city', 'address_state',
  'address_zip', 'address_suite', 'address_pmb_box', 'address_po_box', 'bid',
  'council_district', 'lat', 'lng',
];

/** Valores personales que no pueden sobrevivir a ninguna capa. */
export const CITY_DATOS_PROHIBIDOS = [
  'Fernandez, Ana Lucia', 'Okafor Daniel', 'Vega Marisol', 'Salazar, Ramon',
  'Ruiz, Dana', 'Chen, Wei', 'Nguyen, Minh', 'Patel, Asha',
  '32.7157', '-117.1611', '32.8899', 'PMB 440', 'PO BOX 9912', 'Apt 7B',
  'business_owner_name', 'address_pmb_box', 'address_po_box', 'lat', 'lng',
];

const campo = (v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Construye una fila a partir de un objeto parcial. */
export function cityRow(partial) {
  const base = {
    account_key: '', account_status: 'Active', date_account_creation: '2026-01-15',
    date_cert_expiration: '2027-01-14', date_cert_effective: '2026-01-15',
    business_owner_name: '', ownership_type: 'LLC', date_business_start: '2026-01-10',
    dba_name: '', naics_sector: '72', naics_code: '722511',
    naics_description: 'Full-service restaurants', address_no: '1450', address_pd: '',
    address_road: 'Harbor', address_sfx: 'Dr', address_no_fraction: '',
    address_city: 'San Diego', address_state: 'CA', address_zip: '92101',
    address_suite: '', address_pmb_box: '', address_po_box: '', bid: 'Downtown',
    council_district: '3', lat: '32.7157', lng: '-117.1611',
  };
  return { ...base, ...partial };
}

/** Las filas del fixture, cada una con el caso que cubre. */
export const CITY_ROWS = [
  // ── Válidas ──
  cityRow({
    account_key: 'B2026-001', dba_name: 'Bahía Taquería', ownership_type: 'LLC',
    business_owner_name: 'Fernandez, Ana Lucia', naics_code: '722511',
  }),
  cityRow({
    // Nombre con coma y comillas dentro: el parser tiene que aguantarlo.
    account_key: 'B2026-002', dba_name: 'Gaslamp Coffee, "The Original"',
    ownership_type: 'CORP', business_owner_name: 'Okafor Daniel',
    naics_code: '722515', naics_description: 'Snack and nonalcoholic beverage bars',
    address_no: '620', address_road: 'Fifth', address_sfx: 'Ave', address_zip: '92101',
  }),
  cityRow({
    // Salto de línea dentro de un campo entrecomillado.
    account_key: 'B2026-003', dba_name: 'Harbor View\nDental Group',
    ownership_type: 'PRF', business_owner_name: 'Chen, Wei',
    naics_sector: '62', naics_code: '621210', naics_description: 'Offices of dentists',
    address_no: '1200', address_road: 'Harbor', address_sfx: 'Blvd', address_zip: '92103',
  }),
  cityRow({
    account_key: 'B2026-004', dba_name: 'Pacific Property Partners LP',
    ownership_type: 'LP', business_owner_name: 'Patel, Asha',
    naics_sector: '53', naics_code: '531312', naics_description: 'Nonresidential property managers',
    address_no: '88', address_road: 'Broadway', address_sfx: '', address_zip: '92101',
  }),

  // ── Personales: fuera ──
  cityRow({
    account_key: 'B2026-010', dba_name: 'Vega Marisol', ownership_type: 'SOLE',
    business_owner_name: 'Vega Marisol', naics_code: '722511',
  }),
  cityRow({
    account_key: 'B2026-011', dba_name: 'Salazar, Ramon', ownership_type: 'CORP',
    business_owner_name: 'Salazar, Ramon', naics_code: '722320',
    naics_description: 'Caterers',
  }),
  cityRow({
    account_key: 'B2026-012', dba_name: 'Ruiz Family Holdings', ownership_type: 'TRUST',
    business_owner_name: 'Ruiz, Dana', naics_code: '531312',
  }),
  cityRow({
    account_key: 'B2026-013', dba_name: 'Nguyen Nails', ownership_type: 'H-W',
    business_owner_name: 'Nguyen, Minh', naics_code: '812113',
  }),

  // ── Domicilio o buzón: fuera ──
  cityRow({
    account_key: 'B2026-020', dba_name: 'Home Kitchen Treats LLC', ownership_type: 'LLC',
    naics_code: '722511', address_po_box: 'PO BOX 9912', address_road: 'Residence',
  }),
  cityRow({
    account_key: 'B2026-021', dba_name: 'Mailbox Ventures LLC', ownership_type: 'LLC',
    naics_code: '541611', naics_sector: '54', address_pmb_box: 'PMB 440',
    address_road: 'Convoy', address_sfx: 'St PMB 440',
  }),
  cityRow({
    account_key: 'B2026-022', dba_name: 'Apartment Consulting LLC', ownership_type: 'LLC',
    naics_code: '541611', naics_sector: '54', address_suite: 'Apt 7B',
    address_road: 'Island Apt 7B', lat: '32.8899',
  }),
  cityRow({
    account_key: 'B2026-023', dba_name: 'Little Hands Daycare LLC', ownership_type: 'LLC',
    naics_sector: '62', naics_code: '624410', naics_description: 'Child day care services',
  }),

  // ── Inactivas o caducadas: fuera ──
  cityRow({
    account_key: 'B2026-030', dba_name: 'Old Harbor Cantina LLC', ownership_type: 'LLC',
    account_status: 'Inactive', naics_code: '722511',
  }),
  cityRow({
    account_key: 'B2026-031', dba_name: 'Expired Deli Corp', ownership_type: 'CORP',
    date_cert_expiration: '2025-06-30', naics_code: '722511',
  }),
  cityRow({
    account_key: 'B2026-032', dba_name: 'Future Cafe LLC', ownership_type: 'LLC',
    date_cert_effective: '2027-12-01', naics_code: '722511',
  }),

  // ── No verificables: fuera ──
  cityRow({
    account_key: 'B2026-040', dba_name: 'Sin Direccion LLC', ownership_type: 'LLC',
    address_no: '', address_road: '', naics_code: '722511',
  }),
  cityRow({
    account_key: 'B2026-041', dba_name: 'Fuera De Ciudad LLC', ownership_type: 'LLC',
    address_city: 'Chula Vista', address_zip: '91910', naics_code: '722511',
  }),
  cityRow({
    account_key: 'B2026-042', dba_name: 'Sector Raro LLC', ownership_type: 'LLC',
    naics_sector: '11', naics_code: '111998', naics_description: 'All other crop farming',
  }),
  cityRow({
    account_key: 'B2026-043', dba_name: 'Forma Desconocida SA', ownership_type: 'XYZ',
    naics_code: '722511',
  }),
  cityRow({
    account_key: 'B2026-044', dba_name: '', ownership_type: 'LLC', naics_code: '722511',
  }),

  // ── Duplicado dentro de la propia corrida ──
  cityRow({
    account_key: 'B2026-001', dba_name: 'Bahía Taquería', ownership_type: 'LLC',
    business_owner_name: 'Fernandez, Ana Lucia', naics_code: '722511',
  }),
];

/** Serializa filas a texto CSV con el encabezado real. */
export function toCsv(rows, { header = CITY_HEADER } = {}) {
  const lines = [header.join(',')];
  for (const row of rows) lines.push(header.map((h) => campo(row[h])).join(','));
  return `${lines.join('\n')}\n`;
}

export const CITY_CSV = toCsv(CITY_ROWS);
export const CITY_CSV_SHA256 = crypto.createHash('sha256').update(CITY_CSV, 'utf8').digest('hex');

/**
 * Servidor del CSV. `mode` cambia su comportamiento:
 *   ok | notModified | truncated | oversize | malformed | unknownColumns | empty
 */
export function createFakeCityServer({ mode = 'ok', body = null, etag = '"abc123"', lastModified = 'Sat, 03 Oct 2026 09:06:24 GMT' } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({
      method: req.method,
      url: req.url,
      ifNoneMatch: req.headers['if-none-match'] ?? null,
      ifModifiedSince: req.headers['if-modified-since'] ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });

    // Solo el recurso oficial existe. Cualquier otra ruta es un 404: este
    // servidor no sirve HTML, igual que el código no lo pide.
    if (!req.url.startsWith('/business_tax_certificates/sd_businesses_active_datasd.csv')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found');
    }

    const condicional = req.headers['if-none-match'] === etag
      || req.headers['if-modified-since'] === lastModified;
    if (mode === 'notModified' || (mode === 'ok' && condicional)) {
      res.writeHead(304, { ETag: etag, 'Last-Modified': lastModified });
      return res.end();
    }

    let payload = body ?? CITY_CSV;
    if (mode === 'malformed') payload = `${CITY_HEADER.join(',')}\nB1,"sin cerrar,Active\n`;
    if (mode === 'unknownColumns') {
      payload = toCsv([cityRow({ account_key: 'B2026-050', dba_name: 'Columna Nueva LLC' })], {
        header: [...CITY_HEADER, 'owner_mobile_phone', 'owner_email'],
      }).replace(/\n$/, ',+16195550101,privado@ejemplo.invalid\n');
    }
    if (mode === 'empty') payload = '';

    const headers = {
      'Content-Type': 'text/csv',
      ETag: etag,
      'Last-Modified': lastModified,
      'Accept-Ranges': 'bytes',
    };
    if (mode === 'oversize') {
      // Anuncia un tamaño enorme: el cliente tiene que negarse antes de leer.
      headers['Content-Length'] = String(1024 * 1024 * 1024);
      res.writeHead(200, headers);
      return res.end(payload);
    }
    headers['Content-Length'] = String(Buffer.byteLength(payload));
    res.writeHead(200, headers);

    if (mode === 'truncated') {
      // Se corta la conexión a mitad del cuerpo.
      res.write(payload.slice(0, Math.floor(payload.length / 3)));
      return res.destroy();
    }
    return res.end(payload);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      requests,
      etag,
      lastModified,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      csvUrl: `http://127.0.0.1:${server.address().port}/business_tax_certificates/sd_businesses_active_datasd.csv`,
      close: () => server.close(),
    }));
  });
}
