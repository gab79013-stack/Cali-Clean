import express from 'express';
import { config, pricing } from '../config.js';
import { db, logEvent } from '../db.js';
import { calculateQuote } from '../services/quote.js';
import { scoreLead, isInServiceArea } from '../services/scoring.js';
import { enrollLead, processDueSteps } from '../services/sequences.js';
import { notifyTeam } from '../services/mailer.js';
import senderApi from '../services/sender-api.js';
import { clean, validEmail, normalizePhone, validZip, validDate } from '../utils/validate.js';
import { hitRateLimit } from '../utils/ratelimit.js';
import { newUid } from '../utils/tokens.js';
import { pickLocale } from '../templates/i18n.js';

export const router = express.Router();

/** Catálogo y tarifas que consume el widget para pintarse solo. */
router.get('/config', (req, res) => {
  res.json({
    business: {
      name: config.business.name, phone: config.business.phone,
      hours: config.business.hours, site: config.business.site,
      bookingUrl: config.business.bookingUrl,
    },
    pricing: {
      residential: {
        types: Object.keys(pricing.residential.types),
        frequency: Object.fromEntries(Object.entries(pricing.residential.frequency)
          .map(([k, v]) => [k, v.discountLabel])),
        addons: pricing.residential.addons,
      },
      commercial: {
        types: Object.keys(pricing.commercial.types),
        frequency: Object.fromEntries(Object.entries(pricing.commercial.frequency)
          .map(([k, v]) => [k, v.discountLabel])),
        addons: pricing.commercial.addons,
      },
      currency: pricing.currency,
    },
    serviceZips: config.business.zips,
  });
});

/** Presupuesto en vivo: se recalcula en cada paso del wizard, sin pedir email. */
router.post('/quote', (req, res) => {
  const quote = calculateQuote(req.body || {});
  res.json({ ok: true, quote });
});

/** Captura del lead: valida, puntúa, guarda, avisa al equipo y arranca la secuencia. */
router.post('/leads', async (req, res) => {
  const body = req.body || {};

  // Honeypot: campo invisible que solo rellenan los bots. Se responde 200 para
  // no darle al bot la señal de que fue detectado.
  if (clean(body.company_website)) {
    return res.status(202).json({ ok: true, quote: calculateQuote(body), bookingUrl: config.business.bookingUrl });
  }
  // Un envío muy rápido es sospechoso, pero NO se descarta: un lead real
  // perdido cuesta mucho más que revisar un registro dudoso. Se guarda y se
  // marca para que el equipo lo vea en el panel.
  const elapsed = Number(body.form_time_ms || 0);
  const suspiciouslyFast = elapsed > 0 && elapsed < 3000;

  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const limit = hitRateLimit(`lead:${ip}`);
  if (!limit.allowed) {
    return res.status(429).json({ ok: false, error: 'rate_limited', message: 'Demasiadas solicitudes. Inténtalo más tarde.' });
  }

  const emailCheck = validEmail(body.email);
  if (!emailCheck.ok) {
    return res.status(400).json({ ok: false, error: 'invalid_email', field: 'email' });
  }

  const quote = calculateQuote(body);
  const zip = validZip(body.zip);
  const locale = pickLocale(body.locale || req.headers['accept-language']);

  const lead = {
    uid: newUid(),
    name: clean(body.name, 120),
    email: emailCheck.email,
    phone: normalizePhone(body.phone),
    zip,
    address: clean(body.address, 220),
    locale,
    segment: quote.segment,
    service_type: quote.serviceType,
    frequency: quote.frequency,
    bedrooms: body.bedrooms ? Number(body.bedrooms) : null,
    bathrooms: body.bathrooms ? Number(body.bathrooms) : null,
    sqft: body.sqft ? Number(body.sqft) : null,
    addons: JSON.stringify(quote.addons),
    preferred_date: validDate(body.preferred_date),
    message: clean(body.message, 1500),
    quote_price: quote.price,
    quote_low: quote.low,
    quote_high: quote.high,
    annual_value: quote.annualValue,
    quote_json: JSON.stringify(quote),
    source: clean(body.source, 60) || 'widget',
    landing_page: clean(body.landing_page, 400),
    referrer: clean(body.referrer, 400),
    utm_source: clean(body.utm_source, 120),
    utm_medium: clean(body.utm_medium, 120),
    utm_campaign: clean(body.utm_campaign, 160),
    utm_term: clean(body.utm_term, 160),
    utm_content: clean(body.utm_content, 160),
    gclid: clean(body.gclid, 200),
    fbclid: clean(body.fbclid, 200),
    ip,
    user_agent: clean(req.headers['user-agent'], 300),
    in_service_area: isInServiceArea(zip) ? 1 : 0,
  };

  const scored = scoreLead(lead, quote);
  lead.score = scored.score;
  lead.temperature = scored.temperature;
  lead.score_reasons = JSON.stringify(scored.reasons);

  const cols = Object.keys(lead);
  const info = db.prepare(
    `INSERT INTO leads (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`
  ).run(lead);
  lead.id = info.lastInsertRowid;

  logEvent(lead.id, 'lead_created', { score: lead.score, price: quote.price, source: lead.source });
  if (suspiciouslyFast) logEvent(lead.id, 'fast_submit', { form_time_ms: elapsed });

  // El lead ya está guardado: el resto ocurre en segundo plano para que el
  // formulario responda de inmediato aunque el SMTP tarde.
  setImmediate(async () => {
    try {
      enrollLead(lead);
      await processDueSteps({ limit: 5 });      // dispara el email de cotización
      await notifyTeam({ lead, quote });
      if (config.sender.syncSubscribers) {
        try {
          await senderApi.syncSubscriber(lead);
          db.prepare('UPDATE leads SET sender_synced = 1 WHERE id = ?').run(lead.id);
          logEvent(lead.id, 'sender_synced');
        } catch (err) {
          logEvent(lead.id, 'sender_sync_failed', { error: err.message });
        }
      }
    } catch (err) {
      console.error('[lead:post-process]', err);
    }
  });

  res.status(201).json({
    ok: true,
    uid: lead.uid,
    quote,
    bookingUrl: config.business.bookingUrl,
    message: locale === 'es'
      ? 'Te enviamos tu presupuesto por correo. Revisa tu bandeja de entrada.'
      : 'We just emailed your quote. Check your inbox.',
  });
});

export default router;
