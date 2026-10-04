/**
 * Estado y verificación operativa de las fuentes.
 *
 *   node scripts/verify-sources.js              # estado de todas
 *   node scripts/verify-sources.js <clave> --terms-ok
 *
 * Hay dos capas y este script solo toca la segunda:
 *
 *   1. EVIDENCIA — config/source-allowlist.json. La escribe una persona tras
 *      auditar desde una red autorizada. Este script NO la modifica: si una
 *      fuente está `enabled: false`, verificarla aquí no la enciende.
 *
 *   2. CONSTANCIA OPERATIVA — data/source-compliance.json. Lo que esta
 *      instalación comprobó y cuándo. Caduca a los 180 días.
 *
 * Una fuente sale a la red solo si pasa las dos.
 */
import { SOURCES, buildUrl, mapRow } from '../src/prospecting/sources/index.js';
import {
  loadAttestations, saveAttestation, checkSourceAllowed, attestationFile,
  allowlistFile, allowlistEntry, forbiddenFields, MAX_ATTESTATION_AGE_DAYS,
} from '../src/prospecting/sources/compliance.js';
import { parseRobots, robotsAllows } from '../src/prospecting/http.js';
import { config } from '../src/config.js';

const args = process.argv.slice(2);
const key = args.find((a) => !a.startsWith('-'));
const termsOk = args.includes('--terms-ok');
const UA = config.prospecting.userAgent;

const STATE_MARK = {
  ELIGIBLE_BUT_DISABLED: '○',
  RESEARCH_ONLY_DISABLED: '◐',
  REJECTED: '✗',
};

function status() {
  console.log(`Evidencia de auditoría: ${allowlistFile()}`);
  console.log(`Constancias operativas: ${attestationFile()}`);
  console.log(`Caducidad de constancia: ${MAX_ATTESTATION_AGE_DAYS} días\n`);

  const atts = loadAttestations();
  for (const [k, source] of Object.entries(SOURCES)) {
    const entry = allowlistEntry(k);
    const c = checkSourceAllowed(k, source, { attestations: atts });
    const mark = c.allowed ? '●' : (STATE_MARK[entry?.state] || '?');

    console.log(`${mark} ${k}`);
    console.log(`    ${source.label}`);
    console.log(`    estado: ${entry?.state || 'SIN_AUDITAR'} · acceso: ${source.accessType}` +
      ` · elegible: ${entry?.eligible === true ? 'sí' : 'no'} · habilitada: ${entry?.enabled === true ? 'sí' : 'NO'}`);
    console.log(`    licencia: ${entry?.license?.name || '—'}`);
    if (entry?.robots?.crawlDelaySeconds) console.log(`    crawl-delay declarado: ${entry.robots.crawlDelaySeconds}s`);
    const rl = entry?.rateLimit?.internalPolicy;
    if (rl) {
      const bits = [];
      if (rl.maxRowsPerRun) bits.push(`${rl.maxRowsPerRun} filas/corrida`);
      if (rl.maxRunsPerDay) bits.push(`${rl.maxRunsPerDay} corrida/día`);
      if (rl.maxDownloadsPerDay) bits.push(`${rl.maxDownloadsPerDay} descarga/día`);
      if (rl.minDelayMs) bits.push(`${rl.minDelayMs}ms entre peticiones`);
      if (rl.respectRetryAfter) bits.push('respeta Retry-After');
      if (rl.conditionalGet) bits.push(`GET condicional (${rl.conditionalGet.join(', ')})`);
      console.log(`    política: ${bits.join(' · ')}`);
    }
    const forbidden = forbiddenFields(k);
    if (forbidden.length) console.log(`    campos prohibidos: ${forbidden.join(', ')}`);
    console.log(`    → ${c.allowed ? `habilitada (verificada el ${String(c.verifiedAt).slice(0, 10)})` : c.reason}`);
    for (const b of (entry?.blockers || [])) console.log(`      pendiente: ${b}`);
    console.log('');
  }

  console.log('Verificar una fuente:  node scripts/verify-sources.js <clave> --terms-ok');
  console.log('(verificar NO la habilita: eso se decide en config/source-allowlist.json)');
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' } });
  return { status: res.status, ok: res.ok, text: await res.text() };
}

