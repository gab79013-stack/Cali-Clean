import http from 'node:http';
import crypto from 'node:crypto';

/**
 * Los tres portales de la fase 3, simulados con la forma de los reales y
 * deliberadamente hostiles donde importa.
 *
 * Cada servidor acepta un `mode` que reproduce un fallo concreto, porque lo que
 * hay que probar no es el camino bueno: es que un portal que devuelve HTML en vez
 * de CSV, que redirige a S3, que pagina mal o que rota un recurso no produzca
 * datos a medias.
 */

// ── Valores que NUNCA pueden sobrevivir ──────────────────────
export const PII_PROHIBIDA = [
  'Ortega, Jose Ramon', 'Fernandez, Ana Lucia', 'Chen, Wei', 'Patel, Asha',
  'privado@ejemplo.invalid', 'titular@ejemplo.invalid',
  '+16195550101', '619-555-0101', '(619) 555-0142',
  '32.715711', '-117.161100', '33.123456',
  'PO BOX 9912', 'PMB 440', 'Apt 7B',
  'BondAmount', 'WorkersCompInsurance', 'PolicyNumber', 'MailingAddress',
  'PROJECT_MANAGER_NAME_TEXT', 'MGMT_CONTACT_FULL_NAME', 'LATITUDE', 'LONGITUDE',
  'ADMINISTRATOR',
  // Del volcado del directorio de escuelas: el administrador de cada centro, su
  // contacto y las coordenadas. Los nombres de columna son los del esquema real.
  'Fernandez', 'principal.personal@ejemplo.invalid',
  '(619) 555-0142', '(619) 555-0188', '(619) 555-0101',
  'AdmFName', 'AdmLName', 'Phone Ext', 'Latitude', 'Longitude',
  'MailStreet', 'MailStrAbr', 'MailZip', 'FaxNumber', '4100 Normal St',
  // Del CSV de aprobaciones de desarrollo: parcela, coordenadas, cuenta
  // fiduciaria, numero de plano y los titulares que son personas.
  'Cole Storey', 'Architect MD Lyon', 'Sara Hoffelt',
  '5350123400', '32.711230', '-117.160450', 'TA-99881', 'DWG-2026-4412',
  'GIS_APN', 'GIS_LATITUDE', 'GIS_LONGITUDE', 'PROJECT_TRUST_ACCOUNT_NO', 'JOB_DRAWING_NUMBER',
  'HOLDER_PHONE', 'HOLDER_EMAIL',
];

