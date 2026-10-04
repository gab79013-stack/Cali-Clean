/**
 * Piloto del embudo de ventas. Companies-only, y con todo lo demás cerrado.
 *
 *   node scripts/pilot-run.js preview [--limit 10]
 *   node scripts/pilot-run.js apply --confirm --allow-writes \
 *        --expect-hash sha256:… [--limit 10]
 *
 * Qué garantiza, y cada cosa tiene su prueba:
 *
 *   · **Nada escribe por defecto.** `apply` exige `--confirm`, `--allow-writes`,
 *     el hash de la preview que una persona revisó, y TWENTY_WRITE_ENABLED=true.
 *   · **OUTBOUND_ENABLED=false es un guard duro**, igual que en los scouts.
 *   · **Copia de seguridad antes de la primera escritura.** De los registros que
 *     se van a tocar y de las relaciones que ya existen, con su SHA256, en
 *     `data/backups/` con permisos 600 y fuera de git. Sin secretos y sin el
 *     cuerpo de ningún correo.
 *   · **Idempotente.** Una segunda corrida no cambia nada: los campos ya puestos
 *     se detectan, la Opportunity se busca por su nombre determinista y la tarea
 *     por el suyo.
 *   · **Ni People, ni mensajes, ni borrados, ni campañas, ni precios.** No se
 *     escribe `amount` en ninguna Opportunity, y este archivo no menciona
 *     ninguna colección de esas.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, ROOT } from '../src/config.js';
import { createClient } from '../src/services/crm/twenty.js';
import { readStaging } from '../src/prospecting/scouts/staging.js';
import {
  qualifyCompany, opportunityName, reviewTaskTitle, OPPORTUNITY_INITIAL_STAGE,
  SEGMENT_RATING, FRESHNESS_DAYS,
} from '../src/prospecting/pilot/qualify.js';

const [comando, ...rest] = process.argv.slice(2);
const flag = (n, d) => { const i = rest.indexOf(`--${n}`); return i === -1 ? d : (rest[i + 1] ?? true); };
const confirmado = rest.includes('--confirm');
const permitirEscrituras = rest.includes('--allow-writes');
const permitirReinicio = rest.includes('--allow-container-restart');
const limite = Math.min(Number(flag('limit', 10)), 10);
const hashEsperado = String(flag('expect-hash', '') || '');

const banner = (t) => console.log(`\n${'═'.repeat(72)}\n${t}\n${'═'.repeat(72)}`);
const title = (t) => console.log(`\n${t}\n${'─'.repeat(t.length)}`);
const die = (m) => { console.error(`\n✗ ${m}`); process.exit(1); };

/** El guard duro: si el outbound no está apagado, nada corre. */
function assertOutboundDisabled() {
  if (config?.outbound?.enabled !== false) {
    throw new Error('OUTBOUND_ENABLED tiene que estar en false para correr el piloto.');
  }
  return true;
}

/** Cliente con contador de métodos y rutas. El informe cita el contador. */
function countingClient() {
  const counts = { GET: 0, POST: 0, PATCH: 0, PUT: 0, DELETE: 0, otros: 0 };
  const rutas = new Set();
  const client = createClient({
    baseUrl: config.twenty.baseUrl,
    fetchImpl: async (url, opts = {}) => {
      const m = (opts.method || 'GET').toUpperCase();
      counts[m] = (counts[m] ?? counts.otros) + 1;
      // La URL llega con el prefijo /rest del propio adaptador, así que se quita
      // antes de comparar: la allowlist habla de colecciones, no de rutas HTTP.
      const ruta = String(url).replace(config.twenty.baseUrl, '').replace(/^\/rest/, '').split('?')[0];
      rutas.add(`${m} ${ruta}`);
      // Este piloto solo habla con /companies, /opportunities, /tasks y
      // /taskTargets. Cualquier otra colección es un error de programación, y se
      // para aquí en lugar de descubrirse en el CRM.
      const permitida = /^\/(companies|opportunities|tasks|taskTargets|open-api)/.test(ruta);
      if (!permitida) throw new Error(`el piloto no habla con "${ruta}"`);
      return fetch(url, opts);
    },
  });
  return { client, counts, rutas };
}

