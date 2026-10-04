/**
 * La corrida diaria completa: las dos fuentes, un informe por fuente, y
 * enriquecimiento al final.
 *
 *   node scripts/routine-daily.js              # todo en plan, sin escribir
 *   node scripts/routine-daily.js --write      # escribe (exige
 *                                              #  TWENTY_WRITE_ENABLED=true)
 *   node scripts/routine-daily.js --only sdcounty_food_facility_permits
 *
 * Qué hace por cada fuente, en este orden y sin saltarse nada:
 *
 *   1. `preview` — attestation, puerta, cuota durable derivada del CRM, cuota
 *      local, índice del CRM, una sola petición a la fuente, snapshot con hash.
 *   2. `apply`   — reutiliza EXACTAMENTE ese snapshot, por su hash. Companies
 *      únicamente, tope de 50 creaciones, y solo si se pidió --write.
 *
 * Las dos fuentes son independientes: cada una tiene su cuota, su guard durable
 * (por prefijo de clave) y su propia evidencia. Que una quede bloqueada no
 * impide que la otra corra, y que una falle no deja a la otra a medias.
 *
 * Qué NO es un fallo, y por eso no alerta: una fuente bloqueada por cuota, un
 * 304 del CSV, o una corrida sin candidatos nuevos. Son el sistema funcionando.
 * El proceso sale con 0 en esos casos. Sale distinto de 0 solo cuando algo que
 * debía funcionar no funcionó.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { SOURCES, sourceStatus } from '../src/prospecting/sources/index.js';
import { snapshotDir } from '../src/prospecting/sources/snapshot.js';

const rest = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? dflt : (rest[i + 1] ?? true);
};
const escribir = rest.includes('--write');
const soloUna = flag('only', null);
const maxCreates = Number(flag('max-creates', 50));

const ORDEN = ['sdcounty_food_facility_permits', 'sd_business_tax_certificates'];
const banner = (t) => console.log(`\n${'═'.repeat(72)}\n${t}\n${'═'.repeat(72)}`);

if (escribir && config.twenty.dryRunDefault) {
  console.error('--write exige TWENTY_WRITE_ENABLED=true en el entorno.');
  process.exit(1);
}

/** Ejecuta un subcomando y devuelve `{ code, out }`, con la salida ya impresa. */
function correr(args) {
  const res = spawnSync(process.execPath, [path.join(import.meta.dirname, 'source-run.js'), ...args], {
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  process.stdout.write(out);
  return { code: res.status ?? 1, out };
}

/** El snapshot más reciente de una fuente y su hash, leídos del disco. */
function snapshotReciente(sourceId) {
  let names;
  try { names = fs.readdirSync(snapshotDir()); } catch { return null; }
  const mios = names.filter((n) => n.startsWith(`${sourceId}-`) && n.endsWith('.json')).sort();
  if (!mios.length) return null;
  const file = path.join(snapshotDir(), mios[mios.length - 1]);
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { file, hash: doc.sha256, rows: doc.rowCount };
  } catch { return null; }
}

const resumen = [];
const alertas = [];

for (const key of ORDEN) {
  if (soloUna && key !== soloUna) continue;
  const estado = sourceStatus().find((s) => s.key === key);
  banner(`FUENTE · ${SOURCES[key].label}`);

  if (!estado?.allowed) {
    // Una fuente apagada no es un fallo de la corrida: es una decisión.
    console.log(`  no permitida (${estado?.code || estado?.reason}): se salta.`);
    resumen.push({ key, estado: 'no_permitida', detalle: estado?.reason });
    continue;
  }

  const prev = correr(['preview', '--source', key]);
  // 2 = bloqueada por un guard. 3 = sin candidatos. Ninguna de las dos es un
  // fallo, y las dos terminan aquí sin escribir nada.
  if (prev.code === 2) { resumen.push({ key, estado: 'bloqueada' }); continue; }
  if (prev.code === 3) { resumen.push({ key, estado: 'sin_candidatos' }); continue; }
  if (prev.code !== 0) {
    resumen.push({ key, estado: 'error_preview', code: prev.code });
    alertas.push(`[ERROR] ${key}: la preview falló con código ${prev.code}`);
    continue;
  }

  const snap = snapshotReciente(key);
  if (!snap) {
    resumen.push({ key, estado: 'error_preview', detalle: 'no apareció snapshot' });
    alertas.push(`[ERROR] ${key}: la preview terminó bien pero no dejó snapshot`);
    continue;
  }

  if (!escribir) {
    console.log(`\n  (sin --write: se queda en el snapshot ${snap.hash.slice(0, 23)}…, ${snap.rows} filas)`);
    resumen.push({ key, estado: 'preview_ok', filas: snap.rows, hash: snap.hash });
    continue;
  }

  const ap = correr([
    'apply', '--source', key, '--snapshot', snap.file, '--confirm',
    '--expect-hash', snap.hash, '--max-creates', String(maxCreates),
  ]);
  if (ap.code !== 0) {
    resumen.push({ key, estado: 'error_apply', code: ap.code, hash: snap.hash });
    alertas.push(`[ERROR] ${key}: el apply falló con código ${ap.code}. No se reintenta.`);
    continue;
  }
  resumen.push({ key, estado: 'cargada', filas: snap.rows, hash: snap.hash });
}

// ── Enriquecimiento ──────────────────────────────────────────
banner('ENRIQUECIMIENTO · solo campos sustentados');
const enrichArgs = [path.join(import.meta.dirname, 'enrich-preview.js')];
if (escribir) enrichArgs.push('--apply', '--confirm');
const en = spawnSync(process.execPath, enrichArgs, { encoding: 'utf8', env: process.env, maxBuffer: 32 * 1024 * 1024 });
process.stdout.write(`${en.stdout || ''}${en.stderr || ''}`);
if ((en.status ?? 1) !== 0) alertas.push(`[ERROR] enriquecimiento: código ${en.status}`);

// ── Resumen ──────────────────────────────────────────────────
banner('RESUMEN DE LA CORRIDA');
for (const r of resumen) {
  console.log(`  ${r.key.padEnd(32)} ${r.estado}`
    + (r.filas !== undefined ? ` · ${r.filas} filas` : '')
    + (r.detalle ? ` · ${r.detalle}` : ''));
}
console.log(`  modo: ${escribir ? 'ESCRITURA (Companies únicamente)' : 'solo plan'}`);
console.log(`  OUTBOUND_ENABLED: ${config.outbound.enabled}`);

if (alertas.length) {
  console.log('\nALERTAS:');
  for (const a of alertas) console.log(`  ${a}`);
  process.exit(1);
}
console.log('\n✓ Corrida completa. Sin alertas.');
