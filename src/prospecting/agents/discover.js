import crypto from 'node:crypto';
import { config } from '../../config.js';
import { db } from '../../db.js';
import { fetchFromSource, SOURCES } from '../sources/index.js';
import { classify } from '../icp.js';
import { newUid } from '../../utils/tokens.js';

/**
 * Agente descubridor.
 *
 * Consulta los registros públicos activos, traduce cada fila a un prospecto,
 * lo clasifica por segmento y lo guarda si es nuevo. No contacta a nadie: su
 * único trabajo es llenar el embudo sin duplicados.
 */

/**
 * Clave de deduplicación. Un mismo negocio aparece en varios registros y varias
 * veces en el mismo registro; sin esto el CRM se llena de basura en una semana.
 */
export function dedupeKey({ businessName, address, zip, website, phone }) {
  const norm = (s) => String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(inc|llc|corp|co|ltd|the|a|and|de|del|la|el)\b/g, '')
    .replace(/[^a-z0-9]/g, '');

  // El dominio es el identificador más fiable cuando existe.
  if (website) {
    try { return `web:${new URL(website).host.replace(/^www\./, '')}`; } catch { /* sigue */ }
  }
  const phoneDigits = String(phone || '').replace(/\D/g, '').slice(-10);
  if (phoneDigits.length === 10) return `tel:${phoneDigits}`;

  const basis = `${norm(businessName)}|${norm(address)}|${String(zip || '').slice(0, 5)}`;
  return `name:${crypto.createHash('sha1').update(basis).digest('hex').slice(0, 20)}`;
}

export async function discover({ sources, sinceDays = 30, limit, offset = 0, baseOverride } = {}) {
  const active = (sources || config.prospecting.sources).filter((k) => SOURCES[k]);
  const cap = limit ?? config.prospecting.discoverLimit;
  const stats = { sources: active.length, fetched: 0, inserted: 0, duplicates: 0, unclassified: 0, errors: [] };

  for (const key of active) {
    if (stats.inserted >= cap) break;
    let rows = [];
    try {
      rows = await fetchFromSource(key, { sinceDays, limit: Math.min(200, cap * 2), offset, baseOverride });
    } catch (err) {
      stats.errors.push(`${key}: ${err.message}`);
      continue;
    }
    stats.fetched += rows.length;

    for (const row of rows) {
      if (stats.inserted >= cap) break;

      const { segment, confidence, matched } = classify({
        businessName: row.businessName,
        description: row.description,
        naics: row.naics,
        signalType: row.signal?.type,
      });
      // Sin segmento no hay argumento de venta: se descarta antes de gastar
      // una visita web en él.
      if (!segment) { stats.unclassified++; continue; }

      const key_ = dedupeKey(row);
      const exists = db.prepare('SELECT id FROM prospects WHERE dedupe_key = ?').get(key_);
      if (exists) { stats.duplicates++; continue; }

      try {
        db.prepare(`
          INSERT INTO prospects (uid, source, source_id, dedupe_key, business_name, contact_name,
            segment, address, city, zip, phone, signal_type, signal_json, raw_json,
            evidence_json, stage)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'discovered')`
        ).run(
          newUid(), key, row.sourceId || null, key_, row.businessName, row.contactName || null,
          segment, row.address || null, row.city || null, row.zip || null, row.phone || null,
          row.signal?.type || null, JSON.stringify(row.signal || {}), JSON.stringify(row.raw || {}),
          JSON.stringify({ classifier: { confidence, matched }, source: row.sourceLabel }),
        );
        stats.inserted++;
      } catch (err) {
        // Carrera con otra corrida del agente sobre la misma clave.
        if (String(err.message).includes('UNIQUE')) stats.duplicates++;
        else stats.errors.push(`${key}/${row.businessName}: ${err.message}`);
      }
    }
  }

  return stats;
}

export default discover;
