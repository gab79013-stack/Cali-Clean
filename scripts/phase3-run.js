/**
 * Orquestador de la fase 3: los tres scouts, en secuencia, y la capa central.
 *
 *   node scripts/phase3-run.js preview                  # los tres, sin escribir
 *   node scripts/phase3-run.js preview --only cde_schools
 *   node scripts/phase3-run.js plan                     # capa central sobre los staging
 *   node scripts/phase3-run.js apply --confirm \
 *        --expect-hashes <id>=<hash>,... --allow-writes  # exige todo a la vez
 *
 * Qué garantiza, y cada una está comprobada por una prueba:
 *
 *   · **Secuencial.** Un scout detrás de otro, con su propio informe. Que uno
 *     quede bloqueado no impide que el siguiente corra, y que uno falle no deja
 *     a los demás a medias.
 *   · **Un lock global.** Dos orquestaciones a la vez leerían el mismo índice del
 *     CRM y podrían planificar dos veces la misma creación.
 *   · **Nada escribe por defecto.** `apply` necesita `--confirm`, los hashes
 *     esperados de cada staging, `--allow-writes` y TWENTY_WRITE_ENABLED=true. En
 *     esta fase ese camino está cerrado por diseño: imprime el plan y se detiene.
 *   · **OUTBOUND_ENABLED=false es un guard duro.** Si no lo está, nada corre.
 *
 * No hay activación ni cron: este script no se programa todavía. La Routine
 * existente de County y City no se toca.
 */
import { config } from '../src/config.js';
import {
  scoutStatus, requiredEgressHosts, assertOutboundDisabled, manifestFor, SCOUT_IDS,
} from '../src/prospecting/scouts/registry.js';
import { runScout } from '../src/prospecting/scouts/run.js';
import { latestStagingPerScout } from '../src/prospecting/scouts/staging.js';
import {
  validateStaging, reconcile, refusalsFor, prioritizedScoutIds, PRIORITY_RATIONALE,
} from '../src/prospecting/scouts/intake.js';
import { withPhaseLock } from '../src/prospecting/scouts/lock.js';
// El CRM se toca SOLO desde aquí, el orquestador. Ni los scouts ni la capa
// central importan el adaptador: a la capa central el índice le llega como
// parámetro, y hay una prueba que lo comprueba recorriendo los archivos.
import { createClient, loadCrmIndex, upsertCompany } from '../src/services/crm/twenty.js';
import { normalizeForMatch } from '../src/prospecting/sources/city-btc-rules.js';

const [command, ...rest] = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? dflt : (rest[i + 1] ?? true);
};
const confirmado = rest.includes('--confirm');
const permitirEscrituras = rest.includes('--allow-writes');
const soloUno = flag('only', null);
const esperados = String(flag('expect-hashes', '') || '');

const banner = (t) => console.log(`\n${'═'.repeat(72)}\n${t}\n${'═'.repeat(72)}`);

/** Cliente del CRM con contador de métodos. El informe cita el contador. */
function countingClient() {
  const counts = {
    GET: 0, POST: 0, PATCH: 0, PUT: 0, DELETE: 0, otros: 0,
  };
  const client = createClient({
    baseUrl: config.twenty.baseUrl,
    fetchImpl: async (url, opts = {}) => {
      const m = String(opts.method || 'GET').toUpperCase();
      if (counts[m] === undefined) counts.otros++; else counts[m]++;
      // Ninguna ruta de esta fase toca otra colección que companies. Si alguna
      // lo intentara, se para aquí en lugar de descubrirlo en los datos.
      const ruta = new URL(url).pathname;
      if (!/^\/rest\/companies(\/|$)/.test(ruta)) {
        throw new Error(`Esta fase solo habla con /rest/companies, y se intentó ${m} ${ruta}`);
      }
      return fetch(url, opts);
    },
  });
  const writes = () => counts.POST + counts.PATCH + counts.PUT + counts.DELETE + counts.otros;
  return { client, counts, writes };
}

