import http from 'node:http';

/**
 * Twenty CRM simulado.
 *
 * Registra TODAS las peticiones con su método, para que una prueba pueda
 * afirmar "el dry-run no escribió nada" mirando el registro en vez de
 * confiando en el código que se está probando.
 *
 * Las respuestas imitan la forma real verificada contra la instancia:
 *   { data: { companies: [...] }, totalCount, pageInfo }
 */

export function createFakeTwenty({ seed = [], conflictOnce = false } = {}) {
  const requests = [];
  const companies = seed.map((c) => ({ ...c }));
  let nextId = companies.length + 1;
  let conflictArmed = conflictOnce;

  const json = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = { raw }; }

    requests.push({
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
      // Se guarda solo la PRESENCIA de la cabecera, nunca su valor: este
      // fixture no debe convertirse en el sitio donde se filtra un secreto.
      hadAuthHeader: Boolean(req.headers.authorization),
    });

    const m = url.pathname.match(/^\/rest\/companies(?:\/([^/]+))?$/i);
    if (!m) return json(res, 404, { statusCode: 404, messages: ['not found'] });
    const id = m[1];

    if (req.method === 'GET' && !id) {
      const filter = url.searchParams.get('filter') || '';
      const fm = filter.match(/^dedupKey\[eq\]:(.*)$/);
      const rows = fm ? companies.filter((c) => c.dedupKey === fm[1]) : companies;
      const limit = Number(url.searchParams.get('limit') || 60);
      return json(res, 200, {
        data: { companies: rows.slice(0, limit) },
        totalCount: rows.length,
        pageInfo: { startCursor: '', endCursor: '', hasNextPage: false, hasPreviousPage: false },
      });
    }

    if (req.method === 'POST' && !id) {
      if (conflictArmed) {
        // Alguien creó la misma empresa entre nuestro lookup y nuestro create.
        // Lo hizo con los datos mínimos, que es el caso realista: otra
        // importación o un alta manual. Al volver a consultar habrá que
        // completar lo que falta.
        conflictArmed = false;
        companies.push({ id: `race-${nextId++}`, name: body.name, dedupKey: body.dedupKey });
        return json(res, 409, {
          statusCode: 409, code: 'CONFLICT',
          messages: ['duplicate key value violates unique constraint "dedupKey"'],
        });
      }
      const created = { id: `new-${nextId++}`, ...body };
      companies.push(created);
      return json(res, 201, { data: { createCompany: created } });
    }

    if (req.method === 'PATCH' && id) {
      const idx = companies.findIndex((c) => c.id === id);
      if (idx === -1) return json(res, 404, { statusCode: 404, messages: ['not found'] });
      companies[idx] = { ...companies[idx], ...body };
      return json(res, 200, { data: { updateCompany: companies[idx] } });
    }

    return json(res, 405, { statusCode: 405, messages: ['method not allowed'] });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      port: server.address().port,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      requests,
      companies,
      writes: () => requests.filter((r) => r.method !== 'GET'),
      reset: () => { requests.length = 0; },
    }));
  });
}

/** Una empresa ya existente, con la forma exacta que devuelve la API real. */
export const EXISTING_COMPANY = {
  id: '06290608-8bf0-4806-99ae-a715a6a93fad',
  name: 'Harbor View Dental',
  dedupKey: 'harborviewdental.com',
  serviceArea: 'San Diego County, CA',
  leadStage: 'QUALIFIED',
  leadScore: 'RATING_3',
  leadSource: 'PUBLIC_WEBSITE',
  contactabilityStatus: 'NO_VERIFIED_CHANNEL',
  lastVerified: null,
  domainName: { primaryLinkLabel: '', primaryLinkUrl: 'https://harborviewdental.com', secondaryLinks: [] },
  sourceUrl: { primaryLinkLabel: '', primaryLinkUrl: '', secondaryLinks: [] },
  businessEmail: { primaryEmail: '', additionalEmails: [] },
  accountOwnerId: 'owner-uuid-existente',
};
