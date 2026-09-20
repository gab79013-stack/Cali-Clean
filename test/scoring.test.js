import test from 'node:test';
import assert from 'node:assert/strict';

// La zona de servicio se lee de la configuración, así que se fija antes de
// importar los módulos para que el test no dependa del .env de la máquina.
process.env.SERVICE_ZIPS = '90001,90012,90210';
const { scoreLead, isInServiceArea } = await import('../src/services/scoring.js');
const { calculateQuote } = await import('../src/services/quote.js');

const quote = (i) => calculateQuote(i);

test('un contrato comercial semanal puntúa caliente', () => {
  const q = quote({ segment: 'commercial', sqft: 8000, frequency: 'weekly' });
  const s = scoreLead({ segment: 'commercial', frequency: 'weekly', phone: '+13105550100', email: 'a@acme.com', in_service_area: 1 }, q);
  assert.equal(s.temperature, 'hot');
});

test('una limpieza única sin teléfono y fuera de área puntúa fría', () => {
  const q = quote({ segment: 'residential', bedrooms: 1, bathrooms: 1, frequency: 'one_time' });
  const s = scoreLead({ segment: 'residential', frequency: 'one_time', phone: '', email: 'x@gmail.com', in_service_area: 0 }, q);
  assert.equal(s.temperature, 'cold');
  assert.ok(s.score < 42);
});

test('el score siempre queda entre 0 y 100', () => {
  const q = quote({ segment: 'commercial', sqft: 250000, frequency: 'daily' });
  const high = scoreLead({ segment: 'commercial', frequency: 'daily', phone: '1', email: 'a@acme.com', in_service_area: 1, preferred_date: new Date(Date.now() + 86400000).toISOString().slice(0, 10), message: 'x'.repeat(60), utm_medium: 'cpc' }, q);
  const low = scoreLead({ segment: 'residential', frequency: 'one_time', phone: '', email: 'a@gmail.com', in_service_area: 0 }, quote({ segment: 'residential', bedrooms: 0, bathrooms: 1 }));
  assert.ok(high.score <= 100 && low.score >= 0);
});

test('cada punto del score lleva una razón explicable', () => {
  const s = scoreLead({ segment: 'commercial', frequency: 'weekly', phone: '1', email: 'a@acme.com', in_service_area: 1 }, quote({ segment: 'commercial', sqft: 5000, frequency: 'weekly' }));
  assert.ok(s.reasons.length > 3);
  for (const r of s.reasons) assert.ok(typeof r.reason === 'string' && r.reason.length > 0);
});

test('el área de servicio respeta la lista de ZIPs configurada', () => {
  assert.equal(isInServiceArea('90012'), true);
  assert.equal(isInServiceArea('99999'), false);
  assert.equal(isInServiceArea(''), true, 'sin ZIP no se penaliza al lead');
});
