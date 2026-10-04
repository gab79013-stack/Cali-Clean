/**
 * Qué se puede afirmar de las empresas que ya están en el CRM, sin salir a
 * buscar nada.
 *
 *   node scripts/enrich-preview.js                    # preview, solo lectura
 *   node scripts/enrich-preview.js --apply --confirm  # aplica (exige
 *                                                     #  TWENTY_WRITE_ENABLED=true)
 *
 * No visita webs. No adivina dominios, teléfonos ni correos. Lo que propone sale
 * de datos que el CRM ya tiene, con reglas tabuladas en
 * src/prospecting/enrich-planner.js, y lo que no está sustentado se queda vacío y
 * se dice por qué.
 *
 * Qué puede escribir, como máximo: `serviceArea` (solo si está vacía),
 * `leadScore` y `leadStage`. Nada más. `dedupKey`, `sourceUrl` y `lastVerified`
 * no se tocan nunca: son el rastro de procedencia, y reescribirlos borraría de
 * dónde salió cada empresa y cuándo se comprobó.
 */
import { config } from '../src/config.js';
import { createClient } from '../src/services/crm/twenty.js';
import { OBJECTS, COMPANY_FIELDS } from '../src/services/crm/twenty-schema.js';
import {
  planEnrichmentBatch, SCORE_RULES, MAX_SCORE_FROM_CRM, typeIndexFromSnapshots,
} from '../src/prospecting/enrich-planner.js';
import { snapshotDir } from '../src/prospecting/sources/snapshot.js';
import fs from 'node:fs';
import path from 'node:path';

const rest = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? dflt : (rest[i + 1] ?? true);
};
const limit = Number(flag('limit', 60));
const aplicar = rest.includes('--apply');
const confirmado = rest.includes('--confirm');
const title = (t) => console.log(`\n${t}\n${'─'.repeat(t.length)}`);

/**
 * Lo único que este script puede escribir. Lista cerrada y comprobada antes de
 * enviar: si una regla propusiera cualquier otra cosa, se omite y se cuenta.
 */
const CAMPOS_PERMITIDOS = Object.freeze(['serviceArea', 'leadScore', 'leadStage']);
const CAMPOS_INTOCABLES = Object.freeze(['dedupKey', 'sourceUrl', 'lastVerified', 'name', 'accountOwnerId']);

if (!config.twenty.baseUrl) {
  console.error('TWENTY_BASE_URL no está configurada.');
  process.exit(1);
}

if (aplicar) {
  if (!confirmado) {
    console.error('`--apply` exige --confirm.');
    process.exit(1);
  }
  if (config.twenty.dryRunDefault) {
    console.error('`--apply` exige TWENTY_WRITE_ENABLED=true en el entorno de ESTE comando.');
    process.exit(1);
  }
}

const counts = { GET: 0, PATCH: 0, otros: 0 };
const client = createClient({
  baseUrl: config.twenty.baseUrl,
  fetchImpl: async (url, opts = {}) => {
    const m = String(opts.method || 'GET').toUpperCase();
    if (m === 'GET') counts.GET++;
    else if (m === 'PATCH') counts.PATCH++;
    else counts.otros++;
    return fetch(url, opts);
  },
});

console.log(aplicar
  ? '── ENRIQUECIMIENTO · aplicando solo lo sustentado ──\n'
  : '── PREVIEW DE ENRIQUECIMIENTO · solo lectura ──\n');
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

// Todas las activas, paginando: enriquecer solo la primera página dejaría al
// resto con un score que nadie volvería a revisar.
const companies = [];
let cursor = null;
let totalCount = null;
for (let page = 0; page < 50; page++) {
  const query = { limit, depth: 0, order_by: 'id[AscNullsLast]' };
  if (cursor) query.starting_after = cursor;
  const res = await client.get(`/${OBJECTS.companies}`, query);
  const rows = res?.data?.[OBJECTS.companies] || [];
  totalCount = res?.totalCount ?? totalCount;
  companies.push(...rows);
  if (!rows.length || !res?.pageInfo?.hasNextPage || !res?.pageInfo?.endCursor) break;
  cursor = res.pageInfo.endCursor;
}
console.log(`Empresas activas leídas: ${companies.length} de ${totalCount ?? '?'}`);
if (totalCount !== null && companies.length !== totalCount) {
  console.error(`✗ se leyeron ${companies.length} de ${totalCount}: no se enriquece una parte a ciegas`);
  process.exit(1);
}