/** Escapa un campo de CSV: comillas, comas y saltos de línea. */
const campo = (v) => {
  const t = String(v ?? '');
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

// ── 1. HUD · ArcGIS ──────────────────────────────────────────
export function hudRow(partial) {
  const base = {
    PROPERTY_ID: '', PROPERTY_NAME_TEXT: '', TOTAL_UNIT_COUNT: 120,
    PROPERTY_CATEGORY_NAME: 'Insured', STD_ADDR: '850 Market St', STD_CITY: 'San Diego',
    STD_ST: 'CA', STD_ZIP5: '92101', MGMT_AGENT_ORG_NAME: 'Coastal Management LLC',
  };
  return { ...base, ...partial };
}

export const HUD_ROWS = [
  hudRow({ PROPERTY_ID: 'P-0001', PROPERTY_NAME_TEXT: 'Villa Serena Apartments' }),
  hudRow({ PROPERTY_ID: 'P-0002', PROPERTY_NAME_TEXT: 'Harbor Terrace Senior Housing', TOTAL_UNIT_COUNT: 88, STD_CITY: 'Chula Vista', STD_ZIP5: '91910' }),
  hudRow({ PROPERTY_ID: 'P-0003', PROPERTY_NAME_TEXT: 'Mesa Gardens Commons', STD_ZIP5: '92111' }),
  // ── Fuera de ámbito ──
  hudRow({ PROPERTY_ID: 'P-0010', PROPERTY_NAME_TEXT: 'Fresno Towers Apartments', STD_CITY: 'Fresno', STD_ZIP5: '93650' }),
  hudRow({ PROPERTY_ID: 'P-0011', PROPERTY_NAME_TEXT: 'Phoenix Villas Apartments', STD_ST: 'AZ', STD_CITY: 'Phoenix', STD_ZIP5: '85001' }),
  // ── Residencial / no institucional ──
  hudRow({ PROPERTY_ID: 'P-0020', PROPERTY_NAME_TEXT: 'Single Family Home Program', PROPERTY_CATEGORY_NAME: 'Single Family', TOTAL_UNIT_COUNT: 1 }),
  hudRow({ PROPERTY_ID: 'P-0021', PROPERTY_NAME_TEXT: 'Duplex Holdings Apartments', TOTAL_UNIT_COUNT: 2 }),
  hudRow({ PROPERTY_ID: 'P-0022', PROPERTY_NAME_TEXT: 'Vacant Land Parcel Apartments', PROPERTY_CATEGORY_NAME: 'Vacant Land' }),
  hudRow({ PROPERTY_ID: 'P-0023', PROPERTY_NAME_TEXT: 'Island Apartments', STD_ADDR: '12 Island Ave Apt 7B' }),
  // ── Nombre de persona ──
  hudRow({ PROPERTY_ID: 'P-0030', PROPERTY_NAME_TEXT: 'Chen, Wei' }),
  // ── Unidades ilegibles / dirección incompleta ──
  hudRow({ PROPERTY_ID: 'P-0040', PROPERTY_NAME_TEXT: 'Sin Unidades Apartments', TOTAL_UNIT_COUNT: 'muchas' }),
  hudRow({ PROPERTY_ID: 'P-0041', PROPERTY_NAME_TEXT: 'Sin Direccion Apartments', STD_ADDR: '' }),
  // ── Gestor que es una persona: el gestor se cae, la propiedad pasa ──
  hudRow({ PROPERTY_ID: 'P-0050', PROPERTY_NAME_TEXT: 'Bayview Manor Apartments', MGMT_AGENT_ORG_NAME: 'Patel, Asha' }),
];

/**
 * Servicio ArcGIS simulado.
 * mode: ok | error200 | badJson | throttled | partialPage | neverEnds | emptyFirst
 */
export function createFakeArcgisServer({ mode = 'ok', rows = HUD_ROWS, pageSize = 2 } = {}) {
  const requests = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.searchParams;
    n++;
    requests.push({
      method: req.method,
      path: url.pathname,
      outFields: p.get('outFields'),
      returnGeometry: p.get('returnGeometry'),
      where: p.get('where'),
      offset: Number(p.get('resultOffset') || 0),
      count: Number(p.get('resultRecordCount') || 0),
      orderByFields: p.get('orderByFields'),
    });

    const json = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (!url.pathname.endsWith('/query')) return json(404, { error: { message: 'not found' } });
    if (mode === 'throttled' && n === 1) {
      res.writeHead(429, { 'Retry-After': '1' });
      return res.end();
    }
    if (mode === 'error200') return json(200, { error: { code: 400, message: 'Unable to complete operation' } });
    if (mode === 'badJson') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{ no es json');
    }
    if (mode === 'emptyFirst') return json(200, { features: [], exceededTransferLimit: true });

    // Solo se devuelven los campos pedidos... salvo en `partialPage`, donde el
    // servidor manda de más para comprobar que el cliente lo recorta igual.
    const pedidos = (p.get('outFields') || '').split(',').filter(Boolean);
    const offset = Number(p.get('resultOffset') || 0);
    const count = Number(p.get('resultRecordCount') || pageSize);
    const page = rows.slice(offset, offset + Math.min(count, pageSize));

    const features = page.map((r) => {
      const attributes = {};
      for (const f of pedidos) attributes[f] = r[f];
      if (mode === 'partialPage') {
        attributes.PROJECT_MANAGER_NAME_TEXT = 'Chen, Wei';
        attributes.MGMT_CONTACT_FULL_NAME = 'Patel, Asha';
        attributes.LATITUDE = 32.715711;
        attributes.LONGITUDE = -117.1611;
      }
      return { attributes };
    });

    const quedan = offset + page.length < rows.length;
    return json(200, {
      features,
      exceededTransferLimit: mode === 'neverEnds' ? true : quedan,
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      requests,
      queryUrl: `http://127.0.0.1:${server.address().port}/arcgis/rest/services/gotit/MultifamilyProperties/MapServer/0/query`,
      close: () => server.close(),
    }));
  });
}

