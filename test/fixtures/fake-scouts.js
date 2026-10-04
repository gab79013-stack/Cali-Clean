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
<select name="ddlDataType"><option value="M">License Master</option></select>
<a id="lbMasterCSV" href="javascript:__doPostBack('lbMasterCSV','')">CSV</a>
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
      dataType: params.get('ddlDataType'),
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
    if (target === 'ddlDataType') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(PAGINA_PORTAL('VS-2'));
    }

    // Postback del CSV.
    if (target === 'lbMasterCSV') {
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

// ── 3. HCAI · CKAN ───────────────────────────────────────────
export function hcaiRow(partial) {
  const base = {
    OSHPD_ID: '', FACILITY_NAME: '', LICENSE_NUM: '080000123',
    FACILITY_LEVEL_DESC: 'Parent Facility', DBA_ADDRESS1: '555 Medical Center Dr',
    DBA_CITY: 'San Diego', DBA_ZIP_CODE: '92123', COUNTY_NAME: 'San Diego',
    FACILITY_STATUS_DESC: 'Open', LICENSE_TYPE_DESC: 'General Acute Care Hospital',
    LICENSE_CATEGORY_DESC: 'Hospital',
  };
  return { ...base, ...partial };
}

export const HCAI_ROWS = [
  hcaiRow({ OSHPD_ID: '106370001', FACILITY_NAME: 'Harbor General Hospital' }),
  hcaiRow({ OSHPD_ID: '106370002', FACILITY_NAME: 'Mesa Surgery Center', FACILITY_LEVEL_DESC: 'Consolidated Facility' }),
  hcaiRow({ OSHPD_ID: '106370003', FACILITY_NAME: 'Coastal Hospice Care Inc' }),
  // ── Fuera de condado / cerrada ──
  hcaiRow({ OSHPD_ID: '106370010', FACILITY_NAME: 'Fresno Community Hospital', COUNTY_NAME: 'Fresno' }),
  hcaiRow({ OSHPD_ID: '106370011', FACILITY_NAME: 'Closed Clinic Inc', FACILITY_STATUS_DESC: 'Closed' }),
  hcaiRow({ OSHPD_ID: '106370012', FACILITY_NAME: 'Pending Clinic Inc', FACILITY_STATUS_DESC: 'Pending' }),
  // ── Nivel no institucional ──
  hcaiRow({ OSHPD_ID: '106370020', FACILITY_NAME: 'Satellite Clinic Inc', FACILITY_LEVEL_DESC: 'Satellite Facility' }),
  // ── Nombre de persona ──
  hcaiRow({ OSHPD_ID: '106370030', FACILITY_NAME: 'Patel, Asha' }),
  // ── Sin licencia / dirección incompleta / residencial ──
  hcaiRow({ OSHPD_ID: '106370040', FACILITY_NAME: 'Sin Licencia Clinic Inc', LICENSE_NUM: '' }),
  hcaiRow({ OSHPD_ID: '106370041', FACILITY_NAME: 'Sin Zip Clinic Inc', DBA_ZIP_CODE: '' }),
  hcaiRow({ OSHPD_ID: '106370042', FACILITY_NAME: 'Home Clinic Inc', DBA_ADDRESS1: '12 Private Way Apt 3' }),
];

/**
 * API CKAN simulada.
 * mode: ok | redirectToS3 | successFalse | badJson | throttled | schemaChanged |
 *       resourceRotated | emptyPage
 */
export function createFakeCkanServer({ mode = 'ok', rows = HCAI_ROWS, pageSize = 1000, resourceId = '641c5557-7d65-4379-8fea-6b7dedbda40b' } = {}) {
  const requests = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const sql = url.searchParams.get('sql') || '';
    n++;
    requests.push({ method: req.method, path: url.pathname, sql });

    const json = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (!url.pathname.startsWith('/api/3/action/datastore_search')) {
      return json(404, { success: false, error: { message: 'not found' } });
    }
    if (mode === 'throttled' && n === 1) {
      res.writeHead(429, { 'Retry-After': '1' });
      return res.end();
    }
    if (mode === 'redirectToS3') {
      res.writeHead(302, { Location: 'https://s3.amazonaws.com/ca-open-data/facilities.csv' });
      return res.end();
    }
    if (mode === 'successFalse') return json(200, { success: false, error: { __type: 'Validation Error', message: 'bad sql' } });
    if (mode === 'badJson') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{ roto');
    }

    const limit = Number((sql.match(/LIMIT (\d+)/) || [])[1] || pageSize);
    const offset = Number((sql.match(/OFFSET (\d+)/) || [])[1] || 0);
    if (mode === 'emptyPage') return json(200, { success: true, result: { records: [], fields: [] } });

    const pedidos = [...sql.matchAll(/"([A-Z_0-9]+)"/g)].map((m2) => m2[1])
      .filter((f) => f !== resourceId);
    // Se respeta el LIMIT pedido: el DataStore real lo hace, y un fixture que
    // devuelve menos de lo pedido le dice al cliente "esta era la última página"
    // cuando no lo era. `pageSize` solo actúa como máximo del servidor.
    const tope = Math.min(limit, pageSize);
    const page = rows.slice(offset, offset + tope);
    const records = page.map((r) => {
      const o = {};
      for (const f of pedidos) if (f in r) o[f] = r[f];
      if (mode === 'schemaChanged') { delete o.LICENSE_NUM; o.LATITUDE = 32.715711; }
      return o;
    });
    const fields = (mode === 'schemaChanged'
      ? pedidos.filter((f) => f !== 'LICENSE_NUM').concat('LATITUDE')
      : pedidos).map((id) => ({ id }));

    return json(200, { success: true, result: { records, fields } });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      requests,
      sqlEndpoint: `http://127.0.0.1:${server.address().port}/api/3/action/datastore_search_sql`,
      close: () => server.close(),
    }));
  });
}