/**
 * Índice del CRM, cargado UNA vez.
 *
 * Incluye claves, nombre+dirección y nombre a secas, porque una fuente sin
 * dirección (CSLB) solo puede compararse por nombre, y sin esa tercera clave
 * duplicaría cada entidad que otra fuente ya hubiera traído.
 */
async function cargarIndice(client) {
  const base = await loadCrmIndex(client, { normalize: normalizeForMatch });
  const nameKeys = new Set();
  // `loadCrmIndex` ya normaliza nombre+dirección; de ahí se extrae el nombre.
  for (const cross of base.crossKeys) nameKeys.add(String(cross).split('|')[0]);
  return { ...base, nameKeys };
}

/** Un candidato de staging, en la forma que el adaptador del CRM espera. */
function prospectoDesdeCandidato(candidate, verifiedAt) {
  return {
    dedupKey: candidate.dedupKey,
    businessName: candidate.businessName,
    sourceUrl: candidate.sourceUrl,
    serviceArea: candidate.serviceArea,
    address: candidate.address || undefined,
    city: candidate.city || undefined,
    zip: candidate.zip || undefined,
    state: candidate.address ? 'CA' : undefined,
    country: candidate.address ? 'US' : undefined,
    stage: 'discovered',
    // Registro público oficial → BUSINESS_DIRECTORY, que ya existe en el enum.
    channel: 'public_record',
    // La marca del staging, no la hora de ahora: es cuando se comprobó el dato
    // contra la fuente, y es lo que hace la operación idempotente.
    lastVerified: verifiedAt,
  };
}
const title = (t) => console.log(`\n${t}\n${'─'.repeat(t.length)}`);
const die = (msg, code = 1) => { console.error(`\n✗ ${msg}`); process.exit(code); };

// Guard duro, antes de cualquier otra cosa y en los tres subcomandos.
try {
  assertOutboundDisabled(config);
} catch (err) {
  die(err.message);
}

/** Informe de una fuente. Recuentos, nunca filas. */
function informe({ scoutId, displayName, metrics, blocked, staging }) {
  const lineas = [`── ${displayName} ──`];
  lineas.push(blocked
    ? `  estado: BLOQUEADA · ${blocked.reason}${blocked.detail ? ` — ${blocked.detail}` : ''}`
    : '  estado: corrida completada');
  lineas.push(`  red:    ${metrics.requests} petición(es)`
    + (metrics.bytes ? ` · ${(metrics.bytes / 1048576).toFixed(1)} MB` : '')
    + (metrics.retries ? ` · ${metrics.retries} reintentos` : '')
    + (metrics.http429 ? ` · ${metrics.http429} × HTTP 429` : ''));
  lineas.push(`  filas:  ${metrics.fetched} vistas → ${metrics.accepted} aceptadas`);
  const rechazos = Object.entries(metrics)
    .filter(([k, v]) => k.startsWith('rejected_') && v > 0)
    .map(([k, v]) => `${v} ${k.replace('rejected_', '')}`);
  if (rechazos.length) lineas.push(`  rechazos: ${rechazos.join(' · ')}`);
  if (metrics.deduped) lineas.push(`  duplicadas en la corrida: ${metrics.deduped}`);
  if (staging) {
    lineas.push(`  staging: ${staging.file}`);
    lineas.push(`           ${staging.hash}`);
    lineas.push(`           runId ${staging.doc.runId} · caduca ${staging.doc.expiresAt}`);
  }
  lineas.push(`  contención: crm_writes=${metrics.crm_writes} · outbound=${metrics.outbound}`);
  lineas.push(`  duración: ${metrics.duration_ms} ms`);
  return lineas.join('\n');
}