// ── 2. CDE · directorio de escuelas (TSV) ────────────────────
// Cabecera REAL del volcado, copiada del esquema oficial que el CDE publica en
// /ds/si/ds/fspubschls.asp (revisado el 2024-09-19): 46 columnas, en ese orden.
// La primera versión de este fixture se escribió a ciegas y se equivocaba en tres
// cosas que importaban — inventaba `Ext` (se llama `Phone Ext`, con espacio), una
// columna `Email` que no existe, y `AdmFName1/2/3` + `AdmEmail1/2/3` donde el
// archivo trae `AdmFName` y `AdmLName` en singular y ningún correo.
export const CDE_HEADER = [
  'CDSCode', 'NCESDist', 'NCESSchool', 'StatusType', 'County', 'District', 'School',
  'Street', 'StreetAbr', 'City', 'Zip', 'State',
  'MailStreet', 'MailStrAbr', 'MailCity', 'MailZip', 'MailState',
  'Phone', 'Phone Ext', 'FaxNumber', 'Website',
  'OpenDate', 'ClosedDate', 'Charter', 'CharterNum', 'FundingType',
  'DOC', 'DOCType', 'SOC', 'SOCType',
  'EdOpsCode', 'EdOpsName', 'EILCode', 'EILName', 'GSoffered', 'GSserved',
  'Virtual', 'Magnet', 'YearRound', 'FederalDFCDistrictID',
  'Latitude', 'Longitude',
  'AdmFName', 'AdmLName', 'LastUpDate', 'Multilingual',
];

export function cdeRow(partial) {
  const base = {
    CDSCode: '', NCESDist: '0634410', NCESSchool: '12345', StatusType: 'Active',
    County: 'San Diego', District: 'San Diego Unified', School: '',
    Street: '1200 Harbor Blvd', StreetAbr: '1200 Harbor Blvd', City: 'San Diego',
    Zip: '92101-1234', State: 'CA',
    MailStreet: '4100 Normal St', MailStrAbr: '4100 Normal St',
    MailCity: 'San Diego', MailZip: '92103', MailState: 'CA',
    Phone: '(619) 555-0142', 'Phone Ext': '203', FaxNumber: '(619) 555-0188',
    Website: 'www.ejemplo-escuela.invalid',
    OpenDate: '1998-08-15', ClosedDate: '', Charter: 'N', CharterNum: '',
    FundingType: 'Directly funded',
    DOC: '54', DOCType: 'Unified School District', SOC: '60', SOCType: 'Elementary Schools (Public)',
    EdOpsCode: 'TRAD', EdOpsName: 'Traditional', EILCode: 'ELEM', EILName: 'Elementary',
    GSoffered: 'K-5', GSserved: 'K-5', Virtual: 'N', Magnet: 'N', YearRound: 'N',
    FederalDFCDistrictID: '0634410',
    Latitude: '32.715711', Longitude: '-117.161100',
    AdmFName: 'Ana', AdmLName: 'Fernandez', LastUpDate: '2026-09-30', Multilingual: 'N',
  };
  return { ...base, ...partial };
}

export const CDE_ROWS = [
  // ── Aceptables ──
  cdeRow({ CDSCode: '37683380000001', School: 'Harbor View Elementary' }),
  cdeRow({
    CDSCode: '37683380000002', School: 'Mesa Verde "North" Middle School',
    Street: '620 Fifth Ave', City: 'Chula Vista', Zip: '91910',
    SOCType: 'Intermediate/Middle Schools (Public)',
  }),
  cdeRow({
    // Nombre con salto de línea dentro de un campo entrecomillado.
    CDSCode: '37683380000003', School: 'Pacific\nCharter Academy', Charter: 'Y',
    Website: 'https://pacific-charter.invalid', City: 'Oceanside', Zip: '92054',
  }),
  // ── Fuera de condado / cerrada ──
  cdeRow({ CDSCode: '30664640000010', School: 'Orange Grove Elementary', County: 'Orange' }),
  cdeRow({ CDSCode: '37683380000011', School: 'Closed Canyon Elementary', StatusType: 'Closed', ClosedDate: '2024-06-30' }),
  cdeRow({ CDSCode: '37683380000012', School: 'Pending Hills Elementary', StatusType: 'Pending' }),
  // ── Fila de distrito u oficina, sin centro ──
  cdeRow({ CDSCode: '37683380000000', School: 'No Data', District: 'San Diego Unified' }),
  cdeRow({ CDSCode: '37000000000000', School: '', District: 'San Diego County Office of Education' }),
  // ── Virtual: sin instalaciones ──
  cdeRow({ CDSCode: '37683380000020', School: 'San Diego Virtual Academy', Virtual: 'Y' }),
  // ── Domicilio ──
  cdeRow({ CDSCode: '37683380000030', School: 'Tiny Hands Family Child Care Home' }),
  cdeRow({ CDSCode: '37683380000031', School: 'Island Preschool', Street: '12 Island Ave Apt 7B' }),
  // ── Dirección incompleta ──
  cdeRow({ CDSCode: '37683380000040', School: 'Sin Zip Elementary', Zip: '' }),
  cdeRow({ CDSCode: '37683380000041', School: 'Sin Calle Elementary', Street: '' }),
  // ── Duplicado en el mismo volcado ──
  cdeRow({ CDSCode: '37683380000001', School: 'Harbor View Elementary' }),
];

