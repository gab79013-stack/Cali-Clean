/**
 * Sincronización con Twenty CRM.
 *
 *   node scripts/twenty-sync.js schema            # contrasta el esquema vivo
 *   node scripts/twenty-sync.js dry-run           # plan, sin una sola escritura
 *   node scripts/twenty-sync.js dry-run --limit 5
 *   node scripts/twenty-sync.js apply --confirm   # escribe (exige confirmar)
 *
 * `dry-run` es el modo por defecto a propósito. Escribir en el CRM de un cliente
 * tiene que ser una decisión explícita, no lo que pasa si te equivocas de
 * subcomando.
 */
import { config } from '../src/config.js';
import { db } from '../src/db.js';
import { createClient, planProspect, upsertCompany, findCompanyByDedupKey } from '../src/services/crm/twenty.js';
import { COMPANY_FIELDS, ENUMS } from '../src/services/crm/twenty-schema.js';

const [command, ...rest] = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? dflt : (rest[i + 1] ?? true);
};
const limit = Number(flag('limit', 10));
const confirmed = rest.includes('--confirm');

function requireBaseUrl() {
  if (!config.twenty.baseUrl) {
    console.error('TWENTY_BASE_URL no está configurada.');
    process.exit(1);
  }
  console.log(`CRM:  ${config.twenty.baseUrl}`);
  console.log(`Auth: ${config.twenty.hasExplicitKey
    ? 'TWENTY_API_KEY del entorno (su valor nunca se imprime)'
    : 'inyectado por el entorno para el dominio autorizado'}\n`);
}

/** Contrasta lo que el código espera con lo que la instancia dice tener hoy. */
async function schema() {
  requireBaseUrl();
  const res = await fetch(`${config.twenty.baseUrl}/rest/open-api/core`, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    console.error(`No se pudo leer el OpenAPI: HTTP ${res.status}`);
    if ((res.status === 401 || res.status === 403) && process.env.HTTPS_PROXY && !process.env.NODE_USE_ENV_PROXY) {
      console.error('Pista: el fetch de Node no está usando el HTTPS_PROXY de este entorno,');
      console.error('así que la petición sale sin el Authorization inyectado.');
      console.error('Repite con: NODE_USE_ENV_PROXY=1 node scripts/twenty-sync.js schema');
    }
    process.exit(1);
  }
  const spec = await res.json();
  const live = spec?.components?.schemas?.Company?.properties || {};
  console.log(`API: ${spec?.info?.title} ${spec?.info?.version}\n`);

  let problems = 0;
  console.log('Campos que usa el adaptador:');
  for (const [internal, apiName] of Object.entries(COMPANY_FIELDS)) {
    const present = Object.hasOwn(live, apiName);
    if (!present) problems++;
    console.log(`  ${present ? '✓' : '✗'} ${apiName}${internal !== apiName ? ` (${internal})` : ''}`);
  }

  console.log('\nEnumeraciones:');
  for (const [field, expected] of Object.entries(ENUMS)) {
    if (field === 'opportunityStage') continue;
    const actual = live[field]?.enum;
    if (!actual) { console.log(`  ✗ ${field}: no existe en la instancia`); problems++; continue; }
    const missing = expected.filter((v) => !actual.includes(v));
    const extra = actual.filter((v) => !expected.includes(v));
    const ok = !missing.length && !extra.length;
    if (!ok) problems++;
    console.log(`  ${ok ? '✓' : '✗'} ${field}${missing.length ? ` · faltan: ${missing.join(',')}` : ''}${extra.length ? ` · nuevos en el CRM: ${extra.join(',')}` : ''}`);
  }

  console.log(problems ? `\n✗ ${problems} discrepancias: no sincronices hasta resolverlas.` : '\n✓ El contrato coincide con la instancia.');
  process.exit(problems ? 2 : 0);
}

/** Prospectos que tienen sentido mandar al CRM. */
function selectProspects(max) {
  return db.prepare(`
    SELECT * FROM prospects
     WHERE dedupe_key IS NOT NULL AND TRIM(dedupe_key) <> ''
       AND business_name IS NOT NULL AND TRIM(business_name) <> ''
       AND stage IN ('enriched','qualified','contacted')
     ORDER BY icp_score DESC, updated_at DESC
     LIMIT ?`).all(max);
}

const safeParse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };

