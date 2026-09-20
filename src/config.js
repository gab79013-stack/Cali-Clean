import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

const bool = (v, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: num(process.env.PORT, 3000),
  appUrl: (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, ''),
  secret: process.env.APP_SECRET || 'dev-secret-change-me',
  dbPath: process.env.DB_PATH || path.join(ROOT, 'data', 'leads.db'),

  business: {
    name: process.env.BUSINESS_NAME || 'Cali Clean',
    site: process.env.BUSINESS_SITE || 'https://cali-clean.net',
    email: process.env.BUSINESS_EMAIL || 'info@cali-clean.net',
    phone: process.env.BUSINESS_PHONE || '',
    address: process.env.BUSINESS_ADDRESS || '',
    hours: process.env.BUSINESS_HOURS || 'Mon-Sat 8:00-18:00',
    zips: list(process.env.SERVICE_ZIPS),
    bookingUrl: process.env.BOOKING_URL || process.env.BUSINESS_SITE || 'https://cali-clean.net',
    reviewsUrl: process.env.REVIEWS_URL || '',
    tz: process.env.BUSINESS_TZ || 'America/Los_Angeles',
  },

  mail: {
    driver: (process.env.MAIL_DRIVER || 'log').toLowerCase(),
    fromName: process.env.MAIL_FROM_NAME || 'Cali Clean',
    fromEmail: process.env.MAIL_FROM_EMAIL || 'hello@cali-clean.net',
    replyTo: process.env.MAIL_REPLY_TO || process.env.BUSINESS_EMAIL || '',
    notifyTo: list(process.env.MAIL_NOTIFY_TO || process.env.BUSINESS_EMAIL),
    smtp: {
      host: process.env.SMTP_HOST || 'smtp.sender.net',
      port: num(process.env.SMTP_PORT, 587),
      secure: bool(process.env.SMTP_SECURE, false),
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
    },
  },

  sender: {
    token: process.env.SENDER_API_TOKEN || '',
    base: (process.env.SENDER_API_BASE || 'https://api.sender.net/v2').replace(/\/$/, ''),
    transactionalPath: process.env.SENDER_TRANSACTIONAL_PATH || '/email',
    syncSubscribers: bool(process.env.SENDER_SYNC_SUBSCRIBERS, false),
    groups: {
      all: process.env.SENDER_GROUP_ALL || '',
      residential: process.env.SENDER_GROUP_RESIDENTIAL || '',
      commercial: process.env.SENDER_GROUP_COMMERCIAL || '',
      hot: process.env.SENDER_GROUP_HOT || '',
    },
  },

  admin: {
    user: process.env.ADMIN_USER || 'admin',
    pass: process.env.ADMIN_PASS || 'admin',
  },

  // ── Prospección outbound ──────────────────────────────────
  outbound: {
    // Interruptor general: en false no sale ni un correo outbound.
    enabled: bool(process.env.OUTBOUND_ENABLED, false),
    // Tope de correos outbound por día, una vez terminado el calentamiento.
    dailyLimit: num(process.env.OUTBOUND_DAILY_LIMIT, 40),
    // Calentamiento del dominio: se arranca aquí y se sube un escalón por día.
    warmupStart: num(process.env.OUTBOUND_WARMUP_START, 10),
    warmupStep: num(process.env.OUTBOUND_WARMUP_STEP, 5),
    warmupStartDate: process.env.OUTBOUND_WARMUP_START_DATE || '',
    // Nunca dos prospectos del mismo dominio dentro de esta ventana.
    domainCooldownDays: num(process.env.OUTBOUND_DOMAIN_COOLDOWN_DAYS, 90),
    // Puntuación mínima del ICP para que un prospecto entre en secuencia.
    minIcpScore: num(process.env.OUTBOUND_MIN_ICP_SCORE, 45),
    // Exigir que el dominio tenga registros MX antes de enviar.
    requireMx: bool(process.env.OUTBOUND_REQUIRE_MX, true),
    // Motivo de contacto: buena práctica y requisito de CAN-SPAM.
    disclosureEs: process.env.OUTBOUND_DISCLOSURE_ES
      || 'Te escribimos porque tu negocio aparece en registros públicos de California. Si no te interesa, usa "Darme de baja" y no volvemos a escribirte.',
    disclosureEn: process.env.OUTBOUND_DISCLOSURE_EN
      || 'You are receiving this because your business appears in California public records. Not interested? Hit "Unsubscribe" and we will not write again.',
  },

  prospecting: {
    // Topes por corrida de cada agente.
    discoverLimit: num(process.env.PROSPECT_DISCOVER_LIMIT, 50),
    enrichLimit: num(process.env.PROSPECT_ENRICH_LIMIT, 40),
    // Pausa entre peticiones al mismo host.
    crawlDelayMs: num(process.env.PROSPECT_CRAWL_DELAY_MS, 2000),
    userAgent: process.env.PROSPECT_USER_AGENT
      || 'CaliCleanProspector/1.0 (+https://cali-clean.net/bot; contact: info@cali-clean.net)',
    requestTimeoutMs: num(process.env.PROSPECT_TIMEOUT_MS, 12000),
    sources: list(process.env.PROSPECT_SOURCES).length
      ? list(process.env.PROSPECT_SOURCES)
      : ['sd_active_businesses', 'sd_development_permits'],
    socrataAppToken: process.env.SOCRATA_APP_TOKEN || '',
  },

  crm: {
    // Adaptador: none | webhook | espocrm | suitecrm | perfex | vtiger |
    //            hubspot | gohighlevel
    driver: (process.env.CRM_DRIVER || 'none').toLowerCase(),
    webhookUrl: process.env.CRM_WEBHOOK_URL || '',
    webhookSecret: process.env.CRM_WEBHOOK_SECRET || '',
    baseUrl: process.env.CRM_BASE_URL || '',
    apiKey: process.env.CRM_API_KEY || '',
    apiSecret: process.env.CRM_API_SECRET || '',
    apiUser: process.env.CRM_API_USER || '',
    locationId: process.env.CRM_LOCATION_ID || '',
    assignedUserId: process.env.CRM_ASSIGNED_USER_ID || '',
    // Empujar también los leads del widget, no solo los de prospección.
    syncInbound: bool(process.env.CRM_SYNC_INBOUND, true),
  },

  ai: {
    // Redacción de los correos con Claude. Sin clave, plantillas deterministas.
    enabled: bool(process.env.AI_COPY_ENABLED, false),
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.AI_MODEL || 'claude-opus-5',
    effort: process.env.AI_EFFORT || 'low',
  },

  sequences: {
    tickMinutes: num(process.env.SEQUENCE_TICK_MINUTES, 5),
    sendFrom: num(process.env.SEQUENCE_SEND_FROM, 8),
    sendTo: num(process.env.SEQUENCE_SEND_TO, 20),
  },

  security: {
    corsOrigins: list(process.env.CORS_ORIGINS),
    rateLimitPerHour: num(process.env.RATE_LIMIT_PER_HOUR, 8),
  },
};

