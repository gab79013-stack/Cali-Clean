#!/usr/bin/env node
/**
 * Exporta la lista de correos de negocios del área de San Diego.
 *
 *   node scripts/export-emails.js --target=300
 *
 * Corre el pipeline (descubrir → enriquecer → cualificar) en tandas hasta
 * juntar los correos pedidos, y escribe dos ficheros:
 *
 *   data/leads-san-diego-<fecha>.txt   un correo por línea, para pegar
 *   data/leads-san-diego-<fecha>.csv   el mismo listado con su contexto
 *
 * Lo que NO hace, a propósito: inventar direcciones. Cada correo del fichero
 * lo publica el propio negocio en su web y el sistema guarda en qué página lo
 * encontró. Un patrón adivinado tipo "info@" rebota, y los rebotes queman el
 * dominio desde el que se escribe — que es el del negocio, no el de nadie más.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../src/db.js';
import { runStage } from '../src/prospecting/pipeline.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => { const [k, v = 'true'] = a.slice(2).split('='); return [k, v]; }),
);

const TARGET = Number(args.target || 300);
const SINCE_DAYS = Number(args.since || 365);
const BATCH = Number(args.batch || 60);
const MAX_ROUNDS = Number(args.rounds || 40);
const SOURCES = (args.sources || 'sd_active_businesses,sd_development_permits').split(',');
const STAMP = new Date().toISOString().slice(0, 10);
const OUT_TXT = path.resolve(ROOT, args.out || `data/leads-san-diego-${STAMP}.txt`);
const OUT_CSV = OUT_TXT.replace(/\.txt$/, '.csv');
// Solo para pruebas: apunta las fuentes a un portal simulado.
const BASE_OVERRIDE = args.base || undefined;

/** Correos verificados, sin los que están en la lista de supresión. */
function collected() {
  return db.prepare(`
    SELECT p.business_name, p.email, p.phone, p.website, p.city, p.zip, p.segment,
           p.signal_type, p.icp_score, p.est_annual_value, p.evidence_json, p.address
      FROM prospects p
     WHERE p.email IS NOT NULL
       AND p.email_source = 'published_on_website'
       AND p.stage IN ('enriched', 'qualified', 'contacted')
       AND NOT EXISTS (
         SELECT 1 FROM suppression s
          WHERE (s.kind = 'email'  AND lower(s.value) = lower(p.email))
             OR (s.kind = 'domain' AND lower(s.value) = lower(substr(p.email, instr(p.email, '@') + 1)))
       )
     GROUP BY lower(p.email)
     ORDER BY p.icp_score DESC, p.updated_at DESC`).all();
}

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function write(rows) {
  fs.mkdirSync(path.dirname(OUT_TXT), { recursive: true });

  fs.writeFileSync(OUT_TXT, rows.map((r) => r.email).join('\n') + (rows.length ? '\n' : ''), 'utf8');

  const header = ['email', 'negocio', 'telefono', 'web', 'ciudad', 'zip', 'segmento',
    'senal', 'icp', 'valor_anual_estimado', 'pagina_donde_se_encontro'];
  const lines = rows.map((r) => {
    let page = '';
    try { page = (JSON.parse(r.evidence_json || '{}').enrich?.pages || [])[0] || r.website || ''; }
    catch { page = r.website || ''; }
    return [r.email, r.business_name, r.phone, r.website, r.city, r.zip, r.segment,
      r.signal_type, r.icp_score, r.est_annual_value, page].map(csvCell).join(',');
  });
  fs.writeFileSync(OUT_CSV, [header.join(','), ...lines].join('\n') + '\n', 'utf8');
}

async function main() {
  console.log(`Objetivo: ${TARGET} correos · área: San Diego + 50 millas · fuentes: ${SOURCES.join(', ')}`);

  let have = collected().length;
  const totals = { discovered: 0, enriched: 0, rejected: 0, reasons: {} };

  for (let round = 1; round <= MAX_ROUNDS && have < TARGET; round++) {
    // Cada ronda pide la página siguiente del fichero. Sin avanzar el offset,
    // la segunda ronda se llevaría otra vez las filas más recientes y no habría
    // nada nuevo que enriquecer.
    const d = await runStage('discover', {
      sources: SOURCES, sinceDays: SINCE_DAYS, limit: BATCH,
      offset: (round - 1) * BATCH, baseOverride: BASE_OVERRIDE,
    });
    totals.discovered += d.inserted;

    // Fuente agotada: seguir dando vueltas solo gasta peticiones.
    if (!d.inserted) {
      console.log(`\nRonda ${round}: las fuentes no devuelven negocios nuevos (${d.duplicates} repetidos). Se para aquí.`);
      if (d.errors?.length) console.log(`  errores: ${d.errors.join(' | ')}`);
      break;
    }

    const e = await runStage('enrich', { limit: BATCH, skipDns: Boolean(BASE_OVERRIDE) });
    totals.enriched += e.enriched;
    totals.rejected += e.rejected;
    for (const [k, v] of Object.entries(e.reasons || {})) totals.reasons[k] = (totals.reasons[k] || 0) + v;

    await runStage('qualify', {});
    have = collected().length;
    console.log(`Ronda ${round}: +${d.inserted} descubiertos, +${e.enriched} con correo → ${have}/${TARGET}`);
  }

  const rows = collected().slice(0, TARGET);
  write(rows);

  console.log(`\n${rows.length} correos verificados escritos en:`);
  console.log(`  ${path.relative(ROOT, OUT_TXT)}`);
  console.log(`  ${path.relative(ROOT, OUT_CSV)}`);

  if (rows.length < TARGET) {
    console.log(`\nFaltan ${TARGET - rows.length}. Por qué se descartaron prospectos:`);
    for (const [reason, n] of Object.entries(totals.reasons).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(5)}  ${reason}`);
    }
    console.log('\nPara sacar más: sube --since (ventana de tiempo) o añade fuentes de');
    console.log('ciudades vecinas en src/prospecting/sources/index.js.');
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