/** Fila de la base al prospecto que entiende el adaptador. */
function toProspect(row) {
  const evidence = safeParse(row.evidence_json, {});
  return {
    dedupKey: row.dedupe_key,
    businessName: row.business_name,
    website: row.website,
    sourceUrl: row.source_url || null,
    source: row.source,
    sourceLabel: row.source,
    email: row.email,
    phone: row.phone,
    contactName: row.contact_name,
    contactSource: row.email_source === 'published_on_website' && row.contact_name ? 'business_website' : null,
    address: row.address,
    city: row.city,
    zip: row.zip,
    serviceArea: row.service_area || null,
    icpScore: row.icp_score,
    stage: row.stage,
    optedOut: /opted_out|suppressed|unsubscribed/.test(String(row.reject_reason || '')),
    channel: 'outbound',
    lastVerified: evidence?.enrich ? row.updated_at : null,
    estAnnualValue: row.est_annual_value,
    estVisitValue: row.est_visit_value,
  };
}

async function run({ dryRun }) {
  requireBaseUrl();
  if (!dryRun && !confirmed) {
    console.error('`apply` exige --confirm. Sin él no se escribe nada.');
    process.exit(1);
  }
  console.log(dryRun ? '── DRY RUN · ninguna escritura ──\n' : '── APLICANDO CAMBIOS ──\n');

  const client = createClient({ baseUrl: config.twenty.baseUrl });
  const rows = selectProspects(limit);
  if (!rows.length) {
    console.log('No hay prospectos que sincronizar.');
    console.log('(se necesitan prospectos con clave de deduplicación y etapa enriched/qualified/contacted)');
    return;
  }

  const tally = { create: 0, update: 0, noop: 0, error: 0, people: 0, opportunities: 0 };
  for (const row of rows) {
    const prospect = toProspect(row);
    try {
      const plan = dryRun
        ? await planProspect(client, prospect)
        : { company: await upsertCompany(client, prospect, { dryRun: false }) };

      const c = plan.company;
      tally[c.action] = (tally[c.action] || 0) + 1;
      const mark = { create: '+', update: '~', noop: '=' }[c.action] || '?';
      console.log(`${mark} ${c.action.toUpperCase().padEnd(6)} ${prospect.businessName}`);
      console.log(`    dedupKey: ${c.dedupKey}`);
      if (c.id) console.log(`    id: ${c.id}`);
      const fields = Object.keys(c.changes || {});
      if (fields.length) {
        console.log(`    campos: ${fields.join(', ')}`);
        for (const f of ['contactabilityStatus', 'leadStage', 'leadScore', 'serviceArea']) {
          if (c.changes[f] !== undefined) console.log(`      ${f} = ${JSON.stringify(c.changes[f])}`);
        }
      }
      if (dryRun && plan.person) { tally.people++; console.log('    + persona (contacto publicado en su web)'); }
      if (dryRun && plan.opportunity) { tally.opportunities++; console.log(`    + oportunidad ${plan.opportunity.amount.amountMicros / 1e6} USD`); }
    } catch (err) {
      tally.error++;
      console.log(`! ERROR  ${prospect.businessName}: ${err.message}`);
    }
  }

  console.log(`\nResumen: ${tally.create} a crear · ${tally.update} a actualizar · ${tally.noop} sin cambios · ${tally.error} con error`);
  if (dryRun) {
    console.log(`         ${tally.people} personas y ${tally.opportunities} oportunidades acompañarían a sus empresas`);
    console.log('\nNo se escribió nada. Para aplicar: node scripts/twenty-sync.js apply --confirm');
  }
}

/** Comprobación puntual de una clave, útil para demostrar idempotencia. */
async function lookup() {
  requireBaseUrl();
  const key = flag('key', rest[0]);
  if (!key || key === true) { console.error('Uso: node scripts/twenty-sync.js lookup --key <dedupKey>'); process.exit(1); }
  const client = createClient({ baseUrl: config.twenty.baseUrl });
  const found = await findCompanyByDedupKey(client, String(key));
  console.log(found ? `Encontrada: ${found.name} (id ${found.id})` : 'Ninguna empresa con esa clave.');
}

const commands = {
  schema,
  'dry-run': () => run({ dryRun: true }),
  apply: () => run({ dryRun: false }),
  lookup,
};

if (!commands[command]) {
  console.log('Uso:');
  console.log('  node scripts/twenty-sync.js schema            contrasta el esquema vivo');
  console.log('  node scripts/twenty-sync.js dry-run           plan, sin escrituras');
  console.log('  node scripts/twenty-sync.js lookup --key K    busca por clave');
  console.log('  node scripts/twenty-sync.js apply --confirm   escribe de verdad');
  process.exit(1);
}
await commands[command]();
