/**
 * Detector de CRM.
 *
 * Dada la URL de un CRM, averigua cuál es sin credenciales: cada producto deja
 * huellas reconocibles en su HTML y en rutas que responden aunque rechacen la
 * petición. Un 401 en la ruta correcta identifica tanto como un 200.
 *
 * Sirve para cuando sabes que hay un CRM instalado pero no cuál.
 */

const TIMEOUT_MS = 10000;

/**
 * Sondas en orden de coste: primero la portada (una sola petición que suele
 * bastar), después rutas específicas de cada producto.
 */
export const PROBES = [
  {
    crm: 'espocrm',
    label: 'EspoCRM',
    path: '/api/v1/App/user',
    // Sin credenciales responde 401 con cuerpo JSON de Espo, y eso ya lo delata.
    match: ({ status, headers, body }) =>
      (status === 401 || status === 403) && /espo/i.test(headers['x-status-reason'] || headers.server || body || '')
      || /"(messageTranslation|userData)"/.test(body || '')
      || status === 200 && /"user"\s*:/.test(body || ''),
    confidence: 0.9,
  },
  {
    crm: 'espocrm',
    label: 'EspoCRM',
    path: '/',
    match: ({ body }) => /client\/(lib|css)\/espo|data-name="espo"|EspoCRM/i.test(body || ''),
    confidence: 0.85,
  },
  {
    crm: 'suitecrm',
    label: 'SuiteCRM',
    path: '/Api/V8/meta/swagger.json',
    match: ({ status, body }) => status < 500 && /suitecrm|"openapi"|"swagger"/i.test(body || ''),
    confidence: 0.9,
  },
  {
    crm: 'suitecrm',
    label: 'SuiteCRM',
    path: '/',
    match: ({ body }) => /SuiteCRM|SugarCRM|index\.php\?module=Users&action=Login/i.test(body || ''),
    confidence: 0.8,
  },
  {
    crm: 'vtiger',
    label: 'Vtiger',
    path: '/webservice.php?operation=getchallenge&username=probe',
    match: ({ body }) => /"success"\s*:|"token"|vtiger/i.test(body || ''),
    confidence: 0.9,
  },
  {
    crm: 'perfex',
    label: 'Perfex CRM',
    path: '/admin/authentication',
    match: ({ status, body }) => status < 500 && /perfex|authentication\/login/i.test(body || ''),
    confidence: 0.85,
  },
  {
    crm: 'odoo',
    label: 'Odoo',
    path: '/web/webclient/version_info',
    match: ({ body }) => /server_version|"odoo"/i.test(body || ''),
    confidence: 0.9,
  },
  {
    crm: 'hubspot',
    label: 'HubSpot',
    path: '/',
    match: ({ body, url }) => /hubspot/i.test(url || '') || /hubspot/i.test(body || ''),
    confidence: 0.6,
  },
];

/** Cliente HTTP por defecto: tolerante, porque un 401 también es información. */
async function defaultProbe(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'CaliCleanCRMDetect/1.0', Accept: '*/*' },
      signal: controller.signal,
    });
    const headers = Object.fromEntries([...res.headers].map(([k, v]) => [k.toLowerCase(), v]));
    // Basta con el principio del cuerpo: las huellas están arriba.
    const body = (await res.text()).slice(0, 40_000);
    return { ok: true, status: res.status, headers, body, url: res.url || url };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'timeout' : err.message, status: 0, headers: {}, body: '' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Construye la URL de una sonda respetando el subdirectorio de la base.
 * Es habitual instalar el CRM en `midominio.com/crm/`, y una ruta absoluta se
 * comería ese prefijo y sondearía el sitio equivocado.
 */
export function probeUrl(base, probePath) {
  const prefix = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  const root = new URL(prefix, base);
  return new URL(probePath.replace(/^\//, ''), root).toString();
}

/**
 * Prueba las sondas contra la URL base y devuelve los candidatos ordenados por
 * confianza. `probe` se inyecta en las pruebas.
 */
export async function detectCrm(baseUrl, { probe = defaultProbe } = {}) {
  let base;
  try {
    base = new URL(baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`);
  } catch {
    return { ok: false, error: 'url_invalida', candidates: [] };
  }

  const seen = new Map();
  const attempts = [];
  // Varias sondas miran la portada: se pide una sola vez.
  const fetched = new Map();

  for (const p of PROBES) {
    // Si un CRM ya se identificó con alta confianza, no se insiste con él.
    if ((seen.get(p.crm) || 0) >= 0.85) continue;

    const url = probeUrl(base, p.path);
    if (!fetched.has(url)) fetched.set(url, await probe(url));
    const res = fetched.get(url);
    attempts.push({ crm: p.crm, url, status: res.status, reachable: res.ok, error: res.error });
    if (!res.ok) continue;

    let matched = false;
    try { matched = Boolean(p.match({ ...res, url })); } catch { matched = false; }
    if (matched && (seen.get(p.crm) || 0) < p.confidence) {
      seen.set(p.crm, p.confidence);
    }
  }

  const candidates = [...seen.entries()]
    .map(([crm, confidence]) => ({ crm, label: PROBES.find((p) => p.crm === crm).label, confidence }))
    .sort((a, b) => b.confidence - a.confidence);

  const anyReachable = attempts.some((a) => a.reachable);
  return {
    ok: candidates.length > 0,
    reachable: anyReachable,
    error: anyReachable ? (candidates.length ? null : 'crm_no_reconocido') : 'servidor_inalcanzable',
    candidates,
    attempts,
  };
}

export default detectCrm;