async function verify(k) {
  const source = SOURCES[k];
  if (!source) {
    console.error(`Fuente desconocida: ${k}`);
    console.error(`Disponibles: ${Object.keys(SOURCES).join(', ')}`);
    process.exit(1);
  }
  const entry = allowlistEntry(k);
  if (!entry) {
    console.error(`"${k}" no figura en ${allowlistFile()}. Audítala primero.`);
    process.exit(1);
  }
  if (entry.implemented !== true) {
    console.error(`"${k}" declara accessType "${source.accessType}", que no está implementado.`);
    console.error('No hay nada que verificar hasta que exista la ingestión. Bloqueos:');
    for (const b of entry.blockers || []) console.error(`  · ${b}`);
    process.exit(3);
  }

  console.log(`Verificando ${k} — ${source.label}\n`);
  const record = { label: source.label, termsUrl: entry.license?.termsUrl };

  let requestPath = '/';
  try {
    requestPath = new URL(buildUrl(source, source.query({}))).pathname;
  } catch (err) {
    console.log(`  endpoint       ✗ ${err.message}`);
    record.endpointVerified = false;
    record.endpointDetail = err.message;
  }

  // ── robots.txt ──
  const robotsUrl = entry.robots?.portalRobotsUrl;
  try {
    const r = await fetchText(robotsUrl);
    if (r.status === 404) {
      record.robotsAllowed = true;
      record.robotsDetail = 'sin robots.txt (404): no hay restricción declarada';
    } else if (r.ok) {
      const { rules } = parseRobots(r.text, 'caliclean');
      record.robotsAllowed = robotsAllows(rules, requestPath);
      record.robotsDetail = record.robotsAllowed ? `permite ${requestPath}` : `robots.txt prohíbe ${requestPath}`;
    } else {
      record.robotsAllowed = false;
      record.robotsDetail = `robots.txt devolvió ${r.status}: no se asume permiso`;
    }
  } catch (err) {
    record.robotsAllowed = false;
    record.robotsDetail = `no se pudo leer robots.txt: ${err.message}`;
  }
  console.log(`  robots.txt     ${record.robotsAllowed ? '✓' : '✗'} ${record.robotsDetail}`);

  // ── endpoint y columnas ──
  if (record.endpointVerified !== false) {
    try {
      const url = buildUrl(source, source.query({ sinceDays: 365, limit: 5 }));
      const r = await fetchText(url);
      if (!r.ok) {
        record.endpointVerified = false;
        record.endpointDetail = `HTTP ${r.status}${r.status === 429 ? ' (throttling: respeta Retry-After)' : ''}`;
      } else {
        const rows = JSON.parse(r.text);
        if (!Array.isArray(rows) || !rows.length) {
          record.endpointVerified = false;
          record.endpointDetail = 'el endpoint responde pero no devuelve filas';
        } else {
          const columns = Object.keys(rows[0]);
          const leaked = forbiddenFields(k).filter((f) => columns.includes(f));
          if (leaked.length) {
            // El $select debería impedirlo; si aparecen, la consulta está mal.
            record.endpointVerified = false;
            record.endpointDetail = `la respuesta trae campos prohibidos: ${leaked.join(', ')}`;
          } else {
            const mapped = rows.map((row) => mapRow(source, row, k)).filter(Boolean);
            record.endpointVerified = mapped.length > 0;
            record.columnsSeen = columns;
            record.endpointDetail = record.endpointVerified
              ? `${mapped.length}/${rows.length} filas mapeadas, sin campos prohibidos`
              : `ninguna de ${rows.length} filas tiene los campos obligatorios · columnas reales: ${columns.join(', ')}`;
          }
        }
      }
    } catch (err) {
      record.endpointVerified = false;
      record.endpointDetail = err.message;
    }
    console.log(`  endpoint       ${record.endpointVerified ? '✓' : '✗'} ${record.endpointDetail}`);
  }

  record.termsReviewed = termsOk;
  console.log(`  términos       ${termsOk ? '✓ confirmados con --terms-ok' : `✗ revísalos en ${entry.license?.termsUrl} y repite con --terms-ok`}`);

  record.verifiedAt = new Date().toISOString();
  record.userAgent = UA;
  saveAttestation(k, record);

  const final = checkSourceAllowed(k, source);
  console.log(`\n${final.allowed ? '✓ Fuente habilitada.' : `✗ Sigue sin poder salir a la red: ${final.reason}`}`);
  if (!final.allowed && final.reason === 'no_habilitada') {
    console.log('  La constancia operativa quedó registrada, pero la auditoría la mantiene apagada.');
    console.log(`  Para encenderla: enabled=true en ${allowlistFile()} (decisión humana).`);
  }
  console.log(`Constancia guardada en ${attestationFile()}`);
  process.exit(final.allowed ? 0 : 2);
}

if (key) await verify(key); else status();