export function cdeTsv(rows = CDE_ROWS, { header = CDE_HEADER } = {}) {
  const campoTab = (v) => {
    const t = String(v ?? '');
    return /["\t\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return `${[header.join('\t'), ...rows.map((r) => header.map((h) => campoTab(r[h])).join('\t'))].join('\n')}\n`;
}

export const CDE_TSV = cdeTsv();
export const CDE_TSV_SHA256 = crypto.createHash('sha256').update(CDE_TSV, 'utf8').digest('hex');

/**
 * Servidor del volcado del directorio.
 * mode: ok | notModified | truncated | oversize | malformed | unknownColumns |
 *       missingColumn | empty
 */
export function createFakeCdeServer({ mode = 'ok', body = null, etag = '"cde-1"', lastModified = 'Wed, 30 Sep 2026 10:00:00 GMT' } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push({
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      ifNoneMatch: req.headers['if-none-match'] ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });

    // Solo el recurso de descarga. Nada de raspar el buscador del directorio.
    if (url.pathname !== '/schooldirectory/report') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found');
    }

    if (mode === 'notModified' || (mode === 'ok' && req.headers['if-none-match'] === etag)) {
      res.writeHead(304, { ETag: etag, 'Last-Modified': lastModified });
      return res.end();
    }

    let payload = body ?? CDE_TSV;
    if (mode === 'malformed') payload = `${CDE_HEADER.join('\t')}\n123\t"sin cerrar\tActive\n`;
    if (mode === 'unknownColumns') {
      // Dos columnas nuevas, con el MISMO número de campos en la cabecera y en la
      // fila: un volcado con columnas de más es válido como CSV, y eso es
      // justamente lo que tiene que caerse por la allowlist y no por el parser.
      const conExtras = {
        ...cdeRow({ CDSCode: '37683380000050', School: 'Columna Nueva Elementary' }),
        PrincipalMobile: '(619) 555-0101',
        PrincipalPersonalEmail: 'principal.personal@ejemplo.invalid',
      };
      payload = cdeTsv([conExtras], {
        header: [...CDE_HEADER, 'PrincipalMobile', 'PrincipalPersonalEmail'],
      });
    }
    if (mode === 'missingColumn') {
      // El publicador deja de publicar una columna de la allowlist. Y no una
      // cualquiera: sin `Zip` no se puede exigir dirección completa, así que la
      // allowlist atestiguada dejaría de significar lo que dice la constancia.
      payload = cdeTsv(CDE_ROWS, { header: CDE_HEADER.filter((h) => h !== 'Zip') });
    }
    if (mode === 'empty') payload = '';

    const headers = { 'Content-Type': 'text/plain; charset=utf-8', ETag: etag, 'Last-Modified': lastModified };
    if (mode === 'oversize') {
      headers['Content-Length'] = String(1024 * 1024 * 1024);
      res.writeHead(200, headers);
      return res.end(payload);
    }
    headers['Content-Length'] = String(Buffer.byteLength(payload));
    res.writeHead(200, headers);
    if (mode === 'truncated') {
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
      downloadUrl: `http://127.0.0.1:${server.address().port}/schooldirectory/report?rid=dl1&tp=txt`,
      close: () => server.close(),
    }));
  });
}

