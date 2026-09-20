import { db } from '../db.js';
import { config } from '../config.js';

/** Límite por IP con ventana deslizante de una hora, persistido en SQLite. */
export function hitRateLimit(key, max = config.security.rateLimitPerHour) {
  const row = db.prepare('SELECT * FROM rate_limits WHERE key = ?').get(key);
  const now = new Date();
  if (!row) {
    db.prepare('INSERT INTO rate_limits (key, count, window_start) VALUES (?, 1, ?)').run(key, now.toISOString());
    return { allowed: true, remaining: max - 1 };
  }
  const started = new Date(row.window_start);
  if (now - started > 3600000) {
    db.prepare('UPDATE rate_limits SET count = 1, window_start = ? WHERE key = ?').run(now.toISOString(), key);
    return { allowed: true, remaining: max - 1 };
  }
  if (row.count >= max) return { allowed: false, remaining: 0 };
  db.prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?').run(key);
  return { allowed: true, remaining: max - row.count - 1 };
}

export function cleanupRateLimits() {
  db.prepare("DELETE FROM rate_limits WHERE window_start < datetime('now','-2 hours')").run();
}
