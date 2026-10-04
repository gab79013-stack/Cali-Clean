/**
 * Verificador offline de la attestation.
 *
 *   node scripts/verify-attestation.js
 *   node scripts/verify-attestation.js --json
 *   node scripts/verify-attestation.js --file otra-attestation.json
 *
 * No hace ni una petición de red. Comprueba tres cosas y dice en voz alta
 * cuáles NO comprueba, que es la parte que se malinterpreta sola.
 */
import process from 'node:process';
import { loadAttestation, verifyAttestation, attestationFilePath } from '../src/prospecting/sources/attestation.js';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const fileArg = args.indexOf('--file');
const file = fileArg !== -1 ? args[fileArg + 1] : attestationFilePath();
const maxAgeDays = Number(process.env.SOURCE_ATTESTATION_MAX_AGE_DAYS || 180);

const att = loadAttestation(file);
if (!att) {
  if (asJson) console.log(JSON.stringify({ valid: false, problems: ['no se pudo leer la attestation'], file }, null, 2));
  else console.error(`✗ No se pudo leer ${file}`);
  process.exit(1);
}

const result = verifyAttestation(att, { maxAgeDays });

if (asJson) {
  console.log(JSON.stringify({ file, ...result }, null, 2));
  process.exit(result.valid ? 0 : 2);
}

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

console.log('NO comprobado, y por qué:');
console.log('  · Los SHA256 de robots, metadata y muestra SODA son evidencia IMPORTADA.');
console.log('    Recomputarlos exigiría descargar los artefactos, y esta sesión no tiene');
console.log('    egress a data.sandiegocounty.gov. Se registran, no se validan.');
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
  console.log(`    licencia: ${s.license?.licenseId} · robots: HTTP ${s.robots?.httpStatus}, crawl-delay ${s.robots?.crawlDelaySeconds}s`);
  console.log(`    límites: ${s.limits?.maxRowsPerRun} filas/corrida · ${s.limits?.maxSuccessfulRunsPer24h} corrida con éxito/24h · ${s.limits?.retry?.maxAttempts} intentos máx.`);
  console.log(`    artefactos con hash: ${arts.join(', ')}`);
}
console.log('');
console.log(result.valid ? '✓ Attestation válida.' : '✗ Attestation NO válida.');
process.exit(result.valid ? 0 : 2);
