/**
 * Herramienta de CRM.
 *
 *   node scripts/crm.js detect https://crm.tudominio.com
 *       Averigua qué CRM está instalado ahí, sin credenciales.
 *
 *   node scripts/crm.js status
 *       Dice si el CRM configurado está listo y qué le falta.
 *
 *   node scripts/crm.js test
 *       Crea un lead de prueba en el CRM configurado y te da su identificador.
 */
import { config } from '../src/config.js';
import { detectCrm } from '../src/services/crm/detect.js';
import { adapters } from '../src/services/crm/adapters.js';
import { crmStatus, adapterConfig, http, toPayload } from '../src/services/crm.js';

const [command, arg] = process.argv.slice(2);

const CONFIG_HINTS = {
  espocrm: [
    'En EspoCRM: Administración → Usuarios API → crear usuario con "Autenticación por API Key".',
    'Copia la API Key y dale permisos de lectura/escritura sobre Leads.',
    '',
    'CRM_DRIVER=espocrm',
    'CRM_BASE_URL=https://tu-crm.com',
    'CRM_API_KEY=<la API Key>',
  ],
  suitecrm: [
    'En SuiteCRM: Admin → OAuth2 Clients and Tokens → New Client Credentials Client.',
    'Guarda el Client ID y el Secret que te muestra.',
    '',
    'CRM_DRIVER=suitecrm',
    'CRM_BASE_URL=https://tu-crm.com',
    'CRM_API_KEY=<Client ID>',
    'CRM_API_SECRET=<Client Secret>',
  ],
  perfex: [
    'En Perfex: Setup → API → generar un token con permiso sobre Leads.',
    '',
    'CRM_DRIVER=perfex',
    'CRM_BASE_URL=https://tu-crm.com',
    'CRM_API_KEY=<el token>',
  ],
  vtiger: [
    'En Vtiger: My Preferences de un usuario → Access Key.',
    '',
    'CRM_DRIVER=vtiger',
    'CRM_BASE_URL=https://tu-crm.com',
    'CRM_API_USER=<usuario>',
    'CRM_API_KEY=<Access Key>',
  ],
  odoo: [
    'Odoo usa XML-RPC y todavía no tiene adaptador propio aquí.',
    'Mientras tanto funciona el genérico contra un endpoint intermedio:',
    '',
    'CRM_DRIVER=webhook',
    'CRM_WEBHOOK_URL=<tu endpoint>',
  ],
  hubspot: ['CRM_DRIVER=hubspot', 'CRM_API_KEY=<private app token>'],
};

async function detect() {
  if (!arg) {
    console.error('Uso: node scripts/crm.js detect https://crm.tudominio.com');
    process.exit(1);
  }
  console.log(`Analizando ${arg} …\n`);
  const result = await detectCrm(arg);

  for (const a of result.attempts) {
    const mark = a.reachable ? String(a.status).padStart(3) : '---';
    console.log(`  ${mark}  ${a.url}${a.error ? `  (${a.error})` : ''}`);
  }
  console.log('');

  if (!result.reachable) {
    console.log('✗ No se pudo alcanzar el servidor.');
    console.log('  Comprueba la URL, que el sitio esté en línea y que no bloquee peticiones externas.');
    process.exit(2);
  }
  if (!result.candidates.length) {
    console.log('✗ Hay un servidor ahí, pero no reconozco el CRM.');
    console.log('  Dime cuál es y escribo el adaptador; mientras tanto puedes usar CRM_DRIVER=webhook.');
    process.exit(3);
  }

  const best = result.candidates[0];
  console.log(`✓ Es ${best.label}  (confianza ${Math.round(best.confidence * 100)}%)`);
  if (result.candidates.length > 1) {
    console.log('  Otros candidatos:', result.candidates.slice(1).map((c) => c.label).join(', '));
  }
  console.log('\nPara conectarlo, en tu .env:\n');
  for (const line of CONFIG_HINTS[best.crm] || ['CRM_DRIVER=webhook']) console.log(`  ${line}`);
  console.log('\nDespués:  node scripts/crm.js test');
}

function status() {
  const s = crmStatus();
  console.log(`Adaptador: ${s.driver}${s.label ? ` (${s.label})` : ''}`);
  console.log(`Listo:     ${s.ready ? 'sí' : 'no'}`);
  if (!s.ready) {
    console.log(`Motivo:    ${s.reason}`);
    if (s.missing?.length) {
      const env = { baseUrl: 'CRM_BASE_URL', apiKey: 'CRM_API_KEY', apiSecret: 'CRM_API_SECRET',
        apiUser: 'CRM_API_USER', webhookUrl: 'CRM_WEBHOOK_URL' };
      console.log(`Faltan:    ${s.missing.map((m) => env[m] || m).join(', ')}`);
    }
  }
  console.log(`\nAdaptadores disponibles: ${Object.keys(adapters).join(', ')}`);
}

async function test() {
  const s = crmStatus();
  if (!s.ready) { status(); process.exit(1); }

  // Lead de prueba, reconocible y fácil de borrar después.
  const lead = {
    id: 0, uid: `test-${Date.now()}`, created_at: new Date().toISOString(),
    contact_channel: 'outbound', company: 'PRUEBA · Cali Clean Lead Machine',
    name: 'Prueba Conexión', email: `prueba+${Date.now()}@cali-clean.net`,
    phone: '+13105550100', website: 'https://cali-clean.net',
    address: '1200 Sunset Blvd', city: 'Los Angeles', zip: '90026', locale: 'es',
    segment: 'commercial', service_type: 'office', frequency: 'weekly',
    addons: '[]', quote_price: 480, quote_low: 420, quote_high: 540, annual_value: 24960,
    score: 72, temperature: 'hot',
    score_reasons: JSON.stringify([{ points: 26, reason: 'Segmento objetivo: Oficina o consultorio' }]),
    status: 'new', source: 'crm_connection_test', utm_source: 'test', in_service_area: 1,
  };

  console.log(`Creando un lead de prueba en ${s.label}…`);
  try {
    const { ref } = await adapters[s.driver].push(toPayload(lead, null), adapterConfig(), http);
    console.log(`\n✓ Creado${ref ? ` con id ${ref}` : ''}.`);
    console.log('  Búscalo en tu CRM como "PRUEBA · Cali Clean Lead Machine" y bórralo cuando lo veas.');
  } catch (err) {
    console.error(`\n✗ Falló: ${err.message}`);
    console.error('\n  Revisa la URL base, las credenciales y que el usuario de API tenga permiso sobre Leads.');
    process.exit(1);
  }
}

const commands = { detect, status, test };
if (!commands[command]) {
  console.log('Uso:');
  console.log('  node scripts/crm.js detect <url>   identifica qué CRM hay instalado');
  console.log('  node scripts/crm.js status         comprueba la configuración actual');
  console.log('  node scripts/crm.js test           crea un lead de prueba en el CRM');
  process.exit(1);
}
await commands[command]();
