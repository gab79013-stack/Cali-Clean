#!/usr/bin/env node
/**
 * Enseña lo que el portal está devolviendo hoy, sin tocar la base de datos.
 *
 *   node scripts/inspect-source.js sd_active_businesses
 *
 * Existe por un motivo concreto: los nombres de columna de los ficheros de San
 * Diego no se pudieron verificar contra el portal al escribir las fuentes, así
 * que el mapeo va por lista de variantes (`pick`). Si algún día ninguna variante
 * acierta, la fuente devuelve filas vacías y la corrida dice "0 descubiertos"
 * sin explicar nada. Esto lo convierte en diez segundos de diagnóstico: enseña
 * las columnas reales, una fila cruda y cómo queda esa fila ya mapeada.
 */

import { SOURCES, _clearCsvCache } from '../src/prospecting/sources/index.js';
import { parseCsv } from '../src/prospecting/sources/csv.js';
import { apiFetchText, apiFetch } from '../src/prospecting/http.js';

const key = process.argv[2] || 'sd_active_businesses';
const source = SOURCES[key];

if (!source) {
  console.error(`Fuente desconocida: ${key}`);
  console.error(`Disponibles: ${Object.keys(SOURCES).join(', ')}`);
  process.exit(1);
}

const ok = (s) => `  ✓ ${s}`;
const bad = (s) => `  ✗ ${s}`;

async function main() {
  console.log(`\n${source.label}  [${key}]\n`);

  if (source.kind !== 'csv') {
    console.log('Fuente Socrata. Primera fila tal cual llega:\n');
    const { buildUrl } = await import('../src/prospecting/sources/index.js');
    const rows = await apiFetch(buildUrl(source, source.query({ sinceDays: 3650, limit: 1 })));
    console.log(JSON.stringify(rows[0] || {}, null, 2));
    return;
  }

  // ── Dónde está el fichero ──
  console.log('Localizando el fichero:');
  let text = null;
  let usedUrl = null;

  for (const url of source.urls || []) {
    try {
      text = await apiFetchText(url);
      usedUrl = url;
      console.log(ok(`ruta conocida responde: ${url}`));
      break;
    } catch (err) {
      console.log(bad(`ruta conocida falla (${err.message}): ${url}`));
    }
  }

  if (!text && source.ckan) {
    console.log(`  → preguntando al catálogo CKAN (${source.ckan.host}, paquete "${source.ckan.package}")`);
    const { resolveCkanResource } = await import('../src/prospecting/sources/index.js');
    const resolved = await resolveCkanResource(source.ckan);
    text = await apiFetchText(resolved);
    usedUrl = resolved;
    console.log(ok(`el catálogo apunta a: ${resolved}`));
  }

  if (!text) {
    console.error('\nNo se pudo descargar el fichero por ninguna vía.');
    process.exit(1);
  }

  const rows = parseCsv(text);
  console.log(`\n${rows.length} filas · ${Math.round(text.length / 1024)} KB · ${usedUrl}\n`);

  if (!rows.length) {
    console.error('El fichero se descargó pero no tiene filas.');
    process.exit(1);
  }

  // ── Qué columnas trae de verdad ──
  console.log('Columnas que publica el portal:');
  console.log(`  ${Object.keys(rows[0]).join(', ')}\n`);

  // ── ¿Aciertan las variantes declaradas? ──
  const sample = rows[0];
  const mapped = source.map(sample);
  const campos = ['businessName', 'address', 'city', 'zip', 'phone', 'naics', 'description', 'sourceId'];

  console.log('Mapeo de la primera fila:');
  for (const campo of campos) {
    const valor = mapped[campo];
    console.log(valor ? ok(`${campo.padEnd(14)} ${valor}`) : bad(`${campo.padEnd(14)} (vacío)`));
  }

  // ── La fecha es lo que decide si una fila entra o no ──
  const { pickDate } = await import('../src/prospecting/sources/csv.js');
  const fecha = pickDate(sample, source.dateFields || []);
  console.log('');
  console.log(fecha
    ? ok(`fecha            ${fecha.toISOString().slice(0, 10)}  (campos probados: ${source.dateFields.join(', ')})`)
    : bad(`fecha            NO SE ENCUENTRA en ninguno de: ${source.dateFields.join(', ')}`));

  const vacios = campos.filter((c) => !mapped[c] && c !== 'naics' && c !== 'sourceId');
  console.log('\n' + '─'.repeat(60));
  if (!fecha) {
    console.log('PROBLEMA: sin fecha se descarta cada fila y la corrida dará 0.');
    console.log(`Añade el nombre real de la columna de fecha a dateFields, en`);
    console.log('src/prospecting/sources/index.js.');
  } else if (vacios.length) {
    console.log(`PROBLEMA: estos campos salen vacíos: ${vacios.join(', ')}.`);
    console.log('Añade el nombre real de esas columnas a su lista en `map`, en');
    console.log('src/prospecting/sources/index.js. Las columnas reales están arriba.');
  } else {
    console.log('Todo mapeado. La fuente está lista para correr.');
  }

  console.log('\nFila cruda completa, por si hace falta:');
  console.log(JSON.stringify(sample, null, 2).slice(0, 1600));
  _clearCsvCache();
}

main().catch((err) => { console.error(`\n${err.message}`); process.exit(1); });