// ── 3. City of San Diego · aprobaciones de desarrollo (CSV) ──
//
// Cabecera REAL del archivo, leída con un GET de rango sobre
// approvals_issued_2026_datasd.csv el 2026-10-04: 54 columnas, en ese orden.
// Dentro van APN, latitud, longitud, número de cuenta fiduciaria y número de
// plano, porque el archivo los trae de verdad y las pruebas tienen que
// demostrar que no sobreviven.
export const CITY_DEV_HEADER = [
    "DEVELOPMENT_ID",
    "PROJECT_ID",
    "PROJECT_TYPE",
    "PROJECT_STATUS",
    "PROJECT_PROCESSING_CODE",
    "PROJECT_CREATE_DATE",
    "PROJECT_DEEMEDCOMPLETE_DATE",
    "PROJECT_TRUST_ACCOUNT_NO",
    "PROJECT_TITLE",
    "PROJECT_SCOPE",
    "JOB_ID",
    "JOB_DRAWING_NUMBER",
    "GIS_ADDRESS",
    "GIS_APN",
    "JOB_BC_CODE",
    "JOB_BC_CODE_DESCRIPTION",
    "GIS_LATITUDE",
    "GIS_LONGITUDE",
    "APPROVAL_ID",
    "APPROVAL_CATEGORY_CODE",
    "APPROVAL_PROCESSING_CODE",
    "APPROVAL_TYPE",
    "APPROVAL_STATUS",
    "APPROVAL_SCOPE",
    "APPROVAL_CREATE_DATE",
    "APPROVAL_ISSUE_DATE",
    "APPROVAL_CLOSE_DATE",
    "APPROVAL_EXPIRE_DATE",
    "APPROVAL_VALUATION",
    "APPROVAL_DU_NET_CHANGE",
    "APPROVAL_STORIES",
    "APPROVAL_FLOOR_AREA",
    "APPROVAL_DU_EXTREMELY_LOW",
    "APPROVAL_DU_VERY_LOW",
    "APPROVAL_DU_LOW",
    "APPROVAL_DU_MODERATE",
    "APPROVAL_DU_ABOVE_MODERATE",
    "APPROVAL_DU_FUTURE_DEMO",
    "APPROVAL_DU_BONUS",
    "APPROVAL_ADU_EXTREMELY_LOW",
    "APPROVAL_ADU_VERY_LOW",
    "APPROVAL_ADU_LOW",
    "APPROVAL_ADU_MODERATE",
    "APPROVAL_ADU_ABOVE_MODERATE",
    "APPROVAL_ADU_BONUS",
    "APPROVAL_ADU_TOTAL",
    "APPROVAL_JADU_EXTREMELY_LOW",
    "APPROVAL_JADU_VERY_LOW",
    "APPROVAL_JADU_LOW",
    "APPROVAL_JADU_MODERATE",
    "APPROVAL_JADU_ABOVE_MODERATE",
    "APPROVAL_JADU_BONUS",
    "APPROVAL_JADU_TOTAL",
    "APPROVAL_PERMIT_HOLDER"
  ];

export function cityDevRow(partial) {
  const base = {
    DEVELOPMENT_ID: '700001', PROJECT_ID: '628113', PROJECT_TYPE: 'Building Construction',
    PROJECT_STATUS: 'Active', PROJECT_PROCESSING_CODE: 'MIN',
    PROJECT_CREATE_DATE: '2026-05-02', PROJECT_DEEMEDCOMPLETE_DATE: '',
    PROJECT_TRUST_ACCOUNT_NO: 'TA-99881',
    PROJECT_TITLE: 'Gaslamp Retail Build-Out', PROJECT_SCOPE: 'Interior tenant improvement',
    JOB_ID: '880001', JOB_DRAWING_NUMBER: 'DWG-2026-4412',
    GIS_ADDRESS: '750 FIFTH AVE', GIS_APN: '5350123400',
    JOB_BC_CODE: '437', JOB_BC_CODE_DESCRIPTION: 'Add/Alt Tenant Improvements',
    GIS_LATITUDE: '32.711230', GIS_LONGITUDE: '-117.160450',
    APPROVAL_ID: '', APPROVAL_CATEGORY_CODE: 'B', APPROVAL_PROCESSING_CODE: 'CBP',
    APPROVAL_TYPE: 'Combination Building Permit', APPROVAL_STATUS: 'Issued',
    APPROVAL_SCOPE: 'Tenant improvement of ground floor commercial suite',
    APPROVAL_CREATE_DATE: '2026-08-01', APPROVAL_ISSUE_DATE: '2026-09-15',
    APPROVAL_CLOSE_DATE: '', APPROVAL_EXPIRE_DATE: '2027-09-15',
    APPROVAL_VALUATION: '450000.00', APPROVAL_DU_NET_CHANGE: '0',
    APPROVAL_STORIES: '1', APPROVAL_FLOOR_AREA: '3200',
    APPROVAL_DU_EXTREMELY_LOW: '0', APPROVAL_DU_VERY_LOW: '0', APPROVAL_DU_LOW: '0',
    APPROVAL_DU_MODERATE: '0', APPROVAL_DU_ABOVE_MODERATE: '0',
    APPROVAL_DU_FUTURE_DEMO: '0', APPROVAL_DU_BONUS: '0',
    APPROVAL_ADU_EXTREMELY_LOW: '0', APPROVAL_ADU_VERY_LOW: '0', APPROVAL_ADU_LOW: '0',
    APPROVAL_ADU_MODERATE: '0', APPROVAL_ADU_ABOVE_MODERATE: '0', APPROVAL_ADU_BONUS: '0',
    APPROVAL_ADU_TOTAL: '0',
    APPROVAL_JADU_EXTREMELY_LOW: '0', APPROVAL_JADU_VERY_LOW: '0', APPROVAL_JADU_LOW: '0',
    APPROVAL_JADU_MODERATE: '0', APPROVAL_JADU_ABOVE_MODERATE: '0', APPROVAL_JADU_BONUS: '0',
    APPROVAL_JADU_TOTAL: '0',
    APPROVAL_PERMIT_HOLDER: '',
  };
  return { ...base, ...partial };
}