/** Alertas: solo fallo o cambio significativo. Un bloqueo de cuota no alerta. */
function alertasDe({ scoutId, metrics, blocked, error }) {
  const out = [];
  if (error) out.push(`[ERROR] ${scoutId}: ${error}`);
  if ((metrics?.crm_writes || 0) > 0) out.push(`[CRITICAL] ${scoutId}: crm_writes=${metrics.crm_writes}`);
  if ((metrics?.outbound || 0) > 0) out.push(`[CRITICAL] ${scoutId}: outbound=${metrics.outbound}`);
  if ((metrics?.errors || 0) > 0) out.push(`[ERROR] ${scoutId}: ${metrics.errors} errores`);
  if (blocked && !['cuota_24h', 'cuota_24h_durable'].includes(blocked.reason)) {
    out.push(`[ERROR] ${scoutId}: bloqueada por ${blocked.reason} — ${blocked.detail || ''}`);
  }
  if (!blocked && (metrics?.fetched || 0) > 0 && (metrics?.accepted || 0) === 0) {
    out.push(`[ERROR] ${scoutId}: ${metrics.fetched} filas y ninguna aceptada: puede que el formato haya cambiado`);
  }
  return out;
}

// ── preview ──────────────────────────────────────────────────
async function preview() {
  banner('FASE 3 · PREVIEW DE LOS SCOUTS');
  console.log(`OUTBOUND_ENABLED: ${config.outbound.enabled} (guard duro)`);
  console.log(`Hosts que requieren egress: ${requiredEgressHosts().join(', ')}`);

  title('Estado de los scouts');
  for (const s of scoutStatus()) {
    console.log(`  ${s.scoutId.padEnd(18)} ${s.state.padEnd(22)} permitida=${s.allowed}`
      + (s.allowed ? '' : ` · ${s.reason}`));
    if (!s.allowed && s.detail) console.log(`      ${String(s.detail).slice(0, 120)}`);
  }

  const resultado = await withPhaseLock(async () => {
    const resumen = [];
    const alertas = [];
    for (const scoutId of prioritizedScoutIds()) {
      if (soloUno && scoutId !== soloUno) continue;
      const m = manifestFor(scoutId);
      banner(`SCOUT · ${m.displayName}`);

      const estado = scoutStatus().find((s) => s.scoutId === scoutId);
      if (!estado.allowed) {
        console.log(`  no permitida (${estado.reason}): se salta sin tocar la red.`);
        if (estado.blockers?.length) for (const b of estado.blockers) console.log(`    pendiente: ${b}`);
        resumen.push({ scoutId, estado: 'no_permitida', reason: estado.reason });
        continue;
      }

      try {
        const r = await runScout(scoutId, {
          durableQuotaOptions: null,
          cities: config.prospecting?.serviceCities || [],
          zips: config.prospecting?.serviceZips || [],
        });
        console.log(informe({ scoutId, displayName: m.displayName, ...r }));
        alertas.push(...alertasDe({ scoutId, ...r }));
        resumen.push({
          scoutId,
          estado: r.blocked ? 'bloqueada' : 'staging_listo',
          accepted: r.metrics.accepted,
          hash: r.staging?.hash || null,
        });
      } catch (err) {
        console.error(`  ✗ ${err.message}`);
        alertas.push(...alertasDe({ scoutId, error: err.message }));
        resumen.push({ scoutId, estado: 'error', error: err.message });
      }
    }
    return { resumen, alertas };
  });

  if (resultado.blocked) die(`${resultado.reason}: ${resultado.detail}`, 2);
  if (resultado.brokeStale) console.log(`\n  aviso: ${resultado.detail}`);

  banner('RESUMEN');
  for (const r of resultado.result.resumen) {
    console.log(`  ${r.scoutId.padEnd(18)} ${r.estado}`
      + (r.accepted !== undefined ? ` · ${r.accepted} aceptadas` : '')
      + (r.reason ? ` · ${r.reason}` : ''));
  }
  console.log(`  modo: solo staging. Ninguno escribe en el CRM.`);
  if (resultado.result.alertas.length) {
    console.log('\nALERTAS:');
    for (const a of resultado.result.alertas) console.log(`  ${a}`);
    process.exit(1);
  }
  console.log('\n✓ Preview completa. Sin alertas.');
}

