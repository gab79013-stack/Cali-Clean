import http from 'node:http';

/**
 * Servidor de pruebas: imita los portales de datos abiertos de San Diego y las
 * webs públicas de los prospectos, incluido un robots.txt que prohíbe una de
 * ellas. Permite ejercitar el pipeline completo sin tocar un servidor real.
 *
 * Las columnas son las que declara el catálogo como candidatas, para que el
 * mapeo se pruebe con los nombres que se esperan de verdad.
 */

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 19);

export const PERMIT_ROWS = [
  {
    approval_id: 'PMT-2026-1001',
    contractor_name: 'Bayside Builders',
    job_address: '2100 Harbor Dr',
    city: 'San Diego',
    zip: '92101',
    date_close: daysAgo(5),
    scope: 'Tenant improvement of 6,200 sqft office suite',
    valuation: '380000',
  },
  {
    approval_id: 'PMT-2026-1002',
    contractor_name: 'Northgate Construction',
    job_address: '221 Spring St',
    city: 'San Diego',
    zip: '92103',
    date_close: daysAgo(60),
    scope: 'New retail shell',
    valuation: '90000',
  },
];

export const BUSINESS_ROWS = [
  {
    account_key: 'B-2001',
    dba_name: 'Harbor View Dental',
    address_full: '1200 Harbor Blvd',
    city: 'San Diego',
    zip: '92101',
    naics_code: '621210',
    naics_description: 'Offices of dentists',
    creation_dt: daysAgo(20),
  },
  {
    account_key: 'B-2002',
    dba_name: 'Gaslamp Property Group',
    address_full: '88 Fifth Ave',
    city: 'San Diego',
    zip: '92103',
    naics_code: '531311',
    naics_description: 'Residential property managers',
    creation_dt: daysAgo(40),
  },
  {
    account_key: 'B-2003',
    dba_name: 'Quiet Books LLC',
    address_full: '5 Nowhere Rd',
    city: 'Fresno',
    zip: '93650',
    naics_code: '511130',
    naics_description: 'Book publishers',
    creation_dt: daysAgo(10),
  },
  {
    account_key: 'B-2004',
    dba_name: 'Taqueria El Faro',
    address_full: '990 Main St',
    city: 'San Diego',
    zip: '92113',
    naics_code: '722511',
    naics_description: 'Full-service restaurants',
    creation_dt: daysAgo(15),
  },
];

/** Webs simuladas de los prospectos, indexadas por host. */
const SITES = {
  'harborviewdental.com': {
    robots: 'User-agent: *\nDisallow: /admin\n',
    pages: {
      '/': `<html><head><title>Harbor View Dental</title></head><body>
        <h1>Harbor View Dental</h1>
        <p>Family dentistry at 1200 Harbor Blvd, San Diego, CA 92101.</p>
        <p>Call us: (619) 555-0142</p>
        <a href="/contact">Contact</a></body></html>`,
      '/contact': `<html><body><h1>Contact Harbor View Dental</h1>
        <p>Email: <a href="mailto:front.desk@harborviewdental.com">front.desk@harborviewdental.com</a></p>
        <p>Billing: billing@harborviewdental.com</p>
        <p>Careers: jobs@harborviewdental.com</p>
        <p>1200 Harbor Blvd, San Diego, CA 92101 · (619) 555-0142</p></body></html>`,
    },
  },
  'gaslamppropertygroup.com': {
    // Este sitio prohíbe el rastreo: el agente debe respetarlo y descartarlo.
    robots: 'User-agent: *\nDisallow: /\n',
    pages: {
      '/': '<html><body><h1>Gaslamp Property Group</h1><p>info@gaslamppropertygroup.com</p></body></html>',
    },
  },
  'taqueriaelfaro.com': {
    robots: 'User-agent: *\nCrawl-delay: 0\nDisallow: /kitchen\n',
    pages: {
      // Sin correo en ninguna página: debe rechazarse por no_public_email.
      '/': `<html><body><h1>Taqueria El Faro</h1>
        <p>990 Main St, San Diego 92113</p><a href="/contact">Contacto</a></body></html>`,
      '/contact': '<html><body><h1>Taqueria El Faro</h1><p>Llámanos: (619) 555-0199</p></body></html>',
    },
  },
  'baysidebuilders.com': {
    robots: '',
    pages: {
      '/': `<html><body><h1>Bayside Builders</h1>
        <p>Commercial construction · 2100 Harbor Dr, San Diego CA 92101</p>
        <p>Contact: <a href="mailto:hello@baysidebuilders.com">hello@baysidebuilders.com</a></p>
        <p>(619) 555-0177</p></body></html>`,
    },
  },
  // Sitio que existe pero pertenece a otro negocio: la verificación debe fallar.
  'quietbooks.com': {
    robots: '',
    pages: { '/': '<html><body><h1>Quiet Books of Vermont</h1><p>orders@quietbooks.com</p></body></html>' },
  },
};

export function createFakeServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const send = (code, body, type = 'text/html') => {
      res.writeHead(code, { 'Content-Type': type });
      res.end(body);
    };

    // ── Portal de datos abiertos simulado ──
    if (url.pathname.startsWith('/resource/')) {
      const dataset = url.pathname.split('/')[2].replace('.json', '');
      const where = url.searchParams.get('$where') || '';
      const limit = Number(url.searchParams.get('$limit') || 50);
      let rows = dataset === 'development-permits-set1' ? PERMIT_ROWS
        : dataset === 'business-listings' ? BUSINESS_ROWS : [];

      // Filtro de fecha mínimo, suficiente para comprobar que la query viaja.
      const since = where.match(/> '([^']+)'/)?.[1];
      if (since) {
        const field = dataset === 'development-permits-set1' ? 'date_close' : 'creation_dt';
        rows = rows.filter((r) => r[field] > since);
      }
      return send(200, JSON.stringify(rows.slice(0, limit)), 'application/json');
    }

    // ── Webs de prospectos, enrutadas por el host solicitado ──
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0];
    const site = SITES[host.replace(/^www\./, '')];
    if (!site) return send(404, 'not found');

    if (url.pathname === '/robots.txt') return send(site.robots ? 200 : 404, site.robots || '', 'text/plain');
    const page = site.pages[url.pathname];
    if (!page) return send(404, 'not found');
    return send(200, page);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

export const FAKE_SITE_HOSTS = Object.keys(SITES);
