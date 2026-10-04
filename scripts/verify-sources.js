/**
 * Verificación de cumplimiento de una fuente de datos públicos.
 *
 *   node scripts/verify-sources.js              # estado de todas
 *   node scripts/verify-sources.js <clave>      # verifica una
 *
 * Comprueba tres cosas y deja constancia firmada con la fecha:
 *
 *   1. robots.txt permite la ruta que vamos a consultar.
 *   2. El endpoint existe de verdad y devuelve filas.
 *   3. Las columnas declaradas como candidatas aparecen en los datos.
 *
 * Los términos de uso los confirma una persona: un script no puede leer una
 * página legal y decidir si nos deja usar los datos comercialmente. Por eso el
 * último paso pide confirmación explícita con --terms-ok.
 *
 * Sin las tres marcas, `fetchFromSource` se niega a consultar la fuente.
 */
import { SOURCES, buildUrl, mapRow } from '../src/prospecting/sources/index.js';
import { loadAttestations, saveAttestation, checkSourceAllowed, attestationFile, MAX_ATTESTATION_AGE_DAYS } from '../src/prospecting/sources/compliance.js';
import { parseRobots, robotsAllows } from '../src/prospecting/http.js';
import { config } from '../src/config.js';

const args = process.argv.slice(2);
const key = args.find((a) => !a.startsWith('-'));
const termsOk = args.includes('--terms-ok');
const UA = config.prospecting.userAgent;

function status() {
  const atts = loadAttestations();
  console.log(`Archivo de constancias: ${attestationFile()}`);
  console.log(`Caducidad: ${MAX_ATTESTATION_AGE_DAYS} días\n`);
  for (const [k, source] of Object.entries(SOURCES)) {
    const c = checkSourceAllowed(k, source, { attestations: atts });
    const mark = c.allowed ? '✓' : '✗';
    console.log(`${mark} ${k}`);
    console.log(`    ${source.label}`);
    console.log(`    ${c.allowed ? `verificada el ${String(c.verifiedAt).slice(0, 10)}` : `${c.reason}${c.detail ? ` · ${c.detail}` : ''}`}`);
    if (!c.allowed) {
      console.log(`    robots: ${source.compliance.robotsUrl}`);
      console.log(`    términos: ${source.compliance.termsUrl}`);
    }
  }
  console.log('\nPara verificar una:  node scripts/verify-sources.js <clave> --terms-ok');
  console.log('(--terms-ok confirma que una persona leyó los términos y permiten este uso)');
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
  console.log(`Verificando ${k} — ${source.label}\n`);
  const record = { label: source.label, termsUrl: source.compliance.termsUrl };

  // ── 1. robots.txt ──
  let requestPath = '/';
  try {
    requestPath = new URL(buildUrl(source, source.query({}))).pathname;
  } catch (err) {
    console.log(`  dataset        ✗ ${err.message}`);
    record.endpointVerified = false;
    record.endpointDetail = err.message;
  }

  try {
    const r = await fetchText(source.compliance.robotsUrl);
    if (r.status === 404) {
      record.robotsAllowed = true;
      record.robotsDetail = 'sin robots.txt (404): no hay restricción declarada';
    } else if (r.ok) {
      const { rules } = parseRobots(r.text, 'caliclean');
      record.robotsAllowed = robotsAllows(rules, requestPath);
      record.robotsDetail = record.robotsAllowed
        ? `permite ${requestPath}`
        : `robots.txt prohíbe ${requestPath}`;
    } else {
      record.robotsAllowed = false;
      record.robotsDetail = `robots.txt devolvió ${r.status}: no se asume permiso`;
    }
  } catch (err) {
    record.robotsAllowed = false;
    record.robotsDetail = `no se pudo leer robots.txt: ${err.message}`;
  }
  console.log(`  robots.txt     ${record.robotsAllowed ? '✓' : '✗'} ${record.robotsDetail}`);

  // ── 2 y 3. El endpoint existe y trae las columnas declaradas ──
  if (record.endpointVerified !== false) {
    try {
      const url = buildUrl(source, source.query({ sinceDays: 365, limit: 5 }));
      const r = await fetchText(url);
      if (!r.ok) {
        record.endpointVerified = false;
        record.endpointDetail = `HTTP ${r.status} en ${url}`;
      } else {
        const rows = JSON.parse(r.text);
        if (!Array.isArray(rows) || !rows.length) {
          record.endpointVerified = false;
          record.endpointDetail = 'el endpoint responde pero no devuelve filas';
        } else {
          const columns = Object.keys(rows[0]);
          const mapped = rows.map((row) => mapRow(source, row)).filter(Boolean);
          record.endpointVerified = mapped.length > 0;
          record.columnsSeen = columns;
          record.sampleMapped = mapped.length;
          record.endpointDetail = record.endpointVerified
            ? `${mapped.length}/${rows.length} filas mapeadas con los candidatos declarados`
            : `ninguna de ${rows.length} filas tiene los campos obligatorios (${(source.requires || []).join(', ')})`;
          // Lo más útil cuando falla: qué columnas hay de verdad.
          if (!record.endpointVerified) record.endpointDetail += ` · columnas reales: ${columns.join(', ')}`;
        }
      }
    } catch (err) {
      record.endpointVerified = false;
      record.endpointDetail = err.message;
    }
    console.log(`  endpoint       ${record.endpointVerified ? '✓' : '✗'} ${record.endpointDetail}`);
  }

  // ── 4. Términos, confirmados por una persona ──
  record.termsReviewed = termsOk;
  console.log(`  términos       ${termsOk ? '✓ confirmados con --terms-ok' : `✗ revísalos en ${source.compliance.termsUrl} y repite con --terms-ok`}`);

  record.verifiedAt = new Date().toISOString();
  record.userAgent = UA;
  saveAttestation(k, record);

  const final = checkSourceAllowed(k, source);
  console.log(`\n${final.allowed ? '✓ Fuente habilitada.' : `✗ Sigue deshabilitada: ${final.reason}`}`);
  console.log(`Constancia guardada en ${attestationFile()}`);
  process.exit(final.allowed ? 0 : 2);
}

if (key) await verify(key); else status();
