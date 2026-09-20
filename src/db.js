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

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL
);
`);

export function logEvent(leadId, type, data = null) {
  db.prepare('INSERT INTO events (lead_id, type, data) VALUES (?, ?, ?)')
    .run(leadId, type, data ? JSON.stringify(data) : null);
}

export function touchLead(leadId) {
  db.prepare("UPDATE leads SET updated_at = datetime('now') WHERE id = ?").run(leadId);
}

export default db;
