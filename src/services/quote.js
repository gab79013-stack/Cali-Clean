import { pricing } from '../config.js';

const round5 = (n) => Math.round(n / 5) * 5;
const clampInt = (v, min, max, d) => {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return d;
  return Math.min(max, Math.max(min, n));
};

/**
 * Motor de presupuesto instantáneo.
 * Devuelve siempre un resultado utilizable: si faltan datos usa los valores por
 * defecto del tramo más común, porque en el widget el precio debe aparecer
 * antes de pedir el email.
 */
export function calculateQuote(input = {}) {
  const segment = input.segment === 'commercial' ? 'commercial' : 'residential';
  return segment === 'commercial' ? commercialQuote(input) : residentialQuote(input);
}

function residentialQuote(input) {
  const p = pricing.residential;
  const bedrooms = clampInt(input.bedrooms, 0, 12, 2);
  const bathrooms = clampInt(input.bathrooms, 1, 10, 2);
  const type = p.types[input.serviceType] ? input.serviceType : 'standard';
  const frequency = p.frequency[input.frequency] ? input.frequency : 'one_time';
  const addons = normalizeAddons(input.addons, p.addons);

  const lines = [];
  let subtotal = p.base + bedrooms * p.perBedroom + bathrooms * p.perBathroom;
  lines.push({ label: 'base', detail: `${bedrooms} bd · ${bathrooms} ba`, amount: subtotal });

  const typeMult = p.types[type].multiplier;
  if (typeMult !== 1) {
    const delta = subtotal * (typeMult - 1);
    lines.push({ label: `service_${type}`, detail: `x${typeMult}`, amount: delta });
    subtotal += delta;
  }

  const addonTotal = addons.reduce((sum, a) => sum + p.addons[a], 0);
  for (const a of addons) lines.push({ label: `addon_${a}`, detail: null, amount: p.addons[a] });

  const freq = p.frequency[frequency];
  let total = subtotal + addonTotal;
  if (freq.multiplier !== 1) {
    const delta = total * (freq.multiplier - 1);
    lines.push({ label: `frequency_${frequency}`, detail: freq.discountLabel, amount: delta });
    total += delta;
  }

  total = Math.max(p.minimum, total);
  return buildResult({ segment: 'residential', serviceType: type, frequency, addons, total, lines, freq,
    size: `${bedrooms} bd / ${bathrooms} ba`, estimatedHours: estimateHours(bedrooms, bathrooms, typeMult) });
}

function commercialQuote(input) {
  const p = pricing.commercial;
  const sqft = clampInt(input.sqft, 200, 250000, 2000);
  const type = p.types[input.serviceType] ? input.serviceType : 'office';
  const frequency = p.frequency[input.frequency] ? input.frequency : 'weekly';
  const addons = normalizeAddons(input.addons, p.addons);

  const lines = [];
  let subtotal = Math.max(p.minimum, sqft * p.ratePerSqft);
  lines.push({ label: 'base', detail: `${sqft.toLocaleString('en-US')} sqft`, amount: subtotal });

  const typeMult = p.types[type].multiplier;
  if (typeMult !== 1) {
    const delta = subtotal * (typeMult - 1);
    lines.push({ label: `facility_${type}`, detail: `x${typeMult}`, amount: delta });
    subtotal += delta;
  }

  const addonTotal = addons.reduce((sum, a) => sum + p.addons[a], 0);
  for (const a of addons) lines.push({ label: `addon_${a}`, detail: null, amount: p.addons[a] });

  const freq = p.frequency[frequency];
  let total = subtotal + addonTotal;
  if (freq.multiplier !== 1) {
    const delta = total * (freq.multiplier - 1);
    lines.push({ label: `frequency_${frequency}`, detail: freq.discountLabel, amount: delta });
    total += delta;
  }

  total = Math.max(p.minimum, total);
  return buildResult({ segment: 'commercial', serviceType: type, frequency, addons, total, lines, freq,
    size: `${sqft.toLocaleString('en-US')} sqft`, estimatedHours: Math.max(2, Math.round(sqft / 1200)) });
}

function buildResult({ segment, serviceType, frequency, addons, total, lines, freq, size, estimatedHours }) {
  const price = round5(total);
  const margin = pricing.rangeMargin;
  const recurring = frequency !== 'one_time';
  const visitsPerMonth = { weekly: 4.33, biweekly: 2.17, monthly: 1, daily: 21.7, one_time: 0 }[frequency] || 0;
  return {
    segment,
    serviceType,
    frequency,
    addons,
    size,
    currency: pricing.currency,
    price,
    low: round5(price * (1 - margin)),
    high: round5(price * (1 + margin)),
    estimatedHours,
    recurring,
    discountLabel: freq.discountLabel,
    // Valor a 12 meses: el número que decide si un lead merece una llamada.
    annualValue: Math.round(price * visitsPerMonth * 12),
    lines: lines.map((l) => ({ ...l, amount: Math.round(l.amount) })),
  };
}

function normalizeAddons(addons, catalog) {
  if (!Array.isArray(addons)) return [];
  return [...new Set(addons.filter((a) => typeof a === 'string' && catalog[a]))].sort();
}

function estimateHours(bedrooms, bathrooms, typeMult) {
  const base = 1.5 + bedrooms * 0.5 + bathrooms * 0.6;
  return Math.round(base * typeMult * 2) / 2;
}

export default calculateQuote;