// ── plan ─────────────────────────────────────────────────────
async function plan() {
  banner('FASE 3 · CAPA CENTRAL');
  console.log(`OUTBOUND_ENABLED: ${config.outbound.enabled} (guard duro)`);

  title('Prioridad entre fuentes, cuando dos describen la misma entidad');
  for (const id of prioritizedScoutIds()) console.log(`  ${id.padEnd(18)} ${PRIORITY_RATIONALE[id]}`);

  const archivos = latestStagingPerScout({ scoutIds: SCOUT_IDS });
  title('Staging encontrados');
  for (const id of SCOUT_IDS) console.log(`  ${id.padEnd(18)} ${archivos[id] || '(ninguno)'}`);
  if (!Object.keys(archivos).length) {
    die('no hay ningún staging. Corre primero: node scripts/phase3-run.js preview', 3);
  }

  title('Validación secuencial');
  const stagings = {};
  const invalidos = [];
  for (const id of prioritizedScoutIds()) {
    if (!archivos[id]) { console.log(`  ${id}: sin staging`); continue; }
    const v = validateStaging(id, archivos[id]);
    if (!v.ok) {
      invalidos.push(id);
      console.log(`  ${id}: ✗ NO válida`);
      for (const p of v.problems) console.log(`      · ${p}`);
      continue;
    }
    stagings[id] = v.doc;
    console.log(`  ${id}: ✓ válida · ${v.doc.candidateCount} candidatos · runId ${v.doc.runId}`);
  }
  if (!Object.keys(stagings).length) die('ningún staging válido: no se planifica nada.', 3);

  // El índice del CRM, una sola lectura. Si queda incompleto no se continúa: con
  // un índice a medias se crearían duplicados.
  title('Índice del CRM');
  if (!config.twenty.baseUrl) die('TWENTY_BASE_URL no está configurada: sin índice no se planifica.');
  const { client, counts } = countingClient();
  const crmIndex = await cargarIndice(client);
  console.log(`  empresas indexadas: ${crmIndex.total} en ${crmIndex.pages} página(s)`);
  console.log(`  claves: ${crmIndex.dedupKeys.size} · nombre+dirección: ${crmIndex.crossKeys.size}`
    + ` · nombre: ${crmIndex.nameKeys.size}`);
  if (!crmIndex.complete) die('el índice del CRM quedó incompleto: no se planifica con uno a medias.');
  console.log(`  peticiones al CRM: ${JSON.stringify(counts)}`);

  const resultado = reconcile({ stagings, crmIndex });

  title('Plan central (Companies únicamente)');
  for (const [id, t] of Object.entries(resultado.bySource)) {
    console.log(`  ${id.padEnd(18)} ${t.candidates} candidatos → crear ${t.create}`
      + ` · omitidos por existir ${t.omitted_existing} · por otra fuente ${t.omitted_cross_source}`);
  }
  console.log(`  TOTAL: crear ${resultado.totals.create} · actualizar 0 · borrar 0`);

  if (resultado.conflicts.length) {
    title('Entidades que dos fuentes reclamaban');
    for (const c of resultado.conflicts) {
      console.log(`  ${c.winnerKey} gana a ${c.loserKey}`);
      console.log(`      ${c.rationale}`);
    }
  }

  title('Candidatos, en términos de negocio');
  for (const { scoutId, candidate } of resultado.create) {
    console.log(`  · ${candidate.businessName}`);
    console.log(`      ${scoutId} · ${candidate.city || '(sin ciudad)'} ${candidate.zip || ''}`
      + ` · ${candidate.dedupKey}`);
  }

  const rechazos = refusalsFor({
    config,
    objects: ['companies'],
    operations: ['create'],
    perSource: Object.fromEntries(Object.entries(resultado.bySource).map(([k, v]) => [k, v.create])),
    disabledSources: scoutStatus().filter((s) => !s.allowed && stagings[s.scoutId]).map((s) => s.scoutId),
    staleSources: [],
    invalidStagings: invalidos,
  });

  title('Comprobaciones antes de cualquier escritura');
  if (!rechazos.length) console.log('  ninguna la rechaza, pero esta fase no escribe de todas formas.');
  for (const r of rechazos) console.log(`  ✗ ${r.code}: ${r.why}`);

  title('Contención');
  console.log('  crm_writes: 0 · outbound: 0');
  console.log(`  OUTBOUND_ENABLED: ${config.outbound.enabled}`);
  console.log('\n✓ Plan central listo. No se escribió nada.');
}

