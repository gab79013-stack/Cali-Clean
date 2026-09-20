import http from 'node:http';

/**
 * Servidores que imitan las respuestas de cada CRM: las huellas que usa el
 * detector y los endpoints de creación de leads que usan los adaptadores.
 *
 * Son respuestas simuladas a partir de la forma documentada de cada API, no
 * instalaciones reales.
 */

export const CREATED = { calls: [] };

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
const html = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'text/html' });
  res.end(body);
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return Object.fromEntries(new URLSearchParams(raw)); }
}

/** Cada CRM se sirve bajo su propio prefijo: /espocrm, /suitecrm, … */
const HANDLERS = {
  espocrm(req, res, path, body, headers) {
    if (path === '/api/v1/App/user') {
      if (headers['x-api-key'] !== 'ESPO-KEY') {
        res.writeHead(401, { 'Content-Type': 'application/json', 'X-Status-Reason': 'Espo: auth required' });
        return res.end('{"messageTranslation":null}');
      }
      return json(res, 200, { user: { id: '1', userName: 'api' } });
    }
    if (path === '/api/v1/Lead' && req.method === 'POST') {
      if (headers['x-api-key'] !== 'ESPO-KEY') return json(res, 403, { message: 'Forbidden' });
      CREATED.calls.push({ crm: 'espocrm', body });
      return json(res, 200, { id: 'espo-lead-77', ...body });
    }
    if (path === '/') return html(res, 200, '<html><head><link href="client/css/espo/espo.css"></head><body>EspoCRM</body></html>');
    return json(res, 404, { message: 'not found' });
  },

  suitecrm(req, res, path, body, headers) {
    if (path === '/Api/V8/meta/swagger.json') {
      return json(res, 200, { openapi: '3.0.0', info: { title: 'SuiteCRM API' } });
    }
    if (path === '/Api/access_token' && req.method === 'POST') {
      if (body.client_id !== 'SUITE-ID' || body.client_secret !== 'SUITE-SECRET') {
        return json(res, 401, { error: 'invalid_client' });
      }
      return json(res, 200, { access_token: 'suite-token-abc', token_type: 'Bearer', expires_in: 3600 });
    }
    if (path === '/Api/V8/module' && req.method === 'POST') {
      if (headers.authorization !== 'Bearer suite-token-abc') return json(res, 401, { error: 'unauthorized' });
      CREATED.calls.push({ crm: 'suitecrm', body });
      return json(res, 201, { data: { type: 'Leads', id: 'suite-lead-88', attributes: body?.data?.attributes } });
    }
    if (path === '/') return html(res, 200, '<html><body>SuiteCRM login</body></html>');
    return json(res, 404, {});
  },

  perfex(req, res, path, body, headers) {
    if (path === '/admin/authentication') return html(res, 200, '<html><body>Perfex CRM authentication/login</body></html>');
    if (path === '/api/leads' && req.method === 'POST') {
      if (headers.authtoken !== 'PERFEX-TOKEN') return json(res, 401, { status: false });
      CREATED.calls.push({ crm: 'perfex', body });
      return json(res, 200, { status: true, message: 'Lead added successfully', id: 'perfex-lead-99' });
    }
    return json(res, 404, {});
  },

  vtiger(req, res, path, body, headers, query) {
    if (path === '/webservice.php' && query.get('operation') === 'getchallenge') {
      return json(res, 200, { success: true, result: { token: 'vt-challenge-1', serverTime: 1 } });
    }
    if (path === '/webservice.php' && req.method === 'POST') {
      if (body.operation === 'login') {
        return json(res, 200, { success: true, result: { sessionName: 'vt-session-1', userId: '19x1' } });
      }
      if (body.operation === 'create') {
        CREATED.calls.push({ crm: 'vtiger', body: JSON.parse(body.element) });
        return json(res, 200, { success: true, result: { id: '10x123' } });
      }
    }
    return json(res, 404, {});
  },

  odoo(req, res, path) {
    if (path === '/web/webclient/version_info') {
      return json(res, 200, { result: { server_version: '17.0', server_serie: '17.0' } });
    }
    return json(res, 404, {});
  },

  // Un servidor que responde pero no es ningún CRM conocido.
  desconocido(req, res) {
    return html(res, 200, '<html><body>Panel interno de la empresa</body></html>');
  },

  // Receptor de webhook genérico, para el adaptador por defecto.
  webhook(req, res, path, body, headers) {
    if (req.method === 'POST') {
      CREATED.calls.push({ crm: 'webhook', body, signature: headers['x-caliclean-signature'] });
      return json(res, 200, { id: 'wh-1', received: true });
    }
    return json(res, 404, {});
  },
};

export function createFakeCrmServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const [, prefix, ...rest] = url.pathname.split('/');
    const handler = HANDLERS[prefix];
    if (!handler) return json(res, 404, { error: 'unknown crm prefix' });

    const path = `/${rest.join('/')}`;
    const body = await readBody(req);
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]));
    try {
      await handler(req, res, path, body, headers, url.searchParams);
    } catch (err) {
      json(res, 500, { error: String(err.message) });
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}
