import http from 'node:http';

/**
 * Servidor de pruebas: imita la API SODA del condado de San Diego y las webs
 * públicas de los prospectos, incluido un robots.txt que prohíbe una de ellas.
 *
 * Tres decisiones deliberadas del fixture:
 *
 *   · Las columnas y los VALORES son los reales del dataset c5ez-ufrd,
 *     comprobados el 2026-10-04: `permit_status` es 'Issued' o 'Permit Renewed'
 *     ('Expired' en las inactivas) y `active_permit` es 'A' en todas, también
 *     en las expiradas. La auditoría del 2026-10-03 había supuesto 'Active'/'Y',
 *     y una prueba que corre contra valores que el portal no usa no prueba nada.
 *   · La mayoría de filas NO traen `record_open_date` ni `record_issue_date`,
 *     porque esas columnas están vacías en las 15 906 filas reales. Una sí las
 *     trae, para que el camino del permiso recién emitido siga cubierto.
 *   · El servidor IGNORA el $select y devuelve también los campos prohibidos.
 *     Simula un servidor que entrega de más, y así las pruebas comprueban que
 *     el filtrado del cliente es una segunda red real y no decoración.
 */

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 19);

/** Filas del dataset de permisos de alimentación, con datos personales incluidos. */
export const FOOD_FACILITY_ROWS = [
  {
    record_id: 'FA-2026-1001',
    record_name: 'Harbor View Dental',
    // La única con fechas: el dataset real las tiene vacías, pero el camino del
    // permiso recién emitido tiene que seguir cubierto por alguna fila.
    record_open_date: daysAgo(20),
    record_issue_date: daysAgo(18),
    permit_status: 'Issued',
    active_permit: 'A',
    business_type: 'Dental office cafeteria',
    address: '1200 Harbor Blvd',
    city: 'San Diego',
    state: 'CA',
    zip: '92101',
    last_updated: daysAgo(2),
    // Campos prohibidos que el servidor devuelve pese al $select.
    permit_owner_full: 'Ana Lucía Fernández',
    permit_owner: 'A. Fernández',
    permit_owner_email: 'ana.personal@ejemplo.com',
    latitude: 32.7157,
    longitude: -117.1611,
  },
  {
    record_id: 'FA-2026-1002',
    record_name: 'Gaslamp Property Group',
    permit_status: 'Permit Renewed',
    active_permit: 'A',
    business_type: 'Property management office kitchen',
    address: '88 Fifth Ave',
    city: 'San Diego',
    state: 'CA',
    zip: '92103',
    last_updated: daysAgo(5),
    permit_owner_full: 'Carlos Méndez',
    permit_owner_email: 'carlos.personal@ejemplo.com',
    latitude: 32.7201,
    longitude: -117.1599,
  },
  {
    record_id: 'FA-2026-1003',
    record_name: 'Quiet Books LLC',
    permit_status: 'Permit Renewed',
    active_permit: 'A',
    business_type: 'Other',
    address: '5 Nowhere Rd',
    city: 'Fresno',
    state: 'CA',
    zip: '93650',
    last_updated: daysAgo(1),
    permit_owner_full: 'Persona Fuera De Area',
    latitude: 36.78,
    longitude: -119.79,
  },
  {
    record_id: 'FA-2026-1004',
    record_name: 'Taquería El Faro',
    permit_status: 'Permit Renewed',
    active_permit: 'A',
    business_type: 'Restaurant',
    address: '990 Main St',
    city: 'San Diego',
    state: 'CA',
    zip: '92113',
    last_updated: daysAgo(3),
    permit_owner_full: 'José Ramón Ortega',
    permit_owner_email: 'jose.personal@ejemplo.com',
    latitude: 32.6901,
    longitude: -117.1211,
  },
  {
    record_id: 'FA-2026-1005',
    record_name: 'Bayside Builders',
    permit_status: 'Permit Renewed',
    active_permit: 'A',
    business_type: 'Construction site canteen',
    address: '2100 Harbor Dr',
    city: 'San Diego',
    state: 'CA',
    zip: '92101',
    last_updated: daysAgo(1),
    permit_owner_full: 'Dana Ruiz',
    latitude: 32.7055,
    longitude: -117.1689,
  },
  {
    // Expirada, y con active_permit 'A' igual que las activas: así es el
    // dataset real. Si el filtro mirara solo la bandera, esta pasaría.
    record_id: 'FA-2026-1006',
    record_name: 'Old Harbor Cantina',
    permit_status: 'Expired',
    active_permit: 'A',
    business_type: 'Restaurant Food Facility',
    address: '7 Closed St',
    city: 'San Diego',
    state: 'CA',
    zip: '92101',
    last_updated: daysAgo(4),
    permit_owner_full: 'Titular Expirado',
  },
  {
    // Nombre con forma de persona y sin palabra de negocio: no se puede
    // afirmar que sea una empresa, así que se omite.
    record_id: 'FA-2026-1007',
    record_name: 'Salazar, Ramón',
    permit_status: 'Issued',
    active_permit: 'A',
    business_type: 'Caterer',
    address: '19 Unknown Ave',
    city: 'San Diego',
    state: 'CA',
    zip: '92103',
    last_updated: daysAgo(6),
  },
];

