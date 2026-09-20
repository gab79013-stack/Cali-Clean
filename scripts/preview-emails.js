/**
 * Genera los correos de la secuencia como archivos HTML para revisarlos en el
 * navegador antes de que los vea un cliente.
 *   node scripts/preview-emails.js [carpeta-salida]
 */
import fs from 'node:fs';
import path from 'node:path';
import { templates, renderTemplate } from '../src/templates/emails.js';
import { calculateQuote } from '../src/services/quote.js';

const out = process.argv[2] || path.join(process.cwd(), 'preview');
fs.mkdirSync(out, { recursive: true });

const quote = calculateQuote({ segment: 'residential', bedrooms: 3, bathrooms: 2, serviceType: 'deep', frequency: 'biweekly', addons: ['oven', 'fridge'] });
const lead = {
  id: 1, uid: 'preview', name: 'María Fernández', email: 'maria@example.com',
  phone: '+13105559876', zip: '90012', segment: 'residential', service_type: 'deep',
  frequency: 'biweekly', preferred_date: '2026-10-02', message: 'Casa de dos pisos, tengo dos perros.',
  score: 71, temperature: 'hot', in_service_area: 1, utm_source: 'google', utm_campaign: 'la-deep-clean',
  landing_page: 'https://cali-clean.net/', quote_price: quote.price, annual_value: quote.annualValue,
  score_reasons: JSON.stringify([{ points: 20, reason: 'Servicio recurrente (biweekly)' }, { points: 10, reason: 'Dejó teléfono' }]),
};
const links = { booking: '#booking', admin: '#admin', unsubscribe: '#unsubscribe', pixel: '' };

const index = [];
for (const name of Object.keys(templates)) {
  for (const locale of ['es', 'en']) {
    const r = renderTemplate(name, { lead, quote, links, locale });
    const file = `${name}.${locale}.html`;
    fs.writeFileSync(path.join(out, file), r.html);
    index.push({ file, name, locale, subject: r.subject });
  }
}

fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html><meta charset="utf-8">
<title>Previsualización de correos · Cali Clean</title>
<style>body{font-family:system-ui,sans-serif;max-width:860px;margin:40px auto;padding:0 20px;color:#0f172a}
h1{font-size:24px}a{color:#0f766e}table{width:100%;border-collapse:collapse;margin-top:18px}
td,th{text-align:left;padding:9px 10px;border-bottom:1px solid #e2e8f0;font-size:14px}th{background:#f8fafc}</style>
<h1>Correos de la máquina de leads</h1>
<p>Cada plantilla renderizada con un lead de ejemplo, en español e inglés.</p>
<table><tr><th>Plantilla</th><th>Idioma</th><th>Asunto</th></tr>
${index.map((i) => `<tr><td><a href="${i.file}">${i.name}</a></td><td>${i.locale}</td><td>${i.subject}</td></tr>`).join('')}
</table>`);

console.log(`✓ ${index.length} correos en ${out}`);
console.log(`  Abre ${path.join(out, 'index.html')}`);
