import { config } from '../config.js';

const FREE_EMAIL = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com',
  'icloud.com', 'live.com', 'msn.com', 'proton.me', 'protonmail.com',
]);

/**
 * Puntúa el lead de 0 a 100 para que el equipo llame primero a quien deja
 * más dinero sobre la mesa. Las razones se guardan para que el comercial
 * entienda por qué un lead está arriba de la lista.
 */
export function scoreLead(lead, quote) {
  let score = 0;
  const reasons = [];
  const add = (points, reason) => { score += points; reasons.push({ points, reason }); };

  if (lead.segment === 'commercial') add(25, 'Cliente comercial (contrato recurrente)');

  const freqPoints = { weekly: 25, daily: 25, biweekly: 20, monthly: 14, one_time: 0 };
  const fp = freqPoints[lead.frequency] ?? 0;
  if (fp) add(fp, `Servicio recurrente (${lead.frequency})`);

  const annual = quote?.annualValue || 0;
  if (annual >= 10000) add(20, `Valor anual estimado $${annual.toLocaleString('en-US')}`);
  else if (annual >= 4000) add(13, `Valor anual estimado $${annual.toLocaleString('en-US')}`);
  else if (annual > 0) add(7, `Valor anual estimado $${annual.toLocaleString('en-US')}`);

  const ticket = quote?.price || 0;
  if (ticket >= 400) add(10, `Ticket alto ($${ticket})`);
  else if (ticket >= 250) add(6, `Ticket medio ($${ticket})`);

  if (lead.phone) add(10, 'Dejó teléfono');
  else add(-5, 'Sin teléfono');

  if (lead.preferred_date) {
    const days = daysUntil(lead.preferred_date);
    if (days !== null && days <= 3) add(15, 'Necesita servicio en ≤3 días');
    else if (days !== null && days <= 7) add(10, 'Necesita servicio esta semana');
    else if (days !== null && days <= 14) add(5, 'Fecha definida en 2 semanas');
  }

  if (lead.in_service_area) add(8, 'Dentro del área de servicio');
  else add(-15, 'Fuera del área de servicio declarada');

  if (lead.segment === 'commercial' && lead.email) {
    const domain = String(lead.email).split('@')[1]?.toLowerCase();
    if (domain && !FREE_EMAIL.has(domain)) add(7, 'Email corporativo');
  }

  if (lead.message && lead.message.trim().length > 40) add(5, 'Describió su necesidad con detalle');

  const paid = ['cpc', 'ppc', 'paid', 'paid_social'].includes(String(lead.utm_medium || '').toLowerCase());
  if (paid || lead.gclid) add(5, 'Viene de campaña de pago (intención alta)');

  score = Math.max(0, Math.min(100, Math.round(score)));
  const temperature = score >= 68 ? 'hot' : score >= 42 ? 'warm' : 'cold';
  return { score, temperature, reasons };
}

export function isInServiceArea(zip) {
  const zips = config.business.zips;
  if (!zips.length) return true;
  if (!zip) return true;
  return zips.includes(String(zip).trim().slice(0, 5));
}

function daysUntil(dateStr) {
  const d = new Date(`${dateStr}T12:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return Math.ceil((d - Date.now()) / 86400000);
}

export default scoreLead;
