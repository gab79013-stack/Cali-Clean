import { config } from '../../config.js';
import { db } from '../../db.js';
import { calculateQuote } from '../../services/quote.js';
import { isInServiceArea } from '../../services/scoring.js';
import { SEGMENTS } from '../icp.js';
import { isSuppressed, hasUnsubscribed } from '../guards.js';

/**
 * Agente cualificador.
 *
 * Decide si un prospecto merece un correo y cuánto vale si responde. Lo que no
 * pasa el corte se marca con el motivo: el panel tiene que poder explicar por
 * qué un negocio nunca recibió nada.
 */

const FREE_MAIL = /@(gmail|yahoo|hotmail|outlook|aol|icloud|live|msn)\./i;

export function scoreProspect(prospect, quote) {
  const def = SEGMENTS[prospect.segment];
  let score = 0;
  const reasons = [];
  const add = (points, reason) => { score += points; reasons.push({ points, reason }); };

  if (def) add(def.weight, `Segmento objetivo: ${def.label.es}`);

  // El valor del contrato es la razón por la que este prospecto importa.
  const annual = quote?.annualValue || 0;
  if (annual >= 20000) add(22, `Valor anual estimado $${annual.toLocaleString('en-US')}`);
  else if (annual >= 8000) add(15, `Valor anual estimado $${annual.toLocaleString('en-US')}`);
  else if (annual > 0) add(8, `Valor anual estimado $${annual.toLocaleString('en-US')}`);
  else if (quote?.price >= 500) add(10, `Trabajo puntual de $${quote.price}`);

  // Una obra recién cerrada caduca: esta semana vale, en dos meses ya no.
  const signal = safeParse(prospect.signal_json, {});
  if (signal.type === 'permit_finaled') {
    const days = daysSince(signal.finaledAt);
    if (days !== null && days <= 14) add(20, `Obra finalizada hace ${days} días`);
    else if (days !== null && days <= 45) add(10, `Obra finalizada hace ${days} días`);
    if (signal.valuation >= 100000) add(8, `Obra de $${Number(signal.valuation).toLocaleString('en-US')}`);
  }
  if (signal.type === 'new_business') {
    const days = daysSince(signal.openedAt);
    // Un negocio que acaba de abrir todavía no tiene proveedor de limpieza.
    if (days !== null && days <= 60) add(14, `Abrió hace ${days} días, aún sin proveedor fijo`);
    else if (days !== null && days <= 180) add(7, `Abrió hace ${days} días`);
  }

  if (prospect.email && !FREE_MAIL.test(prospect.email)) add(8, 'Correo corporativo propio');
  if (prospect.phone) add(5, 'Teléfono verificado en su web');
  if (prospect.website) add(5, 'Sitio web activo');

  const inArea = isInServiceArea(prospect.zip);
  if (inArea) add(8, 'Dentro del área de servicio');
  else add(-25, 'Fuera del área de servicio');

  const classifier = safeParse(prospect.evidence_json, {})?.classifier;
  if (classifier && classifier.confidence < 0.4) add(-8, 'Clasificación de segmento poco fiable');

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, reasons, inArea };
}

/** Presupuesto de referencia del segmento: lo que se le nombra en el correo. */
export function estimateValue(prospect) {
  const def = SEGMENTS[prospect.segment];
  if (!def) return null;
  return calculateQuote(def.quote);
}

export function qualifyOne(prospect) {
  const quote = estimateValue(prospect);
  const { score, reasons, inArea } = scoreProspect(prospect, quote);

  if (!prospect.email) return { stage: 'rejected', reject_reason: 'no_email', score, quote, reasons };
  if (!inArea) return { stage: 'rejected', reject_reason: 'out_of_service_area', score, quote, reasons };

  const suppressed = isSuppressed(prospect.email);
  if (suppressed.suppressed) return { stage: 'rejected', reject_reason: suppressed.reason, score, quote, reasons };
  if (hasUnsubscribed(prospect.email)) {
    return { stage: 'rejected', reject_reason: 'previously_unsubscribed', score, quote, reasons };
  }
  // No contactar a quien ya es cliente o ya está en el embudo por su cuenta.
  const existing = db.prepare('SELECT status FROM leads WHERE email = ? LIMIT 1').get(prospect.email);
  if (existing) return { stage: 'rejected', reject_reason: `already_a_lead:${existing.status}`, score, quote, reasons };

  if (score < config.outbound.minIcpScore) {
    return { stage: 'rejected', reject_reason: `below_icp_threshold:${score}`, score, quote, reasons };
  }
  return { stage: 'qualified', score, quote, reasons };
}

export function qualify({ limit = 100 } = {}) {
  const rows = db.prepare("SELECT * FROM prospects WHERE stage = 'enriched' ORDER BY created_at LIMIT ?").all(limit);
  const stats = { processed: 0, qualified: 0, rejected: 0, reasons: {} };

  for (const prospect of rows) {
    stats.processed++;
    const result = qualifyOne(prospect);
    const evidence = safeParse(prospect.evidence_json, {});

    db.prepare(
      `UPDATE prospects SET stage=?, reject_reason=?, icp_score=?, est_visit_value=?,
              est_annual_value=?, evidence_json=?, updated_at=datetime('now') WHERE id=?`
    ).run(
      result.stage, result.reject_reason || null, result.score,
      result.quote?.price || null, result.quote?.annualValue || null,
      JSON.stringify({ ...evidence, qualify: { reasons: result.reasons, quote: result.quote } }),
      prospect.id,
    );

    if (result.stage === 'qualified') stats.qualified++;
    else {
      stats.rejected++;
      const key = String(result.reject_reason).split(':')[0];
      stats.reasons[key] = (stats.reasons[key] || 0) + 1;
    }
  }
  return stats;
}

function daysSince(dateStr) {
  if (!dateStr) return null;
  const d = new Date(String(dateStr).slice(0, 10));
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - d) / 86400000));
}

const safeParse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };

export default qualify;