const paginar = async (client, col, extra = {}) => {
  const out = []; let cursor = null;
  for (;;) {
    const q = { limit: 60, ...extra }; if (cursor) q.starting_after = cursor;
    const r = await client.get(`/${col}`, q);
    const it = r.data?.[col] ?? r[col] ?? []; out.push(...it);
    const pi = r.pageInfo ?? r.data?.pageInfo;
    if (!pi?.hasNextPage || !it.length) break;
    cursor = pi.endCursor;
  }
  return out;
};

/** El snapshot sellado de ABC: de ahí sale la señal de segmento. */
function evidenciaDelSnapshot() {
  const dir = path.join(ROOT, 'data', 'staging');
  let archivos = [];
  try { archivos = fs.readdirSync(dir).filter((f) => f.startsWith('ca_abc_active_licenses-')); } catch { /* no hay */ }
  if (!archivos.length) return { porClave: new Map(), fuente: null, problema: 'no hay staging de ABC en disco' };
  const file = path.join(dir, archivos.sort().at(-1));
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const leido = readStaging(file, {
    allowContainerRestart: permitirReinicio,
    expectHash: doc.sha256,
    expectScoutId: 'ca_abc_active_licenses',
    expectRunId: doc.runId,
  });
  if (!leido.ok) {
    return { porClave: new Map(), fuente: file, problema: leido.problems.join('; ') };
  }
  const porClave = new Map();
  for (const c of leido.doc.candidates) porClave.set(c.dedupKey, c.evidence || {});
  return {
    porClave,
    fuente: file,
    hash: leido.doc.sha256,
    runId: leido.doc.runId,
    overrideUsado: leido.containerRestartOverrideUsed === true,
    problema: null,
  };
}

/** Hash canónico de la preview: ordenado, sin fechas que cambien solas. */
function hashPreview(preview) {
  const canonico = JSON.stringify({
    limite: preview.limite,
    snapshot: preview.snapshot,
    seleccion: preview.seleccion.map((s) => ({
      dedupKey: s.dedupKey, companyId: s.companyId, name: s.name,
      leadScore: s.proposed.leadScore, leadStage: s.proposed.leadStage,
      opportunityName: s.opportunityName, taskTitle: s.taskTitle,
    })),
  });
  return `sha256:${crypto.createHash('sha256').update(canonico).digest('hex')}`;
}

/** Construye la preview determinista. No escribe nada. */
async function construirPreview(client) {
  const ev = evidenciaDelSnapshot();
  const empresas = await paginar(client, 'companies', { order_by: 'dedupKey[AscNullsLast]' });

  const evaluadas = [];
  for (const e of empresas) {
    const r = qualifyCompany(e, ev.porClave.get(e.dedupKey), { now: Date.now() });
    evaluadas.push({ ...r, companyId: e.id, ciudad: e.address?.addressCity ?? null, company: e });
  }
  const calificadas = evaluadas.filter((x) => x.qualified);

  // Determinista: primero la ciudad de San Diego, luego por puntuación
  // descendente, y a igualdad, por dedupKey. Nada depende del orden de llegada.
  const ordenRating = { RATING_5: 5, RATING_4: 4, RATING_3: 3, RATING_2: 2, RATING_1: 1 };
  const seleccion = calificadas
    .filter((x) => String(x.ciudad).toUpperCase() === 'SAN DIEGO')
    .sort((a, b) => (ordenRating[b.proposed.leadScore] - ordenRating[a.proposed.leadScore])
      || a.dedupKey.localeCompare(b.dedupKey))
    .slice(0, limite)
    .map((x) => ({
      dedupKey: x.dedupKey, companyId: x.companyId, name: x.name, ciudad: x.ciudad,
      proposed: x.proposed, explanation: x.explanation, segment: x.segment,
      verifiedDaysAgo: x.verifiedDaysAgo,
      opportunityName: opportunityName(x.company),
      taskTitle: reviewTaskTitle(x.company),
    }));

  const preview = {
    generatedAt: new Date().toISOString(),
    limite,
    snapshot: ev.problema ? null : { file: path.basename(ev.fuente), hash: ev.hash, runId: ev.runId },
    snapshotProblema: ev.problema,
    totales: {
      companies: empresas.length,
      conEvidenciaDeSegmento: evaluadas.filter((x) => x.signals.segment).length,
      calificadas: calificadas.length,
      enSanDiego: calificadas.filter((x) => String(x.ciudad).toUpperCase() === 'SAN DIEGO').length,
      seleccionadas: seleccion.length,
    },
    rechazos: evaluadas.filter((x) => !x.qualified).reduce((a, x) => {
      for (const m of x.missing.length ? x.missing : ['segment']) a[m] = (a[m] || 0) + 1;
      return a;
    }, {}),
    seleccion,
  };
  preview.hash = hashPreview(preview);
  return { preview, empresas };
}

