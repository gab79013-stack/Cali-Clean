/**
 * Un ciclo de recolección de una fuente, en dos pasos que comparten una sola
 * consulta.
 *
 *   node scripts/source-run.js preview                    # consulta y enseña
 *   node scripts/source-run.js sync --snapshot <f> --confirm   # reutiliza
 *
 * Por qué dos pasos y una consulta: si `sync` volviera a preguntar al portal,
 * gastaría una segunda cuota y —lo importante— escribiría en el CRM algo que
 * nadie ha visto, porque entre las dos consultas el dataset puede cambiar. Así
 * que `preview` consulta una vez, deja un snapshot con hash, y `sync` reutiliza
 * exactamente ese archivo. Lo que se escribe es literalmente lo que se enseñó.
 *
 * Qué NO hace este script en ningún modo:
 *   · no escribe en el CRM sin TWENTY_WRITE_ENABLED=true y --confirm;
 *   · no planifica personas ni oportunidades, solo empresas;
 *   · no envía mensajes: el outbound no se toca desde aquí.
 *
 * Las escrituras no se dan por buenas: el cliente del CRM va envuelto en un
 * contador de métodos, y el informe final imprime lo que ese contador midió.
 */
import { config } from '../src/config.js';
import { SOURCES, fetchFromSource, sourceStatus } from '../src/prospecting/sources/index.js';
import { allowedFields, forbiddenFields } from '../src/prospecting/sources/compliance.js';
import { attestationFor, verifyAttestation, loadAttestation } from '../src/prospecting/sources/attestation.js';
import { MAX_ROWS_PER_RUN, WINDOW_MS } from '../src/prospecting/sources/quota.js';
import {
  writeSnapshot, readSnapshot, summarize, sessionId, latestSnapshot,
} from '../src/prospecting/sources/snapshot.js';
import { createClient, planCompanyUpsert, lowestDedupKeyWithPrefix } from '../src/services/crm/twenty.js';

const [command, ...rest] = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? dflt : (rest[i + 1] ?? true);
};
const confirmed = rest.includes('--confirm');
const sourceKey = String(flag('source', 'sdcounty_food_facility_permits'));
const rowLimit = Number(flag('limit', MAX_ROWS_PER_RUN));

const title = (t) => console.log(`\n${t}\n${'─'.repeat(t.length)}`);
const die = (msg, code = 1) => { console.error(`\n✗ ${msg}`); process.exit(code); };

/** Cliente del CRM con contador de métodos. El informe cita el contador. */
function countingClient() {
  const counts = { GET: 0, POST: 0, PATCH: 0, PUT: 0, DELETE: 0, otros: 0 };
  const client = createClient({
    baseUrl: config.twenty.baseUrl,
    fetchImpl: async (url, opts = {}) => {
      const method = String(opts.method || 'GET').toUpperCase();
      if (counts[method] === undefined) counts.otros++; else counts[method]++;
      return fetch(url, opts);
    },
  });
  const writes = () => counts.POST + counts.PATCH + counts.PUT + counts.DELETE + counts.otros;
  return { client, counts, writes };
}

/** La attestation es la primera puerta: sin ella no se consulta nada. */
function requireAttestation() {
  const att = attestationFor(sourceKey);
  if (!att.ok) {
    const detalle = att.problems?.length ? att.problems.join('; ') : att.reason;
    die(`la attestation no vale para ${sourceKey}: ${detalle}`);
  }
  const full = verifyAttestation(loadAttestation());
  console.log(`Attestation: válida · evidencia del ${att.attestation.evidenceCollectedAt}`);
  console.log(`             digest ${full.expectedDigest}`);
  console.log(`             comprobado sin red: estructura, digest y antigüedad.`);
  console.log(`             NO comprobado: hashes upstream (evidencia importada) y firma (no hay clave).`);
  return att;
}

function requireGate() {
  const estado = sourceStatus().find((s) => s.key === sourceKey);
  if (!estado) die(`fuente desconocida: ${sourceKey}`);
  console.log(`Fuente:      ${estado.label}`);
  console.log(`             ${estado.state} · habilitada ${estado.enabled} · permitida ${estado.allowed}`);
  if (!estado.allowed) die(`la puerta la bloquea: ${estado.code || estado.reason}`);

  const otras = sourceStatus().filter((s) => s.key !== sourceKey && s.allowed);
  if (otras.length) die(`hay otras fuentes permitidas y no debería: ${otras.map((o) => o.key).join(', ')}`);
  return estado;
}

