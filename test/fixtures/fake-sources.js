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

/**
 * Filas del portal de San Diego, que publica CSV plano en vez de Socrata.
 * Incluye a propósito casos que deben caer fuera: un negocio de Los Ángeles,
 * uno de Borrego Springs (ZIP del condado pero a 75 millas) y uno antiguo.
 */
export const SD_BUSINESS_ROWS = [
  {
    account_key: 'SD-3001', dba_name: 'Gaslamp Dental Studio',
    ownership_name: 'Nguyen Tran', address_no: '410', address_road: 'Fifth', address_sfx: 'Ave',
    address_city: 'San Diego', address_zip: '92101', business_phone: '6195550188',
    naics_code: '621210', naics_description: 'Offices of dentists',
    date_business_start: daysAgo(25),
  },
  {
    account_key: 'SD-3002', dba_name: 'Bayview Property Management',
    ownership_name: '', address_no: '77', address_road: 'Bay', address_sfx: 'Blvd',
    address_city: 'Chula Vista', address_zip: '91910', business_phone: '6195550233',
    naics_code: '531311', naics_description: 'Residential property managers',
    date_business_start: daysAgo(48),
  },
  {
    account_key: 'SD-3003', dba_name: 'Oceanside Taco House',
    address_no: '15', address_road: 'Coast', address_sfx: 'Hwy',
    address_city: 'Oceanside', address_zip: '92054', business_phone: '7605550101',
    naics_code: '722511', naics_description: 'Full-service restaurants',
    date_business_start: daysAgo(12),
  },
  {
    // Fuera del área: Los Ángeles. Debe descartarse por el filtro geográfico.
    account_key: 'SD-3004', dba_name: 'Wilshire Med Offices',
    address_no: '900', address_road: 'Wilshire', address_sfx: 'Blvd',
    address_city: 'Los Angeles', address_zip: '90010', business_phone: '2135550111',
    naics_code: '621210', naics_description: 'Offices of dentists',
    date_business_start: daysAgo(9),
  },
  {
    // ZIP del condado de San Diego, pero a 75 millas: fuera del radio.
    account_key: 'SD-3005', dba_name: 'Borrego Desert Clinic',
    address_no: '3', address_road: 'Palm Canyon', address_sfx: 'Dr',
    address_city: 'Borrego Springs', address_zip: '92004', business_phone: '7605550777',
    naics_code: '621210', naics_description: 'Offices of dentists',
    date_business_start: daysAgo(11),
  },
  {
    // Demasiado antiguo: fuera de la ventana de tiempo.
    account_key: 'SD-3006', dba_name: 'Old Town Antiques',
    address_no: '2', address_road: 'San Diego', address_sfx: 'Ave',
    address_city: 'San Diego', address_zip: '92110', business_phone: '6195550999',
    naics_code: '722511', naics_description: 'Full-service restaurants',
    date_business_start: daysAgo(4000),
  },
];

/** Webs de los negocios de San Diego. */
const SD_SITES = {
  'gaslampdentalstudio.com': {
    robots: '',
    pages: {
      '/': `<html><body><h1>Gaslamp Dental Studio</h1>
        <p>410 Fifth Ave, San Diego, CA 92101</p><p>(619) 555-0188</p>
        <a href="/contact">Contact</a></body></html>`,
      '/contact': `<html><body><h1>Gaslamp Dental Studio</h1>
        <p><a href="mailto:office@gaslampdentalstudio.com">office@gaslampdentalstudio.com</a></p>
        <p>410 Fifth Ave, San Diego, CA 92101 · (619) 555-0188</p></body></html>`,
    },
  },
  'bayviewpropertymanagement.com': {
    robots: 'User-agent: *\nDisallow: /portal\n',
    pages: {
      '/': `<html><body><h1>Bayview Property Management</h1>
        <p>77 Bay Blvd, Chula Vista, CA 91910 · (619) 555-0233</p>
        <p>Email: <a href="mailto:hello@bayviewpropertymanagement.com">hello@bayviewpropertymanagement.com</a></p>
        </body></html>`,
    },
  },
  'oceansidetacohouse.com': {
    robots: '',
    pages: {
      // Sin correo publicado: debe rechazarse, no inventarse uno.
      '/': `<html><body><h1>Oceanside Taco House</h1>
        <p>15 Coast Hwy, Oceanside CA 92054 · (760) 555-0101</p></body></html>`,
    },
  },
};

/** Convierte filas a CSV, con comillas donde hagan falta. */
function toCsv(rows) {
  const header = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header.join(','), ...rows.map((r) => header.map((h) => cell(r[h])).join(','))].join('\n');
}

/** Cuántas veces se ha descargado el CSV: sirve para comprobar la caché. */
export const counters = { csvDownloads: 0 };

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

    // ── Portal de San Diego: fichero CSV plano ──
    if (url.pathname === '/ttcs/sd_businesses_active_datasd.csv') {
      counters.csvDownloads++;
      return send(200, toCsv(SD_BUSINESS_ROWS), 'text/csv');
    }
    // La misma fuente servida desde otra ruta: la que anuncia el catálogo CKAN
    // cuando la ruta conocida ha caducado.
    if (url.pathname === '/ttcs/moved/sd_businesses_active_datasd.csv') {
      return send(200, toCsv(SD_BUSINESS_ROWS), 'text/csv');
    }

    // ── Catálogo CKAN de San Diego ──
    if (url.pathname === '/api/3/action/package_show') {
      return send(200, JSON.stringify({
        success: true,
        result: {
          id: url.searchParams.get('id'),
          resources: [
            { format: 'PDF', url: 'https://seshat.datasd.org/ttcs/diccionario.pdf' },
            { format: 'CSV', url: 'https://seshat.datasd.org/ttcs/moved/sd_businesses_active_datasd.csv' },
          ],
        },
      }), 'application/json');
    }

    // ── Webs de prospectos, enrutadas por el host solicitado ──
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0];
    const site = { ...SITES, ...SD_SITES }[host.replace(/^www\./, '')];
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

export const FAKE_SITE_HOSTS = [...Object.keys(SITES), ...Object.keys(SD_SITES)];
