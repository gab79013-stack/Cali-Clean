/**
 * Un ciclo de recolección de una fuente, en dos pasos que comparten una sola
 * consulta.
 *
 *   node scripts/source-run.js preview                          # consulta y enseña
 *   node scripts/source-run.js sync  --snapshot <f> --confirm   # plan, sin escribir
 *   node scripts/source-run.js apply --snapshot <f> --confirm \
 *        --expect-hash sha256:… --max-creates 38                # escribe Companies
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
import {
  createClient, planCompanyUpsert, upsertCompany,
  lowestDedupKeyWithPrefix, latestVerifiedWithPrefix, loadCrmIndex,
} from '../src/services/crm/twenty.js';
import { normalizeForMatch } from '../src/prospecting/sources/city-btc-rules.js';
import { formatSourceReport, detectAlerts } from '../src/prospecting/sources/report.js';

const [command, ...rest] = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? dflt : (rest[i + 1] ?? true);
};
const confirmed = rest.includes('--confirm');
const expectHash = flag('expect-hash', null);
const maxCreates = Number(flag('max-creates', 0));
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
  // La attestation de cada fuente vive en su propio archivo, con su propio
  // digest: que la de otra fuente caduque no puede bloquear a esta.

  if (!att.ok) {
    const detalle = att.problems?.length ? att.problems.join('; ') : att.reason;
    die(`la attestation no vale para ${sourceKey}: ${detalle}`);
  }
  console.log(`Attestation: válida · evidencia del ${att.attestation.evidenceCollectedAt}`);
  console.log(`             archivo ${att.file.split('/').pop()}`);
  console.log(`             digest ${att.attestation.digest}`);
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

  // Se informa de qué más está permitido, pero no se bloquea por ello: el
  // catálogo es multi-fuente y cada una responde por su propia puerta.
  const otras = sourceStatus().filter((s) => s.key !== sourceKey && s.allowed);
  console.log(`Otras permitidas: ${otras.length ? otras.map((o) => o.key).join(', ') : 'ninguna'}`);
  return estado;
}

/**
 * Una fila del snapshot convertida en prospecto. Un solo sitio, para que el
 * plan y la escritura no puedan divergir ni por un campo.
 *
 * `verifiedAt` es la marca del snapshot, no la hora de ahora. Dos razones, y
 * las dos importan: es cuando de verdad se comprobó el dato contra el registro
 * oficial, y además hace la operación idempotente — con `new Date()` cada
 * pasada propondría actualizar `lastVerified` y nunca llegaría a `noop`.
 */
function prospectFromRow(row, verifiedAt) {
  return {
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
    // Procedencia: registro público del condado. De los cuatro valores que el
    // enum del CRM ya tiene, un catálogo oficial de establecimientos es un
    // directorio; PUBLIC_WEBSITE sería mentir, porque a ese negocio no se le ha
    // visitado la web. No se añade un valor nuevo: eso sería cambiar el esquema.
    channel: 'public_record',
    lastVerified: verifiedAt,
  };
}