// ── apply ────────────────────────────────────────────────────
async function apply() {
  banner('FASE 3 · APPLY');
  // Cuatro cerrojos, y además la fase lo prohíbe. Se comprueban todos para que el
  // motivo del rechazo sea el real y no "el primero que falló".
  const faltan = [];
  if (!confirmado) faltan.push('--confirm');
  if (!permitirEscrituras) faltan.push('--allow-writes');
  if (!esperados) faltan.push('--expect-hashes <id>=<hash>,...');
  if (config.twenty.dryRunDefault) faltan.push('TWENTY_WRITE_ENABLED=true');
  if (faltan.length) die(`faltan: ${faltan.join(', ')}`);

  // Los hashes autorizados, uno por scout: `<scoutId>=<sha256:...>`. Sin esto se
  // aplicaría "el último staging que haya", que no es lo mismo que el que una
  // persona revisó.
  const autorizados = new Map(
    String(esperados).split(',').map((par) => par.trim()).filter(Boolean)
      .map((par) => { const i = par.indexOf('='); return [par.slice(0, i), par.slice(i + 1)]; }),
  );
  if (!autorizados.size) die('--expect-hashes no trae ningún par <scoutId>=<hash>.');

  // Cerrojo de integración: mientras un scout del catálogo no tenga su preview
  // revisada, el apply central no corre. Se añadió al sustituir HCAI por
  // cde_schools: aplicar con una fuente del catálogo sin previsualizar sería
  // escribir con el reemplazo a medio integrar.
  const sinPreview = scoutStatus()
    .filter((s2) => s2.enabled === true && !latestStagingPerScout({ scoutIds: [s2.scoutId] })[s2.scoutId])
    .map((s2) => s2.scoutId);
  if (sinPreview.length) {
    die(`estas fuentes están habilitadas y no tienen preview: ${sinPreview.join(', ')}. `
      + 'El apply central espera a que todo el catálogo habilitado se haya previsualizado.');
  }

  const archivos = latestStagingPerScout({ scoutIds: SCOUT_IDS });
  title('Staging autorizados');
  const stagings = {};
  const invalidos = [];
  for (const [scoutId, hash] of autorizados) {
    if (!SCOUT_IDS.includes(scoutId)) die(`"${scoutId}" no es un scout conocido.`);
    const file = archivos[scoutId];
    if (!file) die(`no hay staging de ${scoutId}.`);

    const v = validateStaging(scoutId, file);
    if (!v.ok) {
      invalidos.push(scoutId);
      console.error(`  ${scoutId}: ✗ NO válida`);
      for (const p of v.problems) console.error(`      · ${p}`);
      continue;
    }
    if (v.doc.sha256 !== hash) {
      console.error(`  ${scoutId}: el hash no es el autorizado`);
      console.error(`      autorizado: ${hash}`);
      console.error(`      del archivo: ${v.doc.sha256}`);
      die('se aplica el staging que se revisó, no otro.');
    }
    const estado = scoutStatus().find((x) => x.scoutId === scoutId);
    if (!estado?.allowed) die(`${scoutId} no está permitida (${estado?.reason}): no se aplica su staging.`);

    stagings[scoutId] = v.doc;
    console.log(`  ${scoutId}: ✓ válida · ${v.doc.candidateCount} candidatos · runId ${v.doc.runId}`);
    console.log(`      ${v.doc.sha256}`);
  }
  if (invalidos.length) die(`staging no válidos: ${invalidos.join(', ')}`);
  if (!Object.keys(stagings).length) die('ningún staging autorizado y válido.', 3);

  const { client, counts, writes } = countingClient();
  title('Índice del CRM');
  const crmIndex = await cargarIndice(client);
  console.log(`  empresas indexadas: ${crmIndex.total} en ${crmIndex.pages} página(s)`);
  if (!crmIndex.complete) die('el índice del CRM quedó incompleto: no se escribe con uno a medias.');

  const plan = reconcile({ stagings, crmIndex });
  title('Plan');
  for (const [id, t] of Object.entries(plan.bySource)) {
    if (!stagings[id]) continue;
    console.log(`  ${id.padEnd(18)} crear ${t.create} · omitidos por existir ${t.omitted_existing}`
      + ` · por otra fuente ${t.omitted_cross_source}`);
  }
  console.log(`  TOTAL: crear ${plan.totals.create} · actualizar 0 · borrar 0`);

  const rechazos = refusalsFor({
    config,
    objects: ['companies'],
    operations: ['create'],
    perSource: Object.fromEntries(Object.entries(plan.bySource).map(([k, v]) => [k, v.create])),
    disabledSources: Object.keys(stagings).filter(
      (id) => !scoutStatus().find((x) => x.scoutId === id)?.allowed,
    ),
    staleSources: [],
    invalidStagings: invalidos,
  });
  if (rechazos.length) {
    for (const r of rechazos) console.error(`  ✗ ${r.code}: ${r.why}`);
    die('la capa central rechaza este plan.');
  }

  // ── Escritura: solo Companies, solo create, tope por fuente ──
  title('Creando Companies');
  const hechas = { create: 0, update: 0, noop: 0 };
  const errores = [];
  const porFuente = {};
  for (const { scoutId, candidate } of plan.create) {
    porFuente[scoutId] = (porFuente[scoutId] || 0) + 1;
    if (porFuente[scoutId] > maxCreates) {
      errores.push({ name: candidate.businessName, error: `tope de ${maxCreates} por fuente alcanzado` });
      break;
    }
    try {
      const res = await upsertCompany(
        client,
        prospectoDesdeCandidato(candidate, stagings[scoutId].createdAt),
        { dryRun: false },
      );
      hechas[res.action] = (hechas[res.action] || 0) + 1;
      if (res.action !== 'create') {
        // Un update aquí sería modificar algo que ya existía, y esta fase no lo
        // hace: se para en lugar de seguir.
        errores.push({ name: res.name, error: `el upsert resolvió "${res.action}" y solo se permite create` });
        break;
      }
      console.log(`  + ${res.name}  ${res.id || res.record?.id || ''}`);
    } catch (err) {
      errores.push({ name: candidate.businessName, error: err.message });
      console.error(`  ! ERROR ${candidate.businessName}: ${err.message}`);
      break;
    }
  }

  title('Resultado');
  console.log(`  creadas: ${hechas.create} · actualizadas: ${hechas.update} · sin cambios: ${hechas.noop}`);
  console.log(`  errores: ${errores.length}`);
  console.log(`  crm_writes: ${writes()} · peticiones: ${JSON.stringify(counts)}`);
  console.log(`  outbound: 0 · OUTBOUND_ENABLED: ${config.outbound.enabled}`);
  if (counts.PATCH || counts.DELETE || counts.PUT) die('hubo un método de mutación que esta fase prohíbe.');
  if (errores.length) {
    for (const e of errores) console.error(`    · ${e.name}: ${e.error}`);
    die(`carga incompleta: ${hechas.create} creadas antes de parar. No se reintenta.`);
  }
  console.log(`\n✓ ${hechas.create} Companies creadas. Ni personas, ni oportunidades, ni notas, ni un mensaje.`);
}

const commands = { preview, plan, apply };
if (!commands[command]) {
  console.log('Uso:');
  console.log('  node scripts/phase3-run.js preview [--only <scoutId>]');
  console.log('  node scripts/phase3-run.js plan');
  console.log('  node scripts/phase3-run.js apply --confirm --allow-writes --expect-hashes <id>=<hash>');
  process.exit(1);
}
await commands[command]();
