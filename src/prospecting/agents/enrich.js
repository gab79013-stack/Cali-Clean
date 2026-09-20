import dns from 'node:dns/promises';
import { config } from '../../config.js';
import { db } from '../../db.js';
import { politeFetch } from '../http.js';
import { findPlace, corroborates, isEnabled as placesEnabled } from '../places.js';

/**
 * Agente enriquecedor.
 *
 * Un registro público da nombre y dirección, nunca un email. Este agente busca
 * el sitio del negocio, lo visita respetando robots.txt y saca de ahí el correo
 * que el propio negocio publica. No inventa direcciones ni prueba patrones tipo
 * "info@" a ciegas: un email adivinado rebota, y los rebotes queman el dominio.
 */

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(?:\+?1[-.\s]?)?\(?([2-9]\d{2})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})/;

// Correos que aparecen en las plantillas de las webs y no son del negocio.
const JUNK_EMAIL = /^(example|test|your|email|name|user|sentry|wixpress|sample|no-?reply|donotreply)@|@(example|sentry|wix|squarespace|godaddy|shopify|wordpress|gmail\.example)\./i;
// Páginas donde suele estar el contacto real.
const CONTACT_PATHS = ['/contact', '/contact-us', '/contacto', '/about', '/about-us'];

const stripAccents = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Candidatos de dominio a partir del nombre del negocio. */
export function domainCandidates(businessName) {
  const base = stripAccents(businessName)
    .replace(/\b(inc|llc|l\.l\.c|corp|corporation|co|company|ltd|the|and|&)\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim();
  if (!base) return [];

  const words = base.split(/\s+/).filter(Boolean);
  if (!words.length) return [];

  const joined = words.join('');
  const hyphen = words.join('-');
  const firstTwo = words.slice(0, 2).join('');

  const names = [...new Set([joined, hyphen, firstTwo].filter((n) => n.length >= 4 && n.length <= 40))];
  const tlds = ['.com', '.net'];
  const out = [];
  for (const n of names) for (const tld of tlds) out.push(`${n}${tld}`);
  return out.slice(0, 6);
}

/** ¿La página que encontramos es realmente la de este negocio? */
export function verifyMatch(html, { businessName, phone, zip, address }) {
  const text = stripAccents(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
  const evidence = [];

  const words = stripAccents(businessName).split(/\s+/).filter((w) => w.length > 3);
  const nameHits = words.filter((w) => text.includes(w)).length;
  if (words.length && nameHits / words.length >= 0.6) evidence.push('name');

  const digits = String(phone || '').replace(/\D/g, '').slice(-10);
  if (digits.length === 10) {
    const pageDigits = text.replace(/\D/g, '');
    if (pageDigits.includes(digits)) evidence.push('phone');
  }
  if (zip && text.includes(String(zip).slice(0, 5))) evidence.push('zip');

  const streetNumber = String(address || '').match(/^\d+/)?.[0];
  if (streetNumber && streetNumber.length >= 3 && text.includes(streetNumber)) evidence.push('address');

  // Una sola coincidencia puede ser casualidad; dos ya no lo son.
  return { matched: evidence.length >= 2 || evidence.includes('phone'), evidence };
}

export function extractEmails(html, domain) {
  const found = new Set();
  // El mailto: es intención declarada; el texto suelto puede ser de un tercero.
  for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) found.add(m[1].toLowerCase());
  for (const m of html.matchAll(EMAIL_RE)) found.add(m[0].toLowerCase());

  const clean = [...found]
    .map((e) => e.replace(/[.,;:]+$/, ''))
    .filter((e) => e.length < 80 && !JUNK_EMAIL.test(e))
    .filter((e) => !/\.(png|jpe?g|gif|webp|svg|css|js)$/i.test(e));

  // Prioridad: mismo dominio que la web > buzón de contacto > el resto.
  const rank = (e) => {
    const d = e.split('@')[1] || '';
    let score = 0;
    if (domain && d.replace(/^www\./, '') === domain.replace(/^www\./, '')) score += 10;
    if (/^(info|hello|contact|admin|office|hola|contacto|ventas|sales)@/.test(e)) score += 4;
    if (/^(support|help|jobs|careers|privacy|legal|press|media)@/.test(e)) score -= 3;
    return score;
  };
  return clean.sort((a, b) => rank(b) - rank(a));
}

export function extractPhone(html) {
  const text = html.replace(/<[^>]+>/g, ' ');
  const m = text.match(PHONE_RE);
  return m ? `+1${m[1]}${m[2]}${m[3]}` : '';
}

/** ¿El dominio resuelve? Evita gastar una petición HTTP en cada invento. */
async function domainResolves(domain) {
  try {
    await dns.resolve4(domain);
    return true;
  } catch {
    try {
      await dns.resolveCname(domain);
      return true;
    } catch { return false; }
  }
}

/**
 * Busca el sitio del prospecto probando dominios derivados de su nombre y
 * verificando que la página corresponde al negocio.
 */
export async function resolveWebsite(prospect, { skipDns = false } = {}) {
  const candidates = await websiteCandidates(prospect);
  // Se guarda por qué falló cada intento: "el sitio nos prohíbe el paso" y "no
  // encontramos el sitio" son cosas distintas y el panel debe distinguirlas.
  let lastReason = 'website_not_found';

  for (const candidate of candidates) {
    const domain = candidate.url.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    // Un dominio que Places declara existe; solo los adivinados hay que comprobarlos.
    const needsDnsCheck = !skipDns && candidate.from === 'guess';
    if (needsDnsCheck && !(await domainResolves(domain))) continue;

    const url = candidate.url.startsWith('http') ? candidate.url : `https://${domain}`;
    const res = await politeFetch(url);
    if (!res.ok) {
      if (res.reason === 'robots_disallow') lastReason = 'robots_disallow';
      continue;
    }

    const match = verifyMatch(res.html, {
      businessName: prospect.business_name,
      phone: prospect.phone,
      zip: prospect.zip,
      address: prospect.address,
    });

    // Places ya cruzó nombre y dirección. Si además su ficha coincide en
    // teléfono o código postal con nuestro registro, eso vale como una prueba
    // más: una web moderna con poco texto puede no dar dos por sí sola.
    const evidence = [...match.evidence, ...candidate.evidence];
    const matched = match.matched || evidence.length >= 2;
    if (!matched) { lastReason = 'site_not_verified'; continue; }

    return { url: res.url || url, domain, html: res.html, evidence, source: candidate.from };
  }
  return { failed: true, reason: lastReason };
}

/**
 * De dónde sale la web a visitar, en orden de fiabilidad:
 * la que ya tenemos, la que declara Places, y por último las adivinadas a
 * partir del nombre.
 */
async function websiteCandidates(prospect) {
  if (prospect.website) return [{ url: prospect.website, from: 'known', evidence: [] }];

  const out = [];
  if (placesEnabled()) {
    const place = await findPlace({
      businessName: prospect.business_name,
      address: prospect.address,
      city: prospect.city,
      zip: prospect.zip,
    });
    if (place?.website) {
      out.push({
        url: place.website,
        from: 'places',
        evidence: corroborates(place, prospect) ? ['places'] : [],
      });
    }
  }

  const guessed = domainCandidates(prospect.business_name)
    .map((url) => ({ url, from: 'guess', evidence: [] }))
    // Places ya nos llevó ahí: no repetir la visita.
    .filter((c) => !out.some((o) => o.url.includes(c.url.replace(/\.(com|net)$/, ''))));

  return [...out, ...guessed];
}

/** Enriquece un prospecto. Devuelve el estado resultante. */
export async function enrichOne(prospect, opts = {}) {
  const site = await resolveWebsite(prospect, opts);
  if (!site || site.failed) {
    return { stage: 'rejected', reject_reason: site?.reason || 'website_not_found' };
  }

  let emails = extractEmails(site.html, site.domain);
  let phone = prospect.phone || extractPhone(site.html);
  const pagesVisited = [site.url];

  // La home casi nunca tiene el correo; la página de contacto casi siempre sí.
  if (!emails.length) {
    for (const path of CONTACT_PATHS) {
      const res = await politeFetch(new URL(path, site.url).toString());
      if (!res.ok) continue;
      pagesVisited.push(res.url || path);
      emails = extractEmails(res.html, site.domain);
      if (!phone) phone = extractPhone(res.html);
      if (emails.length) break;
    }
  }

  if (!emails.length) {
    return { stage: 'rejected', reject_reason: 'no_public_email', website: site.url, phone };
  }

  return {
    stage: 'enriched',
    website: site.url,
    email: emails[0],
    email_source: 'published_on_website',
    phone,
    evidence: {
      match: site.evidence, pages: pagesVisited, emailsFound: emails.slice(0, 4),
      websiteSource: site.source,
    },
  };
}

/** Procesa el lote de prospectos descubiertos que aún no tienen contacto. */
export async function enrich({ limit, ...opts } = {}) {
  const cap = limit ?? config.prospecting.enrichLimit;
  const rows = db.prepare(
    `SELECT * FROM prospects WHERE stage = 'discovered' ORDER BY created_at LIMIT ?`
  ).all(cap);

  const stats = { processed: 0, enriched: 0, rejected: 0, reasons: {} };

  for (const prospect of rows) {
    stats.processed++;
    let result;
    try {
      result = await enrichOne(prospect, opts);
    } catch (err) {
      result = { stage: 'rejected', reject_reason: `error:${err.message.slice(0, 120)}` };
    }

    const prevEvidence = safeParse(prospect.evidence_json, {});
    db.prepare(
      `UPDATE prospects SET stage=?, reject_reason=?, website=?, email=?, email_source=?,
              phone=COALESCE(NULLIF(?, ''), phone), evidence_json=?, updated_at=datetime('now')
        WHERE id=?`
    ).run(
      result.stage, result.reject_reason || null, result.website || prospect.website || null,
      result.email || null, result.email_source || null, result.phone || '',
      JSON.stringify({ ...prevEvidence, enrich: result.evidence || null }), prospect.id,
    );

    if (result.stage === 'enriched') stats.enriched++;
    else {
      stats.rejected++;
      stats.reasons[result.reject_reason] = (stats.reasons[result.reject_reason] || 0) + 1;
    }
  }
  return stats;
}

const safeParse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };

export default enrich;