/** Lo que ya existe para estas Companies, para no duplicarlo ni perderlo. */
async function estadoExistente(client, seleccion) {
  const ids = new Set(seleccion.map((s) => s.companyId));
  const nombres = new Set(seleccion.map((s) => s.opportunityName));
  const oportunidades = (await paginar(client, 'opportunities'))
    .filter((o) => ids.has(o.companyId) || nombres.has(o.name));
  let tareas = { accesible: false, items: [], error: null };
  try {
    const xs = await paginar(client, 'tasks');
    tareas = { accesible: true, items: xs.filter((t) => seleccion.some((s) => t.title === s.taskTitle)), error: null };
  } catch (err) {
    tareas = { accesible: false, items: [], error: String(err.message).replace(/\s+/g, ' ').slice(0, 160) };
  }
  return { oportunidades, tareas };
}

/**
 * Copia de seguridad reversible, antes de la primera escritura.
 *
 * Lleva el estado ANTERIOR de cada campo que se va a tocar, para poder volver
 * atrás con un PATCH. No lleva secretos, ni el cuerpo de ningún correo, ni nada
 * de People: solo los campos del CRM que este piloto modifica o crea.
 */
function guardarBackup(preview, existente, empresasPorId) {
  const dir = path.join(ROOT, 'data', 'backups');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const cuerpo = {
    kind: 'pilot-backup',
    version: 1,
    createdAt: new Date().toISOString(),
    previewHash: preview.hash,
    note: 'Estado ANTERIOR de los campos que el piloto toca. Sin secretos y sin contenido de correo.',
    companies: preview.seleccion.map((s) => {
      const e = empresasPorId.get(s.companyId) || {};
      return {
        id: s.companyId,
        dedupKey: s.dedupKey,
        name: e.name ?? null,
        before: {
          leadScore: e.leadScore ?? null,
          leadStage: e.leadStage ?? null,
          contactabilityStatus: e.contactabilityStatus ?? null,
        },
      };
    }),
    opportunitiesExistentes: existente.oportunidades.map((o) => ({
      id: o.id, name: o.name, stage: o.stage, companyId: o.companyId, closeDate: o.closeDate ?? null,
    })),
    tasksExistentes: existente.tareas.accesible
      ? existente.tareas.items.map((t) => ({ id: t.id, title: t.title, status: t.status, dueAt: t.dueAt ?? null }))
      : { accesible: false, motivo: existente.tareas.error },
  };
  const json = `${JSON.stringify(cuerpo, null, 2)}\n`;
  const sha = crypto.createHash('sha256').update(json).digest('hex');
  const file = path.join(dir, `pilot-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, json, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  const shaFile = `${file}.sha256`;
  fs.writeFileSync(shaFile, `${sha}  ${path.basename(file)}\n`, { mode: 0o600 });
  fs.chmodSync(shaFile, 0o600);
  return { file, shaFile, sha256: sha, bytes: Buffer.byteLength(json) };
}

function imprimirPreview(preview, existente) {
  title('Calificación · reglas aplicadas');
  console.log(`  señales obligatorias: provenance, dirección comercial, ámbito, frescura (${FRESHNESS_DAYS} días), nombre de negocio`);
  console.log(`  señal de segmento: tipo de licencia del snapshot sellado (${Object.keys(SEGMENT_RATING).length} tipos con peso documentado)`);
  console.log('  NO se toca contactabilityStatus: NO_VERIFIED_CHANNEL es la verdad, subirlo sería inventar un canal');
  console.log('  NO hay RATING_5: afirmarlo pediría un canal verificado o una necesidad confirmada');
  console.log('  NO hay tags: el esquema de Company de este espacio no tiene ese campo');

  title('Totales');
  for (const [k, v] of Object.entries(preview.totales)) console.log(`  ${k.padEnd(26)} ${v}`);
  if (Object.keys(preview.rechazos).length) {
    title('Por qué no califican las demás');
    for (const [k, v] of Object.entries(preview.rechazos)) console.log(`  ${k.padEnd(26)} ${v}`);
  }

  title(`Selección (${preview.seleccion.length}, máximo ${preview.limite})`);
  for (const s of preview.seleccion) {
    console.log(`  · ${s.name}`);
    console.log(`      ${s.dedupKey} · ${s.ciudad} · ${s.proposed.leadScore} → leadStage ${s.proposed.leadStage}`);
    console.log(`      ${s.explanation}`);
  }

  title('Lo que ya existe');
  console.log(`  Opportunities ligadas a estas Companies o con el nombre del piloto: ${existente.oportunidades.length}`);
  for (const o of existente.oportunidades) console.log(`      · ${o.name} (${o.stage})`);
  console.log(`  Tasks: ${existente.tareas.accesible ? `${existente.tareas.items.length}` : `NO LEGIBLES — ${existente.tareas.error}`}`);

  title('Procedencia de la señal de segmento');
  if (preview.snapshotProblema) console.log(`  ✗ ${preview.snapshotProblema}`);
  else console.log(`  ${preview.snapshot.file}\n  ${preview.snapshot.hash}\n  runId ${preview.snapshot.runId}`);

  console.log(`\n  hash de la preview: ${preview.hash}`);
}

async function preview() {
  banner('PILOTO · PREVIEW (no escribe nada)');
  console.log(`OUTBOUND_ENABLED: ${config.outbound.enabled} (guard duro)`);
  const { client, counts, rutas } = countingClient();
  const { preview: p, empresas } = await construirPreview(client);
  const existente = await estadoExistente(client, p.seleccion);
  imprimirPreview(p, existente);

  title('Contención');
  console.log(`  métodos: ${JSON.stringify(counts)}`);
  console.log(`  rutas: ${[...rutas].join(' · ')}`);
  console.log(`  escrituras: ${counts.POST + counts.PATCH + counts.PUT + counts.DELETE} · empresas leídas: ${empresas.length}`);
  console.log('\n✓ Preview lista. Nada se escribió.');
}

async function apply() {
  banner('PILOTO · APPLY');
  const faltan = [];
  if (!confirmado) faltan.push('--confirm');
  if (!permitirEscrituras) faltan.push('--allow-writes');
  if (!hashEsperado) faltan.push('--expect-hash sha256:…');
  if (config.twenty.dryRunDefault) faltan.push('TWENTY_WRITE_ENABLED=true');
  if (faltan.length) die(`faltan: ${faltan.join(', ')}`);

  const { client, counts, rutas } = countingClient();
  const { preview: p, empresas } = await construirPreview(client);
  if (p.hash !== hashEsperado) {
    console.error(`  autorizado: ${hashEsperado}`);
    console.error(`  recalculado: ${p.hash}`);
    die('la preview no es la que se autorizó: se aplica lo que se revisó, no otra cosa.');
  }
  if (!p.seleccion.length) die('la preview no selecciona ninguna Company.');
  if (p.seleccion.length > 10) die(`la preview trae ${p.seleccion.length} Companies y el tope del piloto es 10.`);

  const existente = await estadoExistente(client, p.seleccion);
  imprimirPreview(p, existente);

  // ── Copia de seguridad, antes de la primera escritura ──
  const empresasPorId = new Map(empresas.map((e) => [e.id, e]));
  const backup = guardarBackup(p, existente, empresasPorId);
  title('Copia de seguridad');
  console.log(`  ${backup.file}`);
  console.log(`  sha256 ${backup.sha256}`);
  console.log(`  ${backup.bytes} bytes · permisos 600 · fuera de git · sin secretos ni contenido de correo`);

  const hechas = { company_patch: 0, company_noop: 0, opportunity_create: 0, opportunity_noop: 0, task_create: 0, task_noop: 0 };
  const omitidas = [];

  title('Escribiendo');
  for (const s of p.seleccion) {
    const e = empresasPorId.get(s.companyId);
    // 1. Calificación: solo si cambia algo.
    const cambios = {};
    if (e.leadScore !== s.proposed.leadScore) cambios.leadScore = s.proposed.leadScore;
    if (e.leadStage !== s.proposed.leadStage) cambios.leadStage = s.proposed.leadStage;
    if (Object.keys(cambios).length) {
      await client.patch(`/companies/${s.companyId}`, cambios);
      hechas.company_patch++;
      console.log(`  ~ ${s.name}: ${Object.entries(cambios).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    } else { hechas.company_noop++; }

    // 2. Una Opportunity por Company, buscada por su nombre determinista.
    const yaOp = existente.oportunidades.find((o) => o.name === s.opportunityName);
    if (yaOp) { hechas.opportunity_noop++; } else {
      // Sin amount, sin closeDate, sin pointOfContact: no hay precio, no hay
      // fecha prometida y no hay persona verificada.
      const r = await client.post('/opportunities', {
        name: s.opportunityName, stage: OPPORTUNITY_INITIAL_STAGE, companyId: s.companyId,
      });
      const creada = r.data?.createOpportunity ?? r.data?.opportunity ?? r;
      existente.oportunidades.push({ id: creada?.id, name: s.opportunityName, stage: OPPORTUNITY_INITIAL_STAGE, companyId: s.companyId });
      hechas.opportunity_create++;
      console.log(`  + Opportunity "${s.opportunityName}" (${OPPORTUNITY_INITIAL_STAGE})`);
    }

    // 3. Tarea interna de revisión humana.
    if (!existente.tareas.accesible) {
      omitidas.push({ what: 'task', company: s.name, why: 'la colección de tareas no es legible con este token' });
      hechas.task_noop++;
    } else {
      const yaTarea = existente.tareas.items.find((t) => t.title === s.taskTitle);
      if (yaTarea) { hechas.task_noop++; } else {
        const vence = new Date(Date.now() + 3 * 86400000).toISOString();
        const r = await client.post('/tasks', { title: s.taskTitle, status: 'TODO', dueAt: vence });
        const tarea = r.data?.createTask ?? r.data?.task ?? r;
        if (tarea?.id) {
          await client.post('/taskTargets', { taskId: tarea.id, targetCompanyId: s.companyId });
          existente.tareas.items.push({ id: tarea.id, title: s.taskTitle, status: 'TODO', dueAt: vence });
          hechas.task_create++;
          console.log(`  + Task "${s.taskTitle}" (TODO, vence ${vence.slice(0, 10)})`);
        }
      }
    }
  }

  title('Resultado');
  for (const [k, v] of Object.entries(hechas)) console.log(`  ${k.padEnd(20)} ${v}`);
  if (omitidas.length) {
    console.log('\n  Omitido, y por qué:');
    for (const o of omitidas) console.log(`    · ${o.what} de ${o.company}: ${o.why}`);
  }
  title('Contención');
  console.log(`  métodos: ${JSON.stringify(counts)}`);
  console.log(`  rutas: ${[...rutas].join(' · ')}`);
  console.log(`  envíos de correo: 0 · OUTBOUND_ENABLED: ${config.outbound.enabled}`);
  console.log(`  People, mensajes, campañas, notas, borrados: 0 (este script no habla con esas colecciones)`);
  console.log(`\n✓ Piloto aplicado sobre ${p.seleccion.length} Companies.`);
}

try {
  assertOutboundDisabled();
  if (comando === 'preview') await preview();
  else if (comando === 'apply') await apply();
  else {
    console.log('Uso:\n  node scripts/pilot-run.js preview [--limit 10]\n'
      + '  node scripts/pilot-run.js apply --confirm --allow-writes --expect-hash sha256:… [--limit 10]');
    process.exit(1);
  }
} catch (err) {
  die(err.message);
}