title('Reglas de puntuación');
for (const r of SCORE_RULES) {
  console.log(`  ${String(r.points).padStart(3)} pts · ${r.id.padEnd(22)} ${r.why}`
    + (r.fromCrm ? '' : '  [informativa: el CRM no la sostiene, no puntúa]'));
}
console.log(`  Máximo que el CRM puede sostener: ${MAX_SCORE_FROM_CRM}`);

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
  console.log(`      score ${p.score}/${MAX_SCORE_FROM_CRM} → ${p.rating} · segmento ${p.segment ?? '(sin asignar)'}`
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

// ── Aplicación ───────────────────────────────────────────────
let aplicadas = 0;
let omitidas = 0;
const errores = [];
if (aplicar) {
  title('Aplicando');
  const porClave = new Map(companies.map((c) => [c[COMPANY_FIELDS.dedupKey], c]));
  for (const p of plans) {
    if (p.action !== 'update') continue;
    const company = porClave.get(p.dedupKey);
    if (!company) { omitidas++; continue; }

    // Se filtra el cuerpo contra la lista cerrada. Una propuesta fuera de ella
    // no se envía: se cuenta y se dice.
    const body = {};
    const fuera = [];
    for (const [k, v] of Object.entries(p.changes)) {
      if (CAMPOS_INTOCABLES.includes(k)) { fuera.push(k); continue; }
      if (!CAMPOS_PERMITIDOS.includes(k)) { fuera.push(k); continue; }
      body[k] = v;
    }
    if (fuera.length) {
      omitidas++;
      console.log(`  ! OMITIDO en ${p.name}: ${fuera.join(', ')} (fuera de la lista permitida)`);
    }
    if (!Object.keys(body).length) continue;

    try {
      await client.patch(`/${OBJECTS.companies}/${company.id}`, body);
      aplicadas++;
      console.log(`  ~ ${p.name}: ${Object.keys(body).join(', ')}`);
    } catch (err) {
      errores.push({ name: p.name, error: err.message });
      console.error(`  ! ERROR ${p.name}: ${err.message}`);
      // Fail-closed: se para en el primero. Un enriquecimiento a medias con
      // reintentos a ciegas es cómo se corrompe un CRM.
      break;
    }
  }
  console.log(`\n  aplicadas: ${aplicadas} · omitidas: ${omitidas} · errores: ${errores.length}`);
}

title('Escrituras');
console.log(`  crm_writes: ${counts.PATCH + counts.otros}`);
console.log(`  peticiones: GET ${counts.GET} · PATCH ${counts.PATCH} · otras ${counts.otros}`);
console.log(`  outbound: 0 · OUTBOUND_ENABLED: ${config.outbound.enabled}`);
console.log(`  campos escribibles: ${CAMPOS_PERMITIDOS.join(', ')}`);
console.log(`  campos intocables:  ${CAMPOS_INTOCABLES.join(', ')}`);

if (counts.otros !== 0) { console.error('\n✗ hubo peticiones de un método inesperado'); process.exit(1); }
if (!aplicar && counts.PATCH !== 0) { console.error('\n✗ una preview escribió'); process.exit(1); }
if (errores.length) { console.error('\n✗ enriquecimiento incompleto, detenido en el primer error'); process.exit(1); }
console.log(aplicar
  ? `\n✓ ${aplicadas} empresas enriquecidas. Solo serviceArea/leadScore/leadStage.`
  : '\n✓ Preview de enriquecimiento sin una sola escritura. Nada aplicado.');