/**
 * Tarifas. Todo editable sin tocar código: son los números que gobiernan el
 * presupuesto instantáneo del widget. Ajusta a los precios reales de Cali Clean.
 */
export const pricing = {
  currency: 'USD',
  // Presupuesto residencial = (base + dormitorios + baños) * tipo * frecuencia + extras
  residential: {
    base: 89,
    perBedroom: 26,
    perBathroom: 34,
    // Suelo de facturación: ningún trabajo por debajo de esto.
    minimum: 129,
    types: {
      standard: { multiplier: 1.0 },
      deep: { multiplier: 1.55 },
      move: { multiplier: 1.75 },
      post_construction: { multiplier: 2.1 },
    },
    frequency: {
      one_time: { multiplier: 1.0, discountLabel: null },
      monthly: { multiplier: 0.9, discountLabel: '10%' },
      biweekly: { multiplier: 0.85, discountLabel: '15%' },
      weekly: { multiplier: 0.8, discountLabel: '20%' },
    },
    addons: {
      fridge: 35,
      oven: 35,
      windows_interior: 65,
      laundry: 25,
      garage: 55,
      cabinets: 45,
      patio: 40,
    },
  },
  // Comercial = max(minimum, sqft * rate) * frecuencia
  commercial: {
    minimum: 189,
    ratePerSqft: 0.12,
    types: {
      office: { multiplier: 1.0 },
      retail: { multiplier: 1.05 },
      medical: { multiplier: 1.35 },
      restaurant: { multiplier: 1.4 },
      post_construction: { multiplier: 1.8 },
    },
    frequency: {
      one_time: { multiplier: 1.0, discountLabel: null },
      monthly: { multiplier: 0.95, discountLabel: '5%' },
      biweekly: { multiplier: 0.9, discountLabel: '10%' },
      weekly: { multiplier: 0.82, discountLabel: '18%' },
      daily: { multiplier: 0.7, discountLabel: '30%' },
    },
    addons: {
      windows_exterior: 120,
      carpet_shampoo: 180,
      floor_wax: 250,
      disinfection: 95,
    },
  },
  // El estimado se muestra como horquilla: ±margen sobre el precio calculado.
  rangeMargin: 0.12,
  // Descuento de la primera limpieza usado en las secuencias de recuperación.
  firstCleanDiscount: 15,
};

export default config;
