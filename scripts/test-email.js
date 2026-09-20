/**
 * Verifica la configuración de correo de punta a punta.
 *   node scripts/test-email.js tu@correo.com [es|en]
 */
import { config } from '../src/config.js';
import '../src/db.js';
import { sendTemplate, verifyConnection } from '../src/services/mailer.js';
import { calculateQuote } from '../src/services/quote.js';
import senderApi from '../src/services/sender-api.js';

const to = process.argv[2];
const locale = process.argv[3] || 'es';
if (!to) {
  console.error('Uso: node scripts/test-email.js destinatario@correo.com [es|en]');
  process.exit(1);
}

console.log(`Driver: ${config.mail.driver}`);
console.log(`SMTP:   ${config.mail.smtp.host}:${config.mail.smtp.port} user=${config.mail.smtp.user || '(vacío)'}`);
console.log(`API:    token ${senderApi.ready() ? 'presente' : 'ausente'}`);

try {
  await verifyConnection();
  console.log('✓ Conexión verificada');
} catch (err) {
  console.error(`✗ Conexión fallida: ${err.message}`);
}

const quote = calculateQuote({ segment: 'residential', bedrooms: 3, bathrooms: 2, serviceType: 'deep', frequency: 'biweekly', addons: ['oven'] });
const lead = { id: null, uid: 'test-uid', name: 'Test Lead', email: to, phone: '+13105550123', zip: '90012', locale, segment: 'residential', service_type: 'deep', frequency: 'biweekly', preferred_date: '', score: 71, temperature: 'hot', score_reasons: '[]' };

const res = await sendTemplate({ template: 'quote', lead, quote, to, locale });
console.log(res.ok ? `✓ Enviado: "${res.subject}"` : `✗ Fallo: ${res.error}`);
process.exit(res.ok ? 0 : 1);