/** Enseña el plan contra el CRM sin tocar nada: solo GET, solo Companies. */
async function planCompanies(rows) {
  if (!config.twenty.baseUrl) {
    console.log('  (TWENTY_BASE_URL no está configurada: no hay plan que enseñar)');
    return { plans: [], counts: null, writes: 0 };
  }
  const { client, counts, writes } = countingClient();
  const plans = [];
  for (const row of rows) {
    try {
      const plan = await planCompanyUpsert(client, {
        dedupKey: row.dedupKey,
        businessName: row.businessName,
        sourceUrl: row.sourceUrl,
        sourceLabel: row.sourceLabel,
        serviceArea: row.serviceArea,
        address: row.address,
        city: row.city,
        zip: row.zip,
        state: 'CA',
        country: 'US',
        stage: 'discovered',
        // Procedencia: registro público del condado. El enum del CRM no tiene
        // PUBLIC_RECORD, y añadirlo sería cambiar el esquema del CRM; de los
        // valores que existen, un registro oficial de establecimientos es un
        // directorio, no la web del propio negocio.
        channel: 'public_record',
        lastVerified: new Date().toISOString(),
      });
      plans.push({ dedupKey: plan.dedupKey, name: plan.name, action: plan.action, id: plan.id || null });
    } catch (err) {
      plans.push({ dedupKey: row.dedupKey, name: row.businessName, action: 'error', error: err.message });
    }
  }
  return { plans, counts, writes: writes() };
}

function printMetrics(metrics) {
  for (const [k, v] of Object.entries(metrics)) console.log(`  ${k.padEnd(22)} ${v}`);
}

function printCandidates(rows) {
  const resumen = summarize(rows);
  for (const c of resumen) {
    console.log(`  · ${c.businessName}`);
    console.log(`      ${c.city} ${c.zip} · ${c.businessType} · ${c.permitStatus}`);
    console.log(`      record ${c.recordIdPartial} · dedupKey ${c.dedupKey}`);
  }
  return resumen;
}

function printPlan(plans) {
  const tally = { create: 0, update: 0, noop: 0, error: 0 };
  for (const p of plans) {
    tally[p.action] = (tally[p.action] || 0) + 1;
    const mark = { create: '+', update: '~', noop: '=', error: '!' }[p.action] || '?';
    console.log(`  ${mark} ${String(p.action).toUpperCase().padEnd(6)} ${p.name}${p.error ? ` — ${p.error}` : ''}`);
  }
  console.log(`  → crear ${tally.create} · actualizar ${tally.update} · sin cambios ${tally.noop} · errores ${tally.error}`);
  return tally;
}

