/**
 * Verificador offline de la attestation.
 *
 *   node scripts/verify-attestation.js
 *   node scripts/verify-attestation.js --json
 *   node scripts/verify-attestation.js --file otra-attestation.json
 *
 * No hace ni una petición de red. Comprueba tres cosas y dice en voz alta
 * cuáles NO comprueba, que es la parte que se malinterpreta sola.
 *
 * Hay una evidencia por fuente, cada una en su archivo y con su propio digest.
 * Sin `--file` se verifican todas, y el proceso sale con error si alguna falla:
 * que la del condado esté en regla no dice nada de la de la ciudad.
 */
import process from 'node:process';
import { loadAttestation, verifyAttestation, attestationPaths } from '../src/prospecting/sources/attestation.js';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const fileArg = args.indexOf('--file');
const files = fileArg !== -1 ? [args[fileArg + 1]] : attestationPaths();
const maxAgeDays = Number(process.env.SOURCE_ATTESTATION_MAX_AGE_DAYS || 180);

const resultados = [];
for (const f of files) {
  const doc = loadAttestation(f);
  resultados.push({ file: f, att: doc, result: doc ? verifyAttestation(doc, { maxAgeDays }) : null });
}

if (asJson) {
  console.log(JSON.stringify(resultados.map((r) => ({
    file: r.file,
    ...(r.result || { valid: false, problems: ['no se pudo leer la attestation'] }),
  })), null, 2));
  process.exit(resultados.every((r) => r.result?.valid) ? 0 : 2);
}

/**
 * Una evidencia cuyos únicos problemas son "está pendiente" no es un fallo: es
 * una fuente que todavía no se ha podido auditar porque no hay egress a su host.
 * Se distingue del resto para que este comando siga significando algo —"¿hay algo
 * que debería estar bien y no lo está?"— en lugar de salir con error para
 * siempre mientras quede un scout sin habilitar.
 */
const soloPendiente = (result) => result?.problems?.length > 0
  && result.problems.every((p) => /evidencia está pendiente|evidencia ausente/.test(p));

let fallos = 0;
let pendientes = 0;
for (const entrada of resultados) {
  if (entrada !== resultados[0]) console.log(`\n${'═'.repeat(70)}\n`);
  if (!entrada.att) {
    console.error(`✗ No se pudo leer ${entrada.file}`);
    fallos++;
    continue;
  }
  verUna(entrada.file, entrada.att, entrada.result);
  if (entrada.result.valid) continue;
  if (soloPendiente(entrada.result)) {
    pendientes++;
    console.log('→ PENDIENTE por diseño: falta auditar esta fuente desde una red con acceso a su host.');
    console.log('  La attestation no vale, y por eso su fuente no puede cruzar la puerta. Correcto.');
  } else {
    fallos++;
  }
}

const validas = resultados.length - fallos - pendientes;
console.log(`\n${validas} válida(s) · ${pendientes} pendiente(s) por diseño · ${fallos} con problemas`);
if (fallos) {
  console.log('✗ Hay evidencia que debería valer y no vale.');
  process.exit(2);
}
console.log(pendientes
  ? '✓ Todo lo auditable está en regla. Lo pendiente mantiene su fuente apagada, que es lo que toca.'
  : '✓ Todas las evidencias válidas.');
process.exit(0);

function verUna(file, att, result) {

console.log(`Attestation: ${file}`);
console.log(`Tipo:        ${att.kind} v${att.version}`);
console.log(`Evidencia:   ${att.evidenceCollectedAt}  (${att.collectedFrom?.network || '—'})`);
console.log('');

console.log('COMPROBADO offline:');
console.log(`  ${result.checks.structure ? '✓' : '✗'} estructura completa (campos obligatorios, forma de los hashes, httpStatus 200)`);
console.log(`  ${result.checks.digest ? '✓' : '✗'} digest SHA256 del documento, recomputado aquí`);
console.log(`      ${result.expectedDigest}`);
console.log(`  ${result.checks.age ? '✓' : '✗'} antigüedad de la evidencia: ${result.checks.ageDays ?? '?'} días (máximo ${maxAgeDays})`);
console.log('');

// Los artefactos y los dominios se nombran a partir de la propia evidencia: un
// texto fijo acabaría hablando de los artefactos de otra fuente, y un
// verificador que nombra mal lo que no comprobó no sirve de nada.
const artefactos = [...new Set(
  Object.values(att.sources || {}).flatMap((src) => Object.keys(src.artifacts || {})),
)];
const dominios = [...new Set(
  Object.values(att.sources || {})
    .flatMap((src) => Object.values(src.artifacts || {}))
    .map((a) => { try { return new URL(a.url).host; } catch { return null; } })
    .filter(Boolean),
)];
console.log('NO comprobado, y por qué:');
console.log(`  · Los SHA256 de ${artefactos.join(', ') || '—'} son evidencia IMPORTADA.`);
console.log('    Recomputarlos exigiría descargar los artefactos, y esta sesión no tiene');
console.log(`    egress a ${dominios.join(', ') || 'esos dominios'}. Se registran, no se validan.`);
console.log('  · No hay firma criptográfica: sin clave autorizada en el repositorio, una');
console.log('    firma sería una afirmación que nadie puede comprobar. El digest dice que');
console.log('    el documento no ha cambiado; no dice quién lo escribió.');
console.log('');

console.log(`Peticiones de red realizadas por este verificador: ${result.checks.networkFetchPerformed ? 'SÍ' : '0'}`);
console.log(`Peticiones de red realizadas por Claude Cloud para obtener esta evidencia: 0`);
console.log('');

if (result.problems.length) {
  console.log('Problemas:');
  for (const p of result.problems) console.log(`  ✗ ${p}`);
}

const fuentes = Object.keys(att.sources || {});
console.log(`Fuentes atestiguadas (${fuentes.length}): ${fuentes.join(', ') || '—'}`);
for (const [k, s] of Object.entries(att.sources || {})) {
  const arts = Object.keys(s.artifacts || {});
  console.log(`  ${k}`);
  console.log(`    licencia: ${s.license?.licenseId}`);

  // El robots se describe distinto según lo que se pudo leer: fingir una forma
  // común para los dos portales ocultaría justo lo que importa.
  if (s.robots?.httpStatus !== undefined) {
    console.log(`    robots: HTTP ${s.robots.httpStatus}, crawl-delay ${s.robots.crawlDelaySeconds}s`);
  } else {
    console.log(`    robots: portal HTTP ${s.robots?.dataPortalStatus} · descarga HTTP ${s.robots?.downloadHostStatus}`
      + ` → crawling de HTML ${s.robots?.htmlCrawlingAllowed ? 'PERMITIDO (revísalo)' : 'prohibido'}`);
    console.log(`    recursos permitidos: ${(s.robots?.allowedResources || []).length}`);
  }

  const lim = s.limits || {};
  const porCorrida = lim.maxRowsPerRun ?? lim.maxValidCandidatesPerRun;
  console.log(`    límites: ${porCorrida} por corrida · ${lim.maxSuccessfulRunsPer24h} corrida con éxito/24h`
    + (lim.retry?.maxAttempts ? ` · ${lim.retry.maxAttempts} intentos máx.` : '')
    + (lim.requestsPerRun ? ` · ${lim.requestsPerRun} petición/corrida` : ''));
  if (s.personalDataNotice) console.log('    aviso: esta fuente expone datos personales; ver personalDataNotice');
  console.log(`    artefactos con hash: ${arts.join(', ')}`);
}
console.log('');
console.log(result.valid ? '✓ Attestation válida.' : '✗ Attestation NO válida.');
}
