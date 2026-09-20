import { config } from '../../config.js';
import { db, logEvent } from '../../db.js';
import { enrollLead } from '../../services/sequences.js';
import { newUid } from '../../utils/tokens.js';
import { segmentLabel, SEGMENTS } from '../icp.js';
import { budgetLeft, canSendOutbound } from '../guards.js';
import { writeCopy } from './write.js';
import { estimateValue } from './qualify.js';

/**
 * Agente de contacto.
 *
 * Toma los prospectos cualificados, los convierte en leads del CRM, les redacta
 * el correo y los inscribe en la secuencia en frío. No envía nada por su cuenta:
 * el envío lo hace el motor de secuencias, que vuelve a pasar las salvaguardas
 * justo antes de cada correo.
 */

/** Mapea el segmento de prospección al tipo de servicio que se le cotiza. */
function leadFieldsFor(prospect, quote) {
  const def = SEGMENTS[prospect.segment];
  const base = def?.quote || { segment: 'commercial', serviceType: 'office', frequency: 'weekly' };
  return {
    segment: base.segment,
    service_type: base.serviceType,
    frequency: base.frequency,
    bedrooms: base.bedrooms ?? null,
    bathrooms: base.bathrooms ?? null,
    sqft: base.sqft ?? null,
    quote_price: quote?.price ?? null,
    quote_low: quote?.low ?? null,
    quote_high: quote?.high ?? null,
    annual_value: quote?.annualValue ?? null,
    quote_json: quote ? JSON.stringify(quote) : null,
  };
}

/** Convierte un prospecto cualificado en lead y lo pone en cola de contacto. */
export async function engageOne(prospect) {
  const quote = estimateValue(prospect);
  const copy = await writeCopy(prospect, quote);

  const lead = {
    uid: newUid(),
    name: prospect.contact_name || '',
    company: prospect.business_name,
    website: prospect.website || '',
    // Normalizado: las salvaguardas comparan en minúsculas y una mayúscula
    // suelta no puede dejar fuera una baja o un enfriamiento de dominio.
    email: String(prospect.email).trim().toLowerCase(),
    phone: prospect.phone || '',
    zip: prospect.zip || '',
    address: prospect.address || '',
    locale: prospect.locale || 'en',
    contact_channel: 'outbound',
    prospect_uid: prospect.uid,
    ...leadFieldsFor(prospect, quote),
    addons: '[]',
    score: prospect.icp_score,
    temperature: prospect.icp_score >= 68 ? 'hot' : prospect.icp_score >= 42 ? 'warm' : 'cold',
    score_reasons: JSON.stringify(safeParse(prospect.evidence_json, {})?.qualify?.reasons || []),
    status: 'new',
    source: `outbound:${prospect.source}`,
    landing_page: '',
    referrer: '',
    utm_source: 'outbound',
    utm_medium: 'cold_email',
    utm_campaign: prospect.signal_type || prospect.segment,
    utm_term: '', utm_content: '', gclid: '', fbclid: '',
    ip: '', user_agent: '',
    in_service_area: 1,
  };

  const cols = Object.keys(lead);
  const info = db.prepare(
    `INSERT INTO leads (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`
  ).run(lead);
  lead.id = info.lastInsertRowid;

  db.prepare(
    `UPDATE prospects SET stage='contacted', lead_id=?, copy_json=?, copy_author=?,
            updated_at=datetime('now') WHERE id=?`
  ).run(lead.id, JSON.stringify(copy), copy.author, prospect.id);

  enrollLead(lead, 'outbound');
  logEvent(lead.id, 'outbound_engaged', {
    prospect: prospect.uid,
    segment: prospect.segment,
    icp: prospect.icp_score,
    copyAuthor: copy.author,
  });

  return { leadId: lead.id, uid: lead.uid, copyAuthor: copy.author };
}

/**
 * Procesa el lote de prospectos cualificados.
 * Se limita al cupo del día: de nada sirve encolar 300 correos que no pueden salir.
 */
export async function outreach({ limit } = {}) {
  const stats = { processed: 0, engaged: 0, skipped: 0, reasons: {}, copyAuthors: {} };

  if (!config.outbound.enabled) {
    stats.reasons.outbound_disabled = 1;
    return stats;
  }

  const cap = Math.min(limit ?? 25, Math.max(0, budgetLeft()));
  if (cap <= 0) {
    stats.reasons.daily_limit_reached = 1;
    return stats;
  }

  const rows = db.prepare(
    "SELECT * FROM prospects WHERE stage = 'qualified' ORDER BY icp_score DESC, created_at LIMIT ?"
  ).all(cap);

  for (const prospect of rows) {
    stats.processed++;
    // Última comprobación antes de crear el lead: sin cupo no se encola.
    const check = await canSendOutbound(prospect.email);
    if (!check.allowed) {
      stats.skipped++;
      stats.reasons[check.reason] = (stats.reasons[check.reason] || 0) + 1;
      if (check.reason !== 'daily_limit_reached') {
        db.prepare("UPDATE prospects SET stage='rejected', reject_reason=?, updated_at=datetime('now') WHERE id=?")
          .run(check.reason, prospect.id);
      }
      if (check.reason === 'daily_limit_reached') break;
      continue;
    }

    try {
      const res = await engageOne(prospect);
      stats.engaged++;
      stats.copyAuthors[res.copyAuthor] = (stats.copyAuthors[res.copyAuthor] || 0) + 1;
    } catch (err) {
      stats.skipped++;
      stats.reasons[`error:${String(err.message).slice(0, 60)}`] = 1;
      db.prepare("UPDATE prospects SET reject_reason=?, updated_at=datetime('now') WHERE id=?")
        .run(`engage_error:${String(err.message).slice(0, 120)}`, prospect.id);
    }
  }
  return stats;
}

export { segmentLabel };
const safeParse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };

export default outreach;
