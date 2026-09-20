import test from 'node:test';
import assert from 'node:assert/strict';
import { validEmail, normalizePhone, validDate } from '../src/utils/validate.js';
import { sign, verify } from '../src/utils/tokens.js';
import { pickLocale } from '../src/templates/i18n.js';
import { renderTemplate, templates } from '../src/templates/emails.js';

test('valida y normaliza correos', () => {
  assert.equal(validEmail('  Ana@Example.COM ').email, 'ana@example.com');
  assert.equal(validEmail('sin-arroba').ok, false);
  assert.equal(validEmail('x@mailinator.com').reason, 'disposable');
});

test('normaliza teléfonos de EE.UU.', () => {
  assert.equal(normalizePhone('(310) 555-0123'), '+13105550123');
  assert.equal(normalizePhone('13105550123'), '+13105550123');
  assert.equal(normalizePhone(''), '');
});

test('rechaza fechas inválidas', () => {
  assert.equal(validDate('2026-13-45'), '');
  assert.equal(validDate('mañana'), '');
  assert.equal(validDate('2026-10-01'), '2026-10-01');
});

test('los tokens firmados no se pueden falsificar', () => {
  const token = sign({ uid: 'abc123' });
  assert.equal(verify(token).uid, 'abc123');
  assert.equal(verify(token.slice(0, -1) + 'X'), null);
  assert.equal(verify('inventado.xxxxxxxxxxxxxxxxxxxxxxxx'), null);
  assert.equal(verify(''), null);
});

test('el idioma cae a inglés salvo que sea español', () => {
  assert.equal(pickLocale('es-MX'), 'es');
  assert.equal(pickLocale('en-US'), 'en');
  assert.equal(pickLocale(undefined), 'en');
});

test('todas las plantillas renderizan en ambos idiomas con baja y píxel', () => {
  const lead = { id: 1, uid: 'u1', name: 'Ana Ruiz', email: 'a@b.com', phone: '+13105550123', zip: '90012', segment: 'residential', service_type: 'deep', frequency: 'biweekly', score: 70, temperature: 'hot', score_reasons: '[]' };
  const q = { size: '3 bd / 2 ba', serviceType: 'deep', frequency: 'biweekly', addons: ['oven'], price: 370, low: 325, high: 415, estimatedHours: 6.5, discountLabel: '15%', annualValue: 9635, recurring: true };
  const links = { booking: 'https://x/b', admin: 'https://x/a', unsubscribe: 'https://x/u', pixel: 'https://x/p' };
  for (const name of Object.keys(templates)) {
    for (const locale of ['es', 'en']) {
      const r = renderTemplate(name, { lead, quote: q, links, locale });
      assert.ok(r.subject.length > 5, `${name}/${locale} sin asunto`);
      assert.ok(r.html.includes('</html>'), `${name}/${locale} HTML incompleto`);
      assert.ok(r.text.length > 50, `${name}/${locale} sin versión de texto`);
      // Los correos al cliente deben llevar baja; el aviso interno no.
      if (name !== 'internal_new_lead') assert.ok(r.html.includes(links.unsubscribe), `${name} sin enlace de baja`);
    }
  }
});

test('el HTML de los datos del lead se escapa', () => {
  const lead = { id: 1, uid: 'u1', name: '<script>alert(1)</script>', email: 'a@b.com', segment: 'residential', score: 10, temperature: 'cold', score_reasons: '[]' };
  const q = { size: '1 bd', serviceType: 'standard', frequency: 'one_time', addons: [], price: 150, low: 130, high: 170, estimatedHours: 2, annualValue: 0 };
  const r = renderTemplate('internal_new_lead', { lead, quote: q, links: { booking: '#', admin: '#' }, locale: 'es' });
  assert.ok(!r.html.includes('<script>alert(1)</script>'));
});