/** Enseña el plan contra el CRM sin tocar nada: solo GET, solo Companies. */
async function planCompanies(rows, verifiedAt) {
  if (!config.twenty.baseUrl) {
    console.log('  (TWENTY_BASE_URL no está configurada: no hay plan que enseñar)');
    return { plans: [], counts: null, writes: 0 };
  }
  const { client, counts, writes } = countingClient();
  const plans = [];
  for (const row of rows) {
    try {
      const plan = await planCompanyUpsert(client, prospectFromRow(row, verifiedAt));
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
  const attInfo = requireAttestation();
  requireGate();

  console.log(`Sesión:      ${sessionId() ? `${sessionId().slice(0, 8)}…` : 'SIN IDENTIFICAR (el snapshot no se podrá reutilizar)'}`);
  console.log(`Límites:     ${MAX_ROWS_PER_RUN} filas/corrida · 1 corrida con éxito cada ${WINDOW_MS / 3600000} h`);
  console.log(`Campos:      ${allowedFields(sourceKey).length} permitidos · ${forbiddenFields(sourceKey).length} prohibidos`);

  const crmConfigured = Boolean(config.twenty.baseUrl);
  let crmLookup = null;
  let verifiedLookup = null;
  if (crmConfigured) {
    const { client } = countingClient();
    crmLookup = (prefix) => lowestDedupKeyWithPrefix(client, prefix);
    verifiedLookup = (prefix) => latestVerifiedWithPrefix(client, prefix);
  }

  // Índice de lo que el CRM ya tiene. Lo necesitan las fuentes que avanzan
  // comparándose con él, y sirve de deduplicación cruzada para todas.
  let crmIndex = null;
  if (crmConfigured) {
    const { client } = countingClient();
    try {
      crmIndex = await loadCrmIndex(client, { normalize: normalizeForMatch });
      title('Índice del CRM');
      console.log(`  empresas indexadas: ${crmIndex.total} en ${crmIndex.pages} página(s)`);
      console.log(`  claves: ${crmIndex.dedupKeys.size} · nombre+dirección: ${crmIndex.crossKeys.size}`);
      if (!crmIndex.complete) {
        die('el índice del CRM quedó incompleto: con un índice a medias se crearían duplicados.');
      }
    } catch (err) {
      // Una fuente que lo exige se bloqueará abajo; una que no, sigue sin él.
      console.log(`  (no se pudo leer el índice del CRM: ${err.message})`);
      crmIndex = null;
    }
  }

  const result = await fetchFromSource(sourceKey, {
    limit: rowLimit,
    crmIndex,
    userAgent: config.prospecting.userAgent,
    // La cuota que sobrevive al contenedor. Si el CRM no está configurado no se
    // puede comprobar, y entonces la única defensa es la local: se dice en voz
    // alta en lugar de dar por bueno el silencio.
    durableQuotaOptions: { lookup: verifiedLookup, required: crmConfigured },
    cursorOptions: {
      crmConfigured,
      crmLookup,
      // Mirar qué traería el bootstrap no escribe nada, así que para la preview
      // se permite sin CRM. Para sincronizar, no.
      allowBootstrapWithoutCrm: true,
    },
  });

  if (result.durableQuota) {
    title('Cuota durable (autoridad: el CRM)');
    console.log(`  permitida: ${result.durableQuota.allowed}`);
    console.log(`  última ingestión visible: ${result.durableQuota.lastVerifiedAt ?? '(ninguna)'}`);
    console.log(`  ${result.durableQuota.detail}`);
  }

  // Cuando la cuota durable bloquea, el cursor no se llega a resolver: no hay
  // modo del que informar, y escribir "undefined" sería ruido.
  if (result.cursor) {
    title('Modo de la corrida');
    console.log(`  modo:    ${result.cursor.mode}`);
    console.log(`  origen:  ${result.cursor.origin}`);
    console.log(`  cursor:  ${result.cursor.cursor ?? '(ninguno: primera corrida)'}`);
    if (result.cursor.detail) console.log(`  detalle: ${result.cursor.detail}`);
  }

  if (result.blocked) {
    console.log(`\n  BLOQUEADA: ${result.blocked.reason} — ${result.blocked.detail}`);
    console.log(`  quota_blocked=${result.metrics.quota_blocked} · fetched=${result.metrics.fetched}`
      + ` · crm_writes=0 · outbound=0 · peticiones al Condado: 0`);
    die('la corrida queda bloqueada. Es el sistema funcionando, no un error.', 2);
  }

  if (result.csv) {
    title('Archivo descargado');
    console.log(`  bytes:        ${result.csv.bytes}`);
    console.log(`  sha256:       ${result.csv.sha256}`);
    console.log(`  last-modified: ${result.csv.headers?.lastModified ?? '(sin cabecera)'}`);
    console.log(`  etag:         ${result.csv.headers?.etag ?? '(sin cabecera)'}`);
    console.log('  Es la huella de UN volcado diario, no una constante: el publicador');
    console.log('  reemplaza el archivo cada día y el hash cambia con él.');
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
  const { plans, counts, writes } = await planCompanies(result.rows, new Date().toISOString());
  const tally = printPlan(plans);
  result.metrics.planned_create = tally.create;
  result.metrics.planned_update = tally.update;
  result.metrics.planned_noop = tally.noop;
  result.metrics.errors = tally.error;

  const alerts = detectAlerts({
    sourceId: sourceKey,
    metrics: result.metrics,
    csv: result.csv,
    blocked: result.blocked,
    attestedBytes: attInfo?.entry?.artifacts?.csvHead?.contentLength ?? null,
  });
  title('Informe de la fuente');
  console.log(formatSourceReport({
    sourceId: sourceKey,
    label: SOURCES[sourceKey].label,
    metrics: result.metrics,
    csv: result.csv,
    blocked: result.blocked,
    plan: tally,
    alerts,
  }));

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
  const { plans, counts, writes } = await planCompanies(doc.rows, doc.createdAt);
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

// ── apply ────────────────────────────────────────────────────
/**
 * La única ruta que escribe, y escribe solo Companies.
 *
 * Cinco cerrojos, y hacen falta los cinco:
 *   1. `--confirm`;
 *   2. `TWENTY_WRITE_ENABLED=true` en el entorno;
 *   3. el hash esperado, pasado a mano: autoriza UN snapshot concreto, no
 *      "el último que haya";
 *   4. el hash, la sesión y el TTL del propio archivo;
 *   5. un tope de creaciones, también a mano.
 *
 * Y una regla al fallar: se para en el primer error y no se reintenta. Un
 * reintento automático sobre un CRM a medio escribir es cómo se duplica.
 */
async function apply() {
  const file = flag('snapshot', null);
  if (!file || file === true) die('falta --snapshot <archivo>. `apply` no adivina cuál.');
  if (!confirmed) die('`apply` exige --confirm.');
  if (config.twenty.dryRunDefault) {
    die('`apply` exige TWENTY_WRITE_ENABLED=true en el entorno de ESTE comando.');
  }
  if (!expectHash || expectHash === true) {
    die('`apply` exige --expect-hash <sha256:…>: se autoriza un snapshot concreto, no el último que haya.');
  }
  if (!Number.isInteger(maxCreates) || maxCreates <= 0) {
    die('`apply` exige --max-creates <n>: el tope de creaciones se pone a mano.');
  }

  console.log('── APPLY · escribiendo Companies desde un snapshot ya revisado ──\n');

  const { ok, doc, problems } = readSnapshot(String(file));
  if (!ok) {
    for (const p of problems) console.error(`  · ${p}`);
    die('el snapshot no se puede reutilizar. No se escribe nada.');
  }
  if (doc.sha256 !== String(expectHash)) {
    console.error(`  esperado: ${expectHash}`);
    console.error(`  del archivo: ${doc.sha256}`);
    die('el snapshot no es el autorizado.');
  }
  if (doc.sourceId !== sourceKey) die(`el snapshot es de ${doc.sourceId}, no de ${sourceKey}.`);
  if (doc.rows.length > maxCreates) {
    die(`el snapshot trae ${doc.rows.length} filas y el tope autorizado es ${maxCreates}.`);
  }

  console.log(`Snapshot: ${file}`);
  console.log(`  hash:   ${doc.sha256}  (coincide con el autorizado)`);
  console.log(`  sesión: la misma que lo creó · creado ${doc.createdAt}`);
  console.log(`  filas:  ${doc.rows.length} · tope autorizado ${maxCreates}`);
  console.log(`  lastVerified que se escribirá: ${doc.createdAt} (del snapshot, no de ahora)`);
  console.log('  Peticiones a la fuente en este paso: 0. Cuota consumida: 0.\n');

  const { client, counts, writes } = countingClient();
  const hechos = { create: 0, update: 0, noop: 0 };
  const errores = [];
  let creados = 0;

  for (const row of doc.rows) {
    if (creados >= maxCreates) {
      errores.push({ name: row.businessName, error: `tope de ${maxCreates} creaciones alcanzado` });
      break;
    }
    try {
      const res = await upsertCompany(client, prospectFromRow(row, doc.createdAt), { dryRun: false });
      hechos[res.action] = (hechos[res.action] || 0) + 1;
      if (res.action === 'create') creados++;
      const mark = { create: '+', update: '~', noop: '=' }[res.action] || '?';
      // En una creación el id no está en el plan (todavía no existía): está en
      // el registro que devuelve la API. Se imprime porque es lo que permite
      // auditar después qué fila creó qué empresa.
      const id = res.id || res.record?.id || '';
      console.log(`  ${mark} ${res.action.toUpperCase().padEnd(6)} ${res.name}  ${id}`);
    } catch (err) {
      errores.push({ name: row.businessName, dedupKey: row.dedupKey, error: err.message });
      console.error(`  ! ERROR  ${row.businessName}: ${err.message}`);
      // Fail-closed: se para aquí. Ni se sigue con las demás ni se reintenta.
      break;
    }
  }

  title('Resultado de la carga');
  console.log(`  creadas:      ${hechos.create}`);
  console.log(`  actualizadas: ${hechos.update}`);
  console.log(`  sin cambios:  ${hechos.noop}`);
  console.log(`  errores:      ${errores.length}`);
  console.log(`  crm_writes:   ${writes()}`);
  console.log(`  peticiones al CRM: ${JSON.stringify(counts)}`);
  console.log(`  outbound: 0 · OUTBOUND_ENABLED: ${config.outbound.enabled}`);

  if (errores.length) {
    console.error('\n  Detenido en el primer error. No hay reintento automático:');
    for (const e of errores) console.error(`    · ${e.name}: ${e.error}`);
    die(`carga incompleta: ${hechos.create} creadas antes de parar.`);
  }
  console.log(`\n✓ ${hechos.create} empresas creadas. Ni personas, ni oportunidades, ni un mensaje.`);
}

const commands = { preview, sync, apply };
if (!commands[command]) {
  console.log('Uso:');
  console.log('  node scripts/source-run.js preview [--limit 50] [--source <clave>]');
  console.log('  node scripts/source-run.js sync --snapshot <archivo> --confirm');
  console.log('  node scripts/source-run.js apply --snapshot <archivo> --confirm \\');
  console.log('       --expect-hash sha256:… --max-creates <n>');
  process.exit(1);
}
await commands[command]();
