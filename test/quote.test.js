import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateQuote } from '../src/services/quote.js';
import { pricing } from '../src/config.js';

test('un presupuesto residencial crece con el tamaño', () => {
  const small = calculateQuote({ segment: 'residential', bedrooms: 1, bathrooms: 1 });
  const big = calculateQuote({ segment: 'residential', bedrooms: 5, bathrooms: 4 });
  assert.ok(big.price > small.price);
});

test('la limpieza profunda cuesta más que la estándar', () => {
  const base = { segment: 'residential', bedrooms: 3, bathrooms: 2 };
  assert.ok(calculateQuote({ ...base, serviceType: 'deep' }).price >
            calculateQuote({ ...base, serviceType: 'standard' }).price);
});

test('el servicio recurrente aplica descuento', () => {
  const base = { segment: 'residential', bedrooms: 3, bathrooms: 2 };
  const once = calculateQuote({ ...base, frequency: 'one_time' });
  const weekly = calculateQuote({ ...base, frequency: 'weekly' });
  assert.ok(weekly.price < once.price);
  assert.equal(weekly.discountLabel, '20%');
});

test('nunca se cotiza por debajo del mínimo', () => {
  const q = calculateQuote({ segment: 'residential', bedrooms: 0, bathrooms: 1, frequency: 'weekly' });
  assert.ok(q.price >= pricing.residential.minimum);
});

test('el valor anual solo existe si el servicio es recurrente', () => {
  assert.equal(calculateQuote({ segment: 'residential', frequency: 'one_time' }).annualValue, 0);
  assert.ok(calculateQuote({ segment: 'residential', frequency: 'weekly' }).annualValue > 0);
});

test('entradas inválidas caen en valores por defecto en lugar de romper', () => {
  const q = calculateQuote({ segment: 'marciano', bedrooms: 'muchas', bathrooms: -4, serviceType: 'x', frequency: 'y', addons: 'no-es-array' });
  assert.equal(q.segment, 'residential');
  assert.equal(q.serviceType, 'standard');
  assert.equal(q.frequency, 'one_time');
  assert.deepEqual(q.addons, []);
  assert.ok(q.price > 0);
});

test('los extras desconocidos se ignoran y los repetidos no se cobran dos veces', () => {
  const q = calculateQuote({ segment: 'residential', bedrooms: 2, bathrooms: 1, addons: ['oven', 'oven', 'cohete'] });
  assert.deepEqual(q.addons, ['oven']);
});

test('el presupuesto comercial escala por pies cuadrados', () => {
  const a = calculateQuote({ segment: 'commercial', sqft: 1000, frequency: 'one_time' });
  const b = calculateQuote({ segment: 'commercial', sqft: 20000, frequency: 'one_time' });
  assert.ok(b.price > a.price * 5);
});

test('la horquilla de precio rodea al estimado', () => {
  const q = calculateQuote({ segment: 'residential', bedrooms: 3, bathrooms: 2 });
  assert.ok(q.low < q.price && q.price < q.high);
});
