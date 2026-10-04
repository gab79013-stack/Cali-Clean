import crypto from 'node:crypto';
import { config } from '../../config.js';
import { db } from '../../db.js';
import { fetchFromSource, SOURCES, emptyMetrics } from '../sources/index.js';
import { scrubRow } from '../sources/compliance.js';
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
export function dedupeKey({ dedupKey, businessName, address, zip, website, phone }) {
  // Si la fuente da una clave determinista —derivada del identificador del
  // registro oficial, con namespace estable—, manda esa. Es la única que
  // sobrevive a que el negocio cambie de nombre, de teléfono o de web, y es la
  // que permite recuperar el cursor leyendo el CRM.
  if (dedupKey) return String(dedupKey);

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

export async function discover({ sources, sinceDays = 30, limit, baseOverride, fetchOptions = {} } = {}) {
  const active = (sources || config.prospecting.sources).filter((k) => SOURCES[k]);
  const cap = limit ?? config.prospecting.discoverLimit;
  const stats = {
    sources: active.length,
    fetched: 0,
    inserted: 0,
    duplicates: 0,
    unclassified: 0,
    errors: [],
    // Métricas agregadas de la capa de red y de los filtros. Solo recuentos.
    metrics: emptyMetrics(),
    blocked: [],
  };

  const addMetrics = (m) => {
    for (const k of Object.keys(stats.metrics)) {
      if (typeof m[k] === 'number') stats.metrics[k] += m[k];
    }
  };

  for (const key of active) {
    if (stats.inserted >= cap) break;
    let rows = [];
    try {
      const result = await fetchFromSource(key, {
        sinceDays, limit: Math.min(200, cap * 2), baseOverride, ...fetchOptions,
      });
      addMetrics(result.metrics);
      if (result.blocked) {
        // La cuota no es un fallo: es el sistema funcionando. Se anota aparte
        // para que no se confunda con un error en los informes.
        stats.blocked.push({ source: key, ...result.blocked });
        continue;
      }
      rows = result.rows;
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
            evidence_json, stage, service_area, source_url)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'discovered', ?, ?)`
        ).run(
          newUid(), key, row.sourceId || null, key_, row.businessName, row.contactName || null,
          segment, row.address || null, row.city || null, row.zip || null, row.phone || null,
          row.signal?.type || null, JSON.stringify(row.signal || {}),
          // Segunda pasada del filtro de campos prohibidos, justo antes de
          // escribir en disco. `fetchFromSource` ya limpia, pero esta es la
          // última línea antes de que un dato personal quede persistido, y
          // quien añada mañana otro productor de filas no tiene por qué saberlo.
          JSON.stringify(scrubRow(key, row.raw) || {}),
          JSON.stringify({ classifier: { confidence, matched }, source: row.sourceLabel }),
          // El área y la URL del registro viajan al CRM: sin ellas no se puede
          // auditar de dónde salió una empresa ni filtrar por zona.
          row.serviceArea || null,
          row.sourceUrl || null,
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
