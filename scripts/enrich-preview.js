/**
 * Qué se puede afirmar de las empresas que ya están en el CRM, sin salir a
 * buscar nada.
 *
 *   node scripts/enrich-preview.js            # preview, solo lectura
 *   node scripts/enrich-preview.js --limit 10
 *
 * No escribe. No visita webs. No adivina dominios, teléfonos ni correos. Lo que
 * propone sale de datos que el CRM ya tiene, con reglas tabuladas en
 * src/prospecting/enrich-planner.js, y lo que no está sustentado se queda vacío
 * y se dice por qué.
 */
import { config } from '../src/config.js';
import { createClient } from '../src/services/crm/twenty.js';
import { OBJECTS, COMPANY_FIELDS } from '../src/services/crm/twenty-schema.js';
import { planEnrichmentBatch, SCORE_RULES, typeIndexFromSnapshots } from '../src/prospecting/enrich-planner.js';
import { snapshotDir } from '../src/prospecting/sources/snapshot.js';
import fs from 'node:fs';
import path from 'node:path';

const rest = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? dflt : (rest[i + 1] ?? true);
};
const limit = Number(flag('limit', 60));
const title = (t) => console.log(`\n${t}\n${'─'.repeat(t.length)}`);

if (!config.twenty.baseUrl) {
  console.error('TWENTY_BASE_URL no está configurada.');
  process.exit(1);
}

const counts = { GET: 0, otros: 0 };
const client = createClient({
  baseUrl: config.twenty.baseUrl,
  fetchImpl: async (url, opts = {}) => {
    const m = String(opts.method || 'GET').toUpperCase();
    if (m === 'GET') counts.GET++; else counts.otros++;
    return fetch(url, opts);
  },
});

console.log('── PREVIEW DE ENRIQUECIMIENTO · solo lectura ──\n');
console.log(`CRM: ${config.twenty.baseUrl}`);

/**
 * Tipo y NAICS oficiales, desde los snapshots que tengamos en disco.
 *
 * El CRM no tiene campo para ninguno de los dos, así que esta es la única vía
 * verificable de asignar un segmento. Sin snapshot, el segmento se queda sin
 * asignar y se dice por qué: adivinarlo del nombre comercial sería inventar.
 */
function leerSnapshots() {
  const docs = [];
  let dir;
  try { dir = snapshotDir(); } catch { return docs; }
  let names;
  try { names = fs.readdirSync(dir); } catch { return docs; }
  for (const n of names.filter((f) => f.endsWith('.json'))) {
    try { docs.push(JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))); } catch { /* ilegible */ }
  }
  return docs;
}

const snapshots = leerSnapshots();
const typeIndex = typeIndexFromSnapshots(snapshots);
console.log(`Snapshots locales leídos: ${snapshots.length} · tipos oficiales conocidos: ${typeIndex.size}`);

const res = await client.get(`/${OBJECTS.companies}`, { limit, depth: 0 });
const companies = res?.data?.[OBJECTS.companies] || [];
console.log(`Empresas activas leídas: ${companies.length} de ${res?.totalCount ?? '?'}`);

title('Reglas de puntuación');
for (const r of SCORE_RULES) console.log(`  ${String(r.points).padStart(3)} pts · ${r.id.padEnd(22)} ${r.why}`);

const { plans, tally } = planEnrichmentBatch(companies.map((c) => ({
  dedupKey: c[COMPANY_FIELDS.dedupKey],
  name: c[COMPANY_FIELDS.name],
  serviceArea: c[COMPANY_FIELDS.serviceArea],
  leadScore: c[COMPANY_FIELDS.leadScore],
  leadStage: c[COMPANY_FIELDS.leadStage],
  sourceUrl: c[COMPANY_FIELDS.sourceUrl],
  businessEmail: c[COMPANY_FIELDS.businessEmail],
  domainName: c[COMPANY_FIELDS.domainName],
  address: c[COMPANY_FIELDS.address],
  // El tipo de establecimiento no vive en un campo propio del CRM: se deduce
  // del nombre del registro cuando no hay NAICS. Sin inventar nada.
  businessType: null,
  naics: null,
})), { typeIndex });

title('Propuestas por empresa');
for (const p of plans) {
  const mark = p.action === 'update' ? '~' : '=';
  console.log(`  ${mark} ${p.action.toUpperCase().padEnd(6)} ${p.name}`);
  console.log(`      score ${p.score}/100 → ${p.rating} · segmento ${p.segment ?? '(sin asignar)'}`
    + (p.typeBasis ? ` · tipo de ${p.typeBasis}` : ''));
  if (Object.keys(p.changes).length) {
    for (const [k, v] of Object.entries(p.changes)) console.log(`      ${k} = ${JSON.stringify(v)}`);
  }
  for (const r of p.reasons) console.log(`      · ${r}`);
}

title('Resumen');
console.log(`  a actualizar: ${tally.update}`);
console.log(`  sin cambios:  ${tally.noop}`);

const segmentos = {};
for (const p of plans) segmentos[p.segment ?? '(sin asignar)'] = (segmentos[p.segment ?? '(sin asignar)'] || 0) + 1;
console.log('  por segmento:');
for (const [k, v] of Object.entries(segmentos).sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(3)} ${k}`);

const ratings = {};
for (const p of plans) ratings[p.rating] = (ratings[p.rating] || 0) + 1;
console.log(`  por Lead Score: ${Object.entries(ratings).map(([k, v]) => `${k}=${v}`).join(' · ')}`);

title('Lo que NO se propone, y por qué');
const noProp = {};
for (const p of plans) for (const n of p.notProposed) noProp[n] = (noProp[n] || 0) + 1;
for (const [k, v] of Object.entries(noProp)) console.log(`  ${String(v).padStart(3)} × ${k}`);

title('Escrituras');
console.log(`  crm_writes: ${counts.otros}`);
console.log(`  peticiones: GET ${counts.GET} · otras ${counts.otros}`);
console.log(`  outbound: 0 · OUTBOUND_ENABLED: ${config.outbound.enabled}`);
if (counts.otros !== 0) { console.error('\n✗ hubo peticiones que no eran GET'); process.exit(1); }
console.log('\n✓ Preview de enriquecimiento sin una sola escritura. Nada aplicado.');