// `now` de referencia de las pruebas: 2026-10-04. La ventana es de 90 días, así
// que el corte cae en 2026-07-06.
export const CITY_DEV_NOW = Date.parse('2026-10-04T12:00:00.000Z');

export const CITY_DEV_ROWS = [
  // ── Aceptables ──
  cityDevRow({ APPROVAL_ID: '2630001', APPROVAL_PERMIT_HOLDER: 'Harbor Interiors, Inc' }),
  cityDevRow({
    APPROVAL_ID: '2630002', APPROVAL_PERMIT_HOLDER: 'Davies Electric Co., Inc',
    JOB_BC_CODE_DESCRIPTION: 'Add/Alt NonRes Bldg or Struct', GIS_ADDRESS: '1200 BROADWAY',
    APPROVAL_ISSUE_DATE: '2026-09-30', APPROVAL_TYPE: 'Electrical Pmt',
  }),
  cityDevRow({
    // Nivel 2: designador de actividad sin sufijo legal.
    APPROVAL_ID: '2630003', APPROVAL_PERMIT_HOLDER: 'CertEX Construction',
    JOB_BC_CODE_DESCRIPTION: 'Demo of NonRes Buildings', GIS_ADDRESS: '4040 KEARNY MESA RD',
    APPROVAL_ISSUE_DATE: '2026-08-20', APPROVAL_TYPE: 'Approval - Construction - Demolition Pmt',
    APPROVAL_SCOPE: 'Demolition of former warehouse structure',
    PROJECT_TITLE: 'Kearny Mesa Warehouse Demo', PROJECT_SCOPE: 'Demolition',
  }),
  cityDevRow({
    // Comilla y coma dentro de un campo: el CSV tiene que sobrevivir.
    APPROVAL_ID: '2630004', APPROVAL_PERMIT_HOLDER: 'Elements of "Hospitality", Inc',
    JOB_BC_CODE_DESCRIPTION: 'Store/Mercantile Building', GIS_ADDRESS: '98 MARKET ST, SUITE 200',
    APPROVAL_ISSUE_DATE: '2026-07-10',
  }),
  // ── Mismo titular, dos permisos: una sola Company, gana el más reciente ──
  cityDevRow({ APPROVAL_ID: '2630010', APPROVAL_PERMIT_HOLDER: 'Harbor Interiors, Inc', APPROVAL_ISSUE_DATE: '2026-07-20' }),
  // ── Estado que no es Issued ──
  cityDevRow({ APPROVAL_ID: '2630020', APPROVAL_PERMIT_HOLDER: 'Closed Works LLC', APPROVAL_STATUS: 'Closed' }),
  cityDevRow({ APPROVAL_ID: '2630021', APPROVAL_PERMIT_HOLDER: 'Pending Pay LLC', APPROVAL_STATUS: 'Pending Invoice Payment' }),
  cityDevRow({ APPROVAL_ID: '2630022', APPROVAL_PERMIT_HOLDER: 'Cancelado LLC', APPROVAL_STATUS: 'Cancelled' }),
  // ── Fuera de la ventana de 90 días ──
  cityDevRow({ APPROVAL_ID: '2630030', APPROVAL_PERMIT_HOLDER: 'Antigua Obra LLC', APPROVAL_ISSUE_DATE: '2026-02-19' }),
  // ── Sin fecha de emisión / fecha en el futuro ──
  cityDevRow({ APPROVAL_ID: '2630031', APPROVAL_PERMIT_HOLDER: 'Sin Fecha LLC', APPROVAL_ISSUE_DATE: '' }),
  cityDevRow({ APPROVAL_ID: '2630032', APPROVAL_PERMIT_HOLDER: 'Futura LLC', APPROVAL_ISSUE_DATE: '2027-01-05' }),
  // ── Sin clasificación de edificación: no hay señal comercial ──
  cityDevRow({ APPROVAL_ID: '2630040', APPROVAL_PERMIT_HOLDER: 'Sin Clase LLC', JOB_BC_CODE_DESCRIPTION: '' }),
  // ── Residencial, por clasificación ──
  cityDevRow({ APPROVAL_ID: '2630050', APPROVAL_PERMIT_HOLDER: 'Casas Unifamiliares LLC', JOB_BC_CODE_DESCRIPTION: 'One Family Detached' }),
  cityDevRow({ APPROVAL_ID: '2630051', APPROVAL_PERMIT_HOLDER: 'Cinco Pisos LLC', JOB_BC_CODE_DESCRIPTION: 'Five or More Family Apt' }),
  cityDevRow({ APPROVAL_ID: '2630052', APPROVAL_PERMIT_HOLDER: 'Companion LLC', JOB_BC_CODE_DESCRIPTION: 'Add/Alt Companion Unit/Acc Apt' }),
  // ── Uso mixto ambiguo: la clasificación no distingue ──
  cityDevRow({ APPROVAL_ID: '2630060', APPROVAL_PERMIT_HOLDER: 'Ambigua LLC', JOB_BC_CODE_DESCRIPTION: 'Acc Bldg to 3+ Fam or NonRes' }),
  cityDevRow({ APPROVAL_ID: '2630061', APPROVAL_PERMIT_HOLDER: 'Piscina Mixta LLC', JOB_BC_CODE_DESCRIPTION: 'Pool or Spa/3+ Fam or NonRes' }),
  // ── Rótulo: no es obra que limpiar ──
  cityDevRow({ APPROVAL_ID: '2630070', APPROVAL_PERMIT_HOLDER: 'Rotulos LLC', JOB_BC_CODE_DESCRIPTION: 'Signs - Permanent', APPROVAL_TYPE: 'Approval - Construction - Sign Pmt' }),
  // ── Comercial por clase, pero el alcance delata vivienda ──
  cityDevRow({
    APPROVAL_ID: '2630080', APPROVAL_PERMIT_HOLDER: 'Mixta Residencial LLC',
    APPROVAL_SCOPE: 'Conversion of ground floor to two residential dwelling units',
  }),
  cityDevRow({ APPROVAL_ID: '2630081', APPROVAL_PERMIT_HOLDER: 'Adu Builders LLC', PROJECT_SCOPE: 'New ADU over garage' }),
  // ── Dirección ausente, [Pending] o de vivienda concreta ──
  cityDevRow({ APPROVAL_ID: '2630090', APPROVAL_PERMIT_HOLDER: 'Sin Direccion LLC', GIS_ADDRESS: '' }),
  cityDevRow({ APPROVAL_ID: '2630091', APPROVAL_PERMIT_HOLDER: 'Pendiente LLC', GIS_ADDRESS: '2310 CAMINO DEL RIO NORTH [Pending]' }),
  cityDevRow({ APPROVAL_ID: '2630092', APPROVAL_PERMIT_HOLDER: 'Piso Concreto LLC', GIS_ADDRESS: '77 BAY BLVD APT 7B' }),
  // ── Titular que es una persona, o que no se puede afirmar empresa ──
  cityDevRow({ APPROVAL_ID: '2630100', APPROVAL_PERMIT_HOLDER: 'Cole Storey' }),
  cityDevRow({ APPROVAL_ID: '2630101', APPROVAL_PERMIT_HOLDER: 'Architect MD Lyon, Sara Hoffelt' }),
  cityDevRow({ APPROVAL_ID: '2630102', APPROVAL_PERMIT_HOLDER: 'Ortega, Jose Ramon' }),
  cityDevRow({ APPROVAL_ID: '2630103', APPROVAL_PERMIT_HOLDER: 'Acme' }),
  cityDevRow({ APPROVAL_ID: '2630104', APPROVAL_PERMIT_HOLDER: '' }),
  // ── Compuestos "persona + empresa", en las tres formas que usa el registro ──
  //
  // Estos tres casos vienen de la preview real: la primera versión de la regla
  // los aceptaba porque tenían sufijo legal o palabra de actividad. Los nombres
  // de aquí están inventados a propósito: los reales son de personas concretas y
  // no van a quedarse escritos en un fixture.
  cityDevRow({ APPROVAL_ID: '2630110', APPROVAL_PERMIT_HOLDER: 'Ana Ruiz - Flow Builders' }),
  cityDevRow({ APPROVAL_ID: '2630111', APPROVAL_PERMIT_HOLDER: 'Harbor Builders Inc. / Luis Mora' }),
  cityDevRow({ APPROVAL_ID: '2630112', APPROVAL_PERMIT_HOLDER: 'Pedro Soto/Del Mar Builders' }),
  // ── Sin APPROVAL_ID ──
  cityDevRow({ APPROVAL_ID: '', APPROVAL_PERMIT_HOLDER: 'Sin Id LLC' }),
];

