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
  // Del volcado del directorio de escuelas: administradores, contacto y coordenadas.
  'Fernandez', 'afernandez@ejemplo.invalid', 'wchen@ejemplo.invalid', 'office@ejemplo.invalid',
  '(619) 555-0142', '(619) 555-0188', '(619) 555-0101', 'principal.personal@ejemplo.invalid',
  'AdmFName1', 'AdmLName1', 'AdmEmail1', 'AdmEmail2', 'Latitude', 'Longitude',
  'MailStreet', 'FaxNumber', '4100 Normal St',
];

// ── 1. CSLB · WebForms + CSV ─────────────────────────────────
export const CSLB_HEADER = [
  'LicenseNo', 'LastUpdate', 'BusinessName', 'FullBusinessName', 'MailingAddress', 'City', 'State', 'ZIPCode',
  'County', 'BusinessPhone', 'BusinessType', 'IssueDate', 'ExpirationDate', 'PrimaryStatus', 'SecondaryStatus',
  'Classifications(s)', 'BondAmount', 'WorkersCompInsurance', 'PolicyNumber', 'PersonnelName',
];

const campo = (v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function cslbRow(partial) {
  const base = {
    LicenseNo: '', LastUpdate: '2026-10-03', BusinessName: '', FullBusinessName: '',
    MailingAddress: '1450 Harbor Dr', City: 'San Diego', State: 'CA', ZIPCode: '92101',
    County: 'San Diego', BusinessPhone: '+16195550101', BusinessType: 'Corporation',
    IssueDate: '2015-04-01', ExpirationDate: '2027-04-30', PrimaryStatus: 'CLEAR',
    SecondaryStatus: '', 'Classifications(s)': 'B | C-10', BondAmount: '25000',
    WorkersCompInsurance: 'EXEMPT', PolicyNumber: 'WC-99881', PersonnelName: 'Ortega, Jose Ramon',
  };
  return { ...base, ...partial };
}

export const CSLB_ROWS = [
  // ── Aceptables ──
  cslbRow({ LicenseNo: '1000001', BusinessName: 'Harbor Builders Inc', FullBusinessName: 'Harbor Builders Incorporated' }),
  cslbRow({
    LicenseNo: '1000002', BusinessName: 'Gaslamp Construction, "The Original" LLC',
    FullBusinessName: 'Gaslamp Construction, "The Original" LLC', BusinessType: 'Limited Liability',
  }),
  cslbRow({
    // Nombre con salto de línea dentro de un campo entrecomillado.
    LicenseNo: '1000003', BusinessName: 'Mesa\nRoofing Co', FullBusinessName: 'Mesa\nRoofing Company',
    'Classifications(s)': 'B, C-39',
  }),
  // ── Fuera del condado ──
  cslbRow({ LicenseNo: '1000010', BusinessName: 'Riverside Builders Inc', County: 'Riverside' }),
  // ── Licencia no vigente ──
  cslbRow({ LicenseNo: '1000011', BusinessName: 'Expired Builders Inc', PrimaryStatus: 'EXPIRED' }),
  cslbRow({ LicenseNo: '1000012', BusinessName: 'Suspended Builders Inc', PrimaryStatus: 'SUSPENDED' }),
  // ── Forma jurídica personal ──
  cslbRow({ LicenseNo: '1000020', BusinessName: 'Ortega, Jose Ramon', FullBusinessName: 'Ortega, Jose Ramon', BusinessType: 'Sole Owner' }),
  cslbRow({ LicenseNo: '1000021', BusinessName: 'Chen Partnership', BusinessType: 'Partnership' }),
  // ── Sin la clase B ──
  cslbRow({ LicenseNo: '1000030', BusinessName: 'Plumb Only Inc', 'Classifications(s)': 'C-36 | C-20' }),
  cslbRow({ LicenseNo: '1000031', BusinessName: 'Remodel Only Inc', 'Classifications(s)': 'B-2 | C-10' }),
  // ── Nombre de persona pese a ser Corporation ──
  cslbRow({ LicenseNo: '1000040', BusinessName: 'Patel, Asha', FullBusinessName: 'Patel, Asha' }),
  // ── Duplicado de licencia en el mismo volcado ──
  cslbRow({ LicenseNo: '1000001', BusinessName: 'Harbor Builders Inc', FullBusinessName: 'Harbor Builders Incorporated' }),
];

export function cslbCsv(rows = CSLB_ROWS, { header = CSLB_HEADER } = {}) {
  return `${[header.join(','), ...rows.map((r) => header.map((h) => campo(r[h])).join(','))].join('\n')}\n`;
}

export const CSLB_CSV = cslbCsv();
export const CSLB_CSV_SHA256 = crypto.createHash('sha256').update(CSLB_CSV, 'utf8').digest('hex');

const PAGINA_PORTAL = (viewstate) => `<!DOCTYPE html><html><body><form method="post">
<input type="hidden" name="__VIEWSTATE" value="${viewstate}" />
<input type="hidden" name="__VIEWSTATEGENERATOR" value="A1B2C3D4" />
<input type="hidden" name="__EVENTVALIDATION" value="EV-${viewstate}" />
<select name="ctl00$MainContent$ddlStatus"><option value="M">License Master</option></select>
<a id="MainContent_lbMasterCSV" href="javascript:__doPostBack('ctl00$MainContent$lbMasterCSV','')">CSV</a>
</form></body></html>`;

/**
 * Portal WebForms simulado.
 * mode: ok | htmlInsteadOfCsv | redirect | noViewstate | wrongAttachment |
 *       truncated | oversize | malformedCsv | unknownColumns | empty | throttled
 */
export function createFakeCslbServer({ mode = 'ok', body = null } = {}) {
  const requests = [];
  let csvPedido = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    const params = new URLSearchParams(raw);
    const target = params.get('__EVENTTARGET');
    requests.push({
      method: req.method,
      url: req.url,
      eventTarget: target,
      dataType: params.get('ctl00$MainContent$ddlStatus'),
      viewstate: params.get('__VIEWSTATE'),
      eventValidation: params.get('__EVENTVALIDATION'),
      userAgent: req.headers['user-agent'] ?? null,
    });

    // Solo el recurso del portal existe. Nada de buscadores individuales.
    if (!req.url.startsWith('/onlineservices/dataportal/ContractorList')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found');
    }

    if (req.method === 'GET') {
      if (mode === 'noViewstate') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('<html><body><form></form></body></html>');
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(PAGINA_PORTAL('VS-1'));
    }

    // Postback de selección.
    if (target === 'ctl00$MainContent$ddlStatus') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(PAGINA_PORTAL('VS-2'));
    }

    // Postback del CSV.
    if (target === 'ctl00$MainContent$lbMasterCSV') {
      csvPedido++;
      if (mode === 'throttled' && csvPedido === 1) {
        res.writeHead(429, { 'Retry-After': '2' });
        return res.end();
      }
      if (mode === 'redirect') {
        res.writeHead(302, { Location: 'https://otro-sitio.invalid/MasterLicenseData.csv' });
        return res.end();
      }
      if (mode === 'htmlInsteadOfCsv') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('<html><body>Session expired. Please try again.</body></html>');
      }

      let payload = body ?? CSLB_CSV;
      if (mode === 'malformedCsv') payload = `${CSLB_HEADER.join(',')}\n1000099,"sin cerrar,CLEAR\n`;
      if (mode === 'unknownColumns') {
        payload = cslbCsv([cslbRow({ LicenseNo: '1000050', BusinessName: 'Columna Nueva Inc' })], {
          header: [...CSLB_HEADER, 'OwnerMobile', 'OwnerEmail'],
        }).replace(/\n$/, ',+16195550101,privado@ejemplo.invalid\n');
      }
      if (mode === 'empty') payload = '';

      const headers = {
        'Content-Type': 'text/csv',
        'Content-Disposition': mode === 'wrongAttachment'
          ? 'attachment; filename=OtraCosa.csv'
          : 'attachment; filename=MasterLicenseData.csv',
      };
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
    }

    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('postback desconocido');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      requests,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      portalUrl: `http://127.0.0.1:${server.address().port}/onlineservices/dataportal/ContractorList`,
      close: () => server.close(),
    }));
  });
}

