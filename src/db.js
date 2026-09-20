import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  name TEXT,
  email TEXT NOT NULL,
  phone TEXT,
  zip TEXT,
  address TEXT,
  locale TEXT NOT NULL DEFAULT 'en',

  segment TEXT NOT NULL DEFAULT 'residential',
  service_type TEXT,
  frequency TEXT,
  bedrooms INTEGER,
  bathrooms INTEGER,
  sqft INTEGER,
  addons TEXT,
  preferred_date TEXT,
  message TEXT,

  quote_price INTEGER,
  quote_low INTEGER,
  quote_high INTEGER,
  annual_value INTEGER,
  quote_json TEXT,

  score INTEGER NOT NULL DEFAULT 0,
  temperature TEXT NOT NULL DEFAULT 'cold',
  score_reasons TEXT,

  status TEXT NOT NULL DEFAULT 'new',
  owner TEXT,
  notes TEXT,

  source TEXT,
  landing_page TEXT,
  referrer TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_term TEXT,
  utm_content TEXT,
  gclid TEXT,
  fbclid TEXT,
  ip TEXT,
  user_agent TEXT,

  in_service_area INTEGER NOT NULL DEFAULT 1,
  unsubscribed INTEGER NOT NULL DEFAULT 0,
  sender_synced INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at);

CREATE TABLE IF NOT EXISTS sequence_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  sequence TEXT NOT NULL,
  step TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  sent_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  UNIQUE(lead_id, sequence, step)
);
CREATE INDEX IF NOT EXISTS idx_steps_due ON sequence_steps(status, scheduled_at);

CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  template TEXT NOT NULL,
  to_email TEXT NOT NULL,
  subject TEXT,
  driver TEXT,
  status TEXT NOT NULL DEFAULT 'sent',
  error TEXT,
  opened_at TEXT,
  clicked_at TEXT,
  message_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_emails_lead ON emails(lead_id);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  type TEXT NOT NULL,
  data TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_lead ON events(lead_id);

CREATE TABLE IF NOT EXISTS prospects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  source TEXT NOT NULL,
  source_id TEXT,
  dedupe_key TEXT NOT NULL,

  business_name TEXT NOT NULL,
  contact_name TEXT,
  segment TEXT NOT NULL DEFAULT 'office_clinic',
  address TEXT,
  city TEXT,
  zip TEXT,
  phone TEXT,
  website TEXT,
  email TEXT,
  email_source TEXT,
  locale TEXT NOT NULL DEFAULT 'en',

  signal_type TEXT,
  signal_json TEXT,
  raw_json TEXT,
  evidence_json TEXT,

  icp_score INTEGER NOT NULL DEFAULT 0,
  est_visit_value INTEGER,
  est_annual_value INTEGER,

  stage TEXT NOT NULL DEFAULT 'discovered',
  reject_reason TEXT,
  copy_json TEXT,
  copy_author TEXT,

  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  crm_synced INTEGER NOT NULL DEFAULT 0,
  crm_ref TEXT,
  crm_error TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_prospects_dedupe ON prospects(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_prospects_stage ON prospects(stage);
CREATE INDEX IF NOT EXISTS idx_prospects_score ON prospects(icp_score DESC);

-- Nunca volver a contactar: bajas, quejas, rebotes duros y exclusiones manuales.
CREATE TABLE IF NOT EXISTS suppression (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  kind TEXT NOT NULL,            -- email | domain
  value TEXT NOT NULL,
  reason TEXT,
  UNIQUE(kind, value)
);

-- Un registro por envío outbound: sostiene el límite diario y el calentamiento.
CREATE TABLE IF NOT EXISTS outbound_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  day TEXT NOT NULL DEFAULT (date('now')),
  prospect_id INTEGER REFERENCES prospects(id) ON DELETE SET NULL,
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  email TEXT NOT NULL,
  domain TEXT,
  step TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbound_day ON outbound_log(day);
CREATE INDEX IF NOT EXISTS idx_outbound_domain ON outbound_log(domain);

-- Trazabilidad de cada corrida del pipeline de agentes.
CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  agent TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  stats_json TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL
);
`);

// Migraciones: columnas que no existían en la primera versión del esquema.
const leadColumns = new Set(db.prepare('PRAGMA table_info(leads)').all().map((c) => c.name));
for (const [name, ddl] of [
  ['company', 'TEXT'],
  ['website', 'TEXT'],
  ['contact_channel', "TEXT NOT NULL DEFAULT 'inbound'"],
  ['prospect_uid', 'TEXT'],
]) {
  if (!leadColumns.has(name)) db.exec(`ALTER TABLE leads ADD COLUMN ${name} ${ddl}`);
}

export function logEvent(leadId, type, data = null) {
  db.prepare('INSERT INTO events (lead_id, type, data) VALUES (?, ?, ?)')
    .run(leadId, type, data ? JSON.stringify(data) : null);
}

export function touchLead(leadId) {
  db.prepare("UPDATE leads SET updated_at = datetime('now') WHERE id = ?").run(leadId);
}

export default db;