export function cityDevCsv(rows = CITY_DEV_ROWS, { header = CITY_DEV_HEADER } = {}) {
  return `${[header.map(campo).join(','), ...rows.map((r) => header.map((h) => campo(r[h])).join(','))].join('\n')}\n`;
}

export const CITY_DEV_CSV = cityDevCsv();

/**
 * Servidor del CSV de aprobaciones.
 * mode: ok | notModified | truncated | oversize | malformed | unknownColumns |
 *       missingColumn | empty
 */
export function createFakeCityDevServer({ mode = 'ok', body = null, etag = '"city-dev-1"', lastModified = 'Fri, 02 Oct 2026 12:30:35 GMT' } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push({
      method: req.method,
      path: url.pathname,
      ifNoneMatch: req.headers['if-none-match'] ?? null,
      userAgent: req.headers['user-agent'] ?? null,
      range: req.headers.range ?? null,
    });

    if (url.pathname !== '/development_permits/approvals_issued_2026_datasd.csv') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found');
    }
    if (mode === 'notModified' || (mode === 'ok' && req.headers['if-none-match'] === etag)) {
      res.writeHead(304, { ETag: etag, 'Last-Modified': lastModified });
      return res.end();
    }

    let payload = body ?? CITY_DEV_CSV;
    if (mode === 'malformed') payload = `${CITY_DEV_HEADER.join(',')}\n2630001,"sin cerrar,Issued\n`;
    if (mode === 'unknownColumns') {
      payload = cityDevCsv([{
        ...cityDevRow({ APPROVAL_ID: '2630200', APPROVAL_PERMIT_HOLDER: 'Columna Nueva LLC' }),
        HOLDER_PHONE: '(619) 555-0101',
        HOLDER_EMAIL: 'privado@ejemplo.invalid',
      }], { header: [...CITY_DEV_HEADER, 'HOLDER_PHONE', 'HOLDER_EMAIL'] });
    }
    if (mode === 'missingColumn') {
      payload = cityDevCsv(CITY_DEV_ROWS, { header: CITY_DEV_HEADER.filter((h) => h !== 'GIS_ADDRESS') });
    }
    if (mode === 'empty') payload = '';

    const headers = { 'Content-Type': 'binary/octet-stream', ETag: etag, 'Last-Modified': lastModified };
    if (mode === 'oversize') {
      headers['Content-Length'] = String(1024 * 1024 * 1024);
      res.writeHead(200, headers);
      return res.end(payload);
    }
    headers['Content-Length'] = String(Buffer.byteLength(payload));
    res.writeHead(200, headers);
    if (mode === 'truncated') {
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
      downloadUrl: `http://127.0.0.1:${server.address().port}/development_permits/approvals_issued_2026_datasd.csv`,
      close: () => server.close(),
    }));
  });
}
