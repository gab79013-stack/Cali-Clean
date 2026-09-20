import http from 'node:http';

/**
 * Servidor de pruebas: imita un portal Socrata y las webs públicas de los
 * prospectos, incluido un robots.txt que prohíbe una de ellas. Permite ejercitar
 * el pipeline completo sin tocar un solo servidor real.
 */

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 19);

export const PERMIT_ROWS = [
  {
    pcis_permit_no: 'P-1001',
    applicant_business_name: 'Brightline Builders',
    applicant_first_name: 'Dana', applicant_last_name: 'Ruiz',
    address_start: '4820', street_name: 'Wilshire', street_suffix: 'Blvd',
    zip_code: '90010', status: 'CofO Final', status_date: daysAgo(5),
    permit_type: 'Bldg-Alter/Repair', valuation: '380000',
    work_desc_ext: 'Interior remodel of 6,200 sqft office suite',
  },
  {
    pcis_permit_no: 'P-1002',
    applicant_business_name: 'Northgate Construction',
    address_start: '221', street_name: 'Spring', street_suffix: 'St',
    zip_code: '90012', status: 'Permit Finaled', status_date: daysAgo(60),
    permit_type: 'Bldg-New', valuation: '90000',
    work_desc_ext: 'New retail shell',
  },
];

export const BUSINESS_ROWS = [
  {
    location_account: 'B-2001', business_name: 'Sunset Dental Care',
    street_address: '1200 Sunset Blvd', city: 'Los Angeles', zip_code: '90026',
    naics: '621210', primary_naics_description: 'Offices of dentists',
    location_start_date: daysAgo(20),
  },
  {
    location_account: 'B-2002', business_name: 'Harbor Property Group',
    street_address: '88 Harbor Way', city: 'Los Angeles', zip_code: '90012',
    naics: '531311', primary_naics_description: 'Residential property managers',
    location_start_date: daysAgo(40),
  },
  {
    location_account: 'B-2003', business_name: 'Quiet Books LLC',
    street_address: '5 Nowhere Rd', city: 'Fresno', zip_code: '93650',
    naics: '511130', primary_naics_description: 'Book publishers',
    location_start_date: daysAgo(10),
  },
  {
    location_account: 'B-2004', business_name: 'Taqueria El Faro',
    street_address: '990 Main St', city: 'Los Angeles', zip_code: '90012',
    naics: '722511', primary_naics_description: 'Full-service restaurants',
    location_start_date: daysAgo(15),
  },
];

/** Webs simuladas de los prospectos, indexadas por host. */
const SITES = {
  'sunsetdentalcare.com': {
    robots: 'User-agent: *\nDisallow: /admin\n',
    pages: {
      '/': `<html><head><title>Sunset Dental Care</title></head><body>
        <h1>Sunset Dental Care</h1>
        <p>Family dentistry at 1200 Sunset Blvd, Los Angeles, CA 90026.</p>
        <p>Call us: (213) 555-0142</p>
        <a href="/contact">Contact</a></body></html>`,
      '/contact': `<html><body><h1>Contact Sunset Dental Care</h1>
        <p>Email: <a href="mailto:front.desk@sunsetdentalcare.com">front.desk@sunsetdentalcare.com</a></p>
        <p>Billing: billing@sunsetdentalcare.com</p>
        <p>Careers: jobs@sunsetdentalcare.com</p>
        <p>1200 Sunset Blvd, Los Angeles, CA 90026 · (213) 555-0142</p></body></html>`,
    },
  },
  'harborpropertygroup.com': {
    // Este sitio prohíbe el rastreo: el agente debe respetarlo y descartarlo.
    robots: 'User-agent: *\nDisallow: /\n',
    pages: {
      '/': '<html><body><h1>Harbor Property Group</h1><p>info@harborpropertygroup.com</p></body></html>',
    },
  },
  'taqueriaelfaro.com': {
    robots: 'User-agent: *\nCrawl-delay: 0\nDisallow: /kitchen\n',
    pages: {
      // Sin correo en ninguna página: debe rechazarse por no_public_email.
      '/': `<html><body><h1>Taqueria El Faro</h1>
        <p>990 Main St, Los Angeles 90012</p><a href="/contact">Contacto</a></body></html>`,
      '/contact': '<html><body><h1>Taqueria El Faro</h1><p>Llámanos: (213) 555-0199</p></body></html>',
    },
  },
  'brightlinebuilders.com': {
    robots: '',
    pages: {
      '/': `<html><body><h1>Brightline Builders</h1>
        <p>Commercial construction · 4820 Wilshire Blvd, Los Angeles CA 90010</p>
        <p>Contact: <a href="mailto:hello@brightlinebuilders.com">hello@brightlinebuilders.com</a></p>
        <p>(213) 555-0177</p></body></html>`,
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

    // ── Portal Socrata simulado ──
    if (url.pathname.startsWith('/resource/')) {
      const dataset = url.pathname.split('/')[2].replace('.json', '');
      const where = url.searchParams.get('$where') || '';
      const limit = Number(url.searchParams.get('$limit') || 50);
      let rows = dataset === 'yv23-pmwf' ? PERMIT_ROWS : dataset === '6rrh-rzua' ? BUSINESS_ROWS : [];

      // Filtro de fecha mínimo, suficiente para comprobar que la query viaja.
      const since = where.match(/> '([^']+)'/)?.[1];
      if (since) {
        const field = dataset === 'yv23-pmwf' ? 'status_date' : 'location_start_date';
        rows = rows.filter((r) => r[field] > since);
      }
      if (/like '%FINAL%'/i.test(where)) {
        rows = rows.filter((r) => /final/i.test(r.status || ''));
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
