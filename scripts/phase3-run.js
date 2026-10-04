/**
 * Orquestador de la fase 3: los tres scouts, en secuencia, y la capa central.
 *
 *   node scripts/phase3-run.js preview                  # los tres, sin escribir
 *   node scripts/phase3-run.js preview --only hcai_facilities
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

  // El índice del CRM lo carga la capa central, una sola vez. En esta fase no se
  // lee el CRM, así que se trabaja con un índice vacío y se dice en voz alta: el
  // plan que sale es "qué se crearía si el CRM estuviera vacío", no un plan
  // aplicable.
  title('Índice del CRM');
  console.log('  NO se lee el CRM en esta fase (orden explícita). Se usa un índice vacío,');
  console.log('  así que el plan de abajo es hipotético: dice qué se crearía si el CRM');
  console.log('  no tuviera nada. Antes de aplicar hay que cargar el índice de verdad.');
  const crmIndex = { dedupKeys: new Set(), crossKeys: new Set(), nameKeys: new Set(), complete: true };

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

  console.log('Todos los cerrojos están puestos, y aun así no se escribe.');
  console.log('');
  console.log('Esta fase es de implementación: los tres scouts están deshabilitados, su');
  console.log('evidencia está marcada como pendiente porque no hay egress a sus hosts, y');
  console.log('ninguna preview real se ha revisado. Escribir ahora sería crear Companies');
  console.log('a partir de datos que nadie ha visto llegar de la fuente oficial.');
  console.log('');
  console.log('Lo que falta, en orden:');
  console.log(`  1. permitir egress a: ${requiredEgressHosts().join(', ')}`);
  console.log('  2. completar la evidencia de cada scout (hoy: evidencePending)');
  console.log('  3. poner enabled=true en el manifiesto del scout concreto');
  console.log('  4. una preview real revisada');
  die('apply no disponible en la fase de implementación.', 4);
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