// ── 2. HUD · ArcGIS ──────────────────────────────────────────
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

// ── 3. CDE · directorio de escuelas (TSV) ────────────────────
export const CDE_HEADER = [
  'CDSCode', 'NCESDist', 'NCESSchool', 'StatusType', 'County', 'District', 'School',
  'Street', 'StreetAbr', 'City', 'Zip', 'State',
  'MailStreet', 'MailCity', 'MailZip',
  'Phone', 'Ext', 'FaxNumber', 'Email', 'Website',
  'OpenDate', 'ClosedDate', 'Charter', 'FundingType', 'DOC', 'DOCType', 'SOC', 'SOCType',
  'EdOpsCode', 'EILCode', 'EILName', 'GSoffered', 'GSserved', 'Virtual', 'Magnet',
  'Latitude', 'Longitude',
  'AdmFName1', 'AdmLName1', 'AdmEmail1', 'AdmFName2', 'AdmLName2', 'AdmEmail2',
  'LastUpDate',
];

export function cdeRow(partial) {
  const base = {
    CDSCode: '', NCESDist: '0634410', NCESSchool: '12345', StatusType: 'Active',
    County: 'San Diego', District: 'San Diego Unified', School: '',
    Street: '1200 Harbor Blvd', StreetAbr: '1200 Harbor Blvd', City: 'San Diego',
    Zip: '92101-1234', State: 'CA',
    MailStreet: '4100 Normal St', MailCity: 'San Diego', MailZip: '92103',
    Phone: '(619) 555-0142', Ext: '203', FaxNumber: '(619) 555-0188',
    Email: 'office@ejemplo.invalid', Website: 'www.ejemplo-escuela.invalid',
    OpenDate: '1998-08-15', ClosedDate: '', Charter: 'N', FundingType: 'Directly funded',
    DOC: '54', DOCType: 'Unified School District', SOC: '60', SOCType: 'Elementary Schools (Public)',
    EdOpsCode: 'TRAD', EILCode: 'ELEM', EILName: 'Elementary',
    GSoffered: 'K-5', GSserved: 'K-5', Virtual: 'N', Magnet: 'N',
    Latitude: '32.715711', Longitude: '-117.161100',
    AdmFName1: 'Ana', AdmLName1: 'Fernandez', AdmEmail1: 'afernandez@ejemplo.invalid',
    AdmFName2: 'Wei', AdmLName2: 'Chen', AdmEmail2: 'wchen@ejemplo.invalid',
    LastUpDate: '2026-09-30',
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
 * mode: ok | notModified | truncated | oversize | malformed | unknownColumns | empty
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