// ── preview ──────────────────────────────────────────────────
async function preview() {
  console.log('── PREVIEW · una consulta, sin escribir en ningún sitio ──\n');
  requireAttestation();
  requireGate();

  console.log(`Sesión:      ${sessionId() ? `${sessionId().slice(0, 8)}…` : 'SIN IDENTIFICAR (el snapshot no se podrá reutilizar)'}`);
  console.log(`Límites:     ${MAX_ROWS_PER_RUN} filas/corrida · 1 corrida con éxito cada ${WINDOW_MS / 3600000} h`);
  console.log(`Campos:      ${allowedFields(sourceKey).length} permitidos · ${forbiddenFields(sourceKey).length} prohibidos`);

  const crmConfigured = Boolean(config.twenty.baseUrl);
  let crmLookup = null;
  if (crmConfigured) {
    const { client } = countingClient();
    crmLookup = (prefix) => lowestDedupKeyWithPrefix(client, prefix);
  }

  const result = await fetchFromSource(sourceKey, {
    limit: rowLimit,
    cursorOptions: {
      crmConfigured,
      crmLookup,
      // Mirar qué traería el bootstrap no escribe nada, así que para la preview
      // se permite sin CRM. Para sincronizar, no.
      allowBootstrapWithoutCrm: true,
    },
  });

  title('Modo de la corrida');
  console.log(`  modo:    ${result.cursor?.mode}`);
  console.log(`  origen:  ${result.cursor?.origin}`);
  console.log(`  cursor:  ${result.cursor?.cursor ?? '(ninguno: primera corrida)'}`);
  if (result.cursor?.detail) console.log(`  detalle: ${result.cursor.detail}`);

  if (result.blocked) {
    console.log(`\n  BLOQUEADA: ${result.blocked.reason} — ${result.blocked.detail}`);
    die('la corrida queda bloqueada. Es el sistema funcionando, no un error.', 2);
  }

  title('Métricas');
  printMetrics(result.metrics);

  if (!result.rows.length) {
    title('Sin candidatos');
    console.log('  La consulta llegó al portal y ninguna fila sobrevivió a los filtros.');
    console.log('  No se escribe snapshot: no hay nada que reutilizar.');
    die('fail-closed: cero candidatos válidos.', 3);
  }

  title(`Candidatos empresariales (${result.rows.length})`);
  printCandidates(result.rows);

  const snap = writeSnapshot({
    sourceId: sourceKey,
    mode: result.cursor.mode,
    cursorIn: result.cursor.cursor,
    cursorOut: result.cursor.cursorOut,
    rows: result.rows,
    metrics: result.metrics,
  });

  title('Snapshot');
  console.log(`  archivo: ${snap.file}`);
  console.log(`  hash:    ${snap.hash}`);
  console.log(`  cursor:  ${snap.doc.cursorIn ?? '(ninguno)'} → ${snap.doc.cursorOut ?? '(sin avanzar)'}`);
  console.log('  Fuera de git. Caduca en 6 h y solo se reutiliza desde esta misma sesión.');

  title('Plan contra el CRM (solo lectura, solo Companies)');
  const { plans, counts, writes } = await planCompanies(result.rows);
  printPlan(plans);

  title('Lo que esta ejecución NO hizo');
  console.log(`  crm_writes:       ${writes}`);
  console.log(`  outbound:         ${result.metrics.outbound}`);
  console.log(`  OUTBOUND_ENABLED: ${config.outbound.enabled}`);
  if (counts) console.log(`  peticiones al CRM: ${JSON.stringify(counts)}`);

  const problemas = [];
  if (writes !== 0) problemas.push(`hubo ${writes} escrituras en el CRM`);
  if (config.outbound.enabled) problemas.push('OUTBOUND_ENABLED está en true');
  if (problemas.length) die(problemas.join('; '));

  console.log('\n✓ Preview limpia. Para sincronizar con ESTE snapshot, en esta misma sesión:');
  console.log(`    node scripts/source-run.js sync --snapshot ${snap.file} --confirm`);
}

// ── sync ─────────────────────────────────────────────────────
async function sync() {
  const file = flag('snapshot', latestSnapshot(sourceKey));
  if (!file || file === true) die('falta --snapshot <archivo> y no hay ninguno reciente.');
  if (!confirmed) die('`sync` exige --confirm: reutilizar un snapshot es una decisión, no un descuido.');

  console.log('── SYNC · reutilizando un snapshot, sin volver a consultar la fuente ──\n');
  const { ok, doc, problems } = readSnapshot(String(file));
  if (!ok) {
    for (const p of problems) console.error(`  · ${p}`);
    die('el snapshot no se puede reutilizar.');
  }

  console.log(`Snapshot: ${file}`);
  console.log(`  hash:   ${doc.sha256}`);
  console.log(`  creado: ${doc.createdAt} · modo ${doc.mode} · ${doc.rowCount} filas`);
  console.log(`  sesión: la misma que lo creó`);
  console.log('  Peticiones a la fuente en este paso: 0. Cuota consumida: 0.');

  title('Plan contra el CRM (solo Companies)');
  const { plans, counts, writes } = await planCompanies(doc.rows);
  const tally = printPlan(plans);

  const puedeEscribir = !config.twenty.dryRunDefault;
  title('Resultado');
  if (!puedeEscribir) {
    console.log('  TWENTY_WRITE_ENABLED no está en true: esto se queda en plan.');
    console.log('  Nada se creó, nada se actualizó, nada se eliminó.');
  } else {
    console.log('  TWENTY_WRITE_ENABLED está en true, pero este script no escribe:');
    console.log('  la escritura vive en twenty-sync.js, que exige su propio --confirm.');
  }
  console.log(`  crm_writes:       ${writes}`);
  console.log(`  outbound:         0`);
  console.log(`  OUTBOUND_ENABLED: ${config.outbound.enabled}`);
  if (counts) console.log(`  peticiones al CRM: ${JSON.stringify(counts)}`);

  if (writes !== 0) die(`hubo ${writes} escrituras y no debía haber ninguna`);
  console.log(`\n✓ Reutilización limpia: ${tally.create} a crear, ${tally.update} a actualizar, sin una escritura.`);
}

const commands = { preview, sync };
if (!commands[command]) {
  console.log('Uso:');
  console.log('  node scripts/source-run.js preview [--limit 50] [--source <clave>]');
  console.log('  node scripts/source-run.js sync --snapshot <archivo> --confirm');
  process.exit(1);
}
await commands[command]();