/** Todo valor personal que no debe sobrevivir al pipeline. */
export const DATOS_PROHIBIDOS = [
  'Ana Lucía Fernández', 'A. Fernández', 'ana.personal@ejemplo.com',
  'Carlos Méndez', 'carlos.personal@ejemplo.com', 'Persona Fuera De Area',
  'José Ramón Ortega', 'jose.personal@ejemplo.com', 'Dana Ruiz',
  'permit_owner', 'latitude', 'longitude',
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
    // Prohíbe el rastreo: el agente debe respetarlo y descartar el prospecto.
    robots: 'User-agent: *\nDisallow: /\n',
    pages: {
      '/': '<html><body><h1>Gaslamp Property Group</h1><p>info@gaslamppropertygroup.com</p></body></html>',
    },
  },
  'taqueriaelfaro.com': {
    robots: 'User-agent: *\nCrawl-delay: 0\nDisallow: /kitchen\n',
    pages: {
      // Sin correo en ninguna página: debe rechazarse por no_public_email.
      '/': `<html><body><h1>Taquería El Faro</h1>
        <p>990 Main St, San Diego 92113</p><a href="/contact">Contacto</a></body></html>`,
      '/contact': '<html><body><h1>Taquería El Faro</h1><p>Llámanos: (619) 555-0199</p></body></html>',
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
  // Existe pero pertenece a otro negocio: la verificación debe fallar.
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

    // ── API SODA simulada ──
    if (url.pathname.startsWith('/resource/')) {
      const dataset = url.pathname.split('/')[2].replace('.json', '');
      if (dataset !== 'c5ez-ufrd') return send(404, '{"error":"dataset desconocido"}', 'application/json');

      const where = url.searchParams.get('$where') || '';
      const order = url.searchParams.get('$order') || '';
      const limit = Number(url.searchParams.get('$limit') || 50);
      let rows = FOOD_FACILITY_ROWS.slice();

      // El servidor aplica el $where de verdad, igual que SODA: si el cliente
      // pide solo permisos activos, aquí no llegan las expiradas. Así las
      // pruebas distinguen lo que filtra el servidor de lo que filtra el
      // cliente, que es la diferencia entre una capa y dos.
      const activeFlag = where.match(/active_permit\s*=\s*'([^']*)'/)?.[1];
      if (activeFlag) rows = rows.filter((r) => r.active_permit === activeFlag);

      const statusIn = where.match(/permit_status\s+in\s*\(([^)]*)\)/i)?.[1];
      if (statusIn) {
        const allowed = statusIn.split(',').map((v) => v.trim().replace(/^'|'$/g, ''));
        rows = rows.filter((r) => allowed.includes(r.permit_status));
      }

      // Cursor: record_id < 'valor'. Es el recorrido incremental.
      const cursor = where.match(/record_id\s*<\s*'([^']*)'/)?.[1];
      if (cursor) rows = rows.filter((r) => String(r.record_id) < cursor);

      // Ventana de fecha, para las pruebas que todavía la usan.
      const since = where.match(/record_open_date\s*>\s*'([^']+)'/)?.[1];
      if (since) rows = rows.filter((r) => (r.record_open_date || '') > since);

      if (/record_id DESC/i.test(order)) {
        rows.sort((a, b) => String(b.record_id).localeCompare(String(a.record_id)));
      }

      // A propósito: se ignora el $select y se devuelven TODAS las columnas,
      // campos personales incluidos. El cliente tiene que filtrarlos.
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
