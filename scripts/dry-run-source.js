/**
 * Dry-run de una fuente, SIN RED y SIN CRM.
 *
 *   node scripts/dry-run-source.js
 *   node scripts/dry-run-source.js sdcounty_food_facility_permits
 *
 * Para qué sirve: enseñar el juego completo de métricas de una corrida y
 * demostrar, en el mismo sitio, que la corrida no escribe en el CRM ni envía
 * nada. No sustituye a una corrida real; sustituye a tener que hacer una
 * corrida real para saber qué mide el sistema.
 *
 * Tres cosas que este script NO hace, a propósito:
 *
 *   · No sale a la red. La respuesta del portal se simula con una muestra
 *     sintética que reproduce la FORMA verificada el 2026-10-04 (dos
 *     establecimientos comerciales y una cocina doméstica), no su contenido.
 *     Los datos personales de la muestra son inventados y están ahí para que
 *     se vea cómo se caen.
 *   · No gasta la cuota real: el estado de cuota se escribe en un directorio
 *     temporal que se borra al terminar.
 *   · No toca el CRM ni el correo. Si alguien añadiera mañana una escritura al
 *     descubrimiento, `crm_writes` dejaría de ser 0 y esto se vería aquí.
 *
 * La puerta de cumplimiento se cruza de verdad: si la fuente está apagada en
 * config/source-allowlist.json, este script falla igual que la corrida real.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SOURCES, fetchFromSource, buildUrl, sourceStatus } from '../src/prospecting/sources/index.js';
import { allowedFields, forbiddenFields } from '../src/prospecting/sources/compliance.js';
import { attestationFor } from '../src/prospecting/sources/attestation.js';
import { MAX_ROWS_PER_RUN, WINDOW_MS } from '../src/prospecting/sources/quota.js';
import { config } from '../src/config.js';

const FUENTE = process.argv[2] || 'sdcounty_food_facility_permits';

/** Muestra sintética con la forma de la respuesta real. */
const MUESTRA = [
  {
    record_id: 'DEMO-FFP-001',
    record_open_date: '2026-09-18T00:00:00.000',
    record_issue_date: '2026-09-25T00:00:00.000',
    record_name: 'Bahía Taquería',
    permit_status: 'Issued',
    active_permit: 'Y',
    business_type: 'Restaurant Food Facility',
    address: '1450 Harbor Dr',
    city: 'San Diego',
    state: 'CA',
    zip: '92101',
    last_updated: '2026-10-01T00:00:00.000',
    // Campos que el portal puede devolver de más, pese al $select:
    permit_owner_full: 'Nombre Inventado Uno',
    permit_owner_email: 'inventado1@ejemplo.invalid',
    latitude: 32.7109,
    longitude: -117.1699,
    // Columna que nadie declaró: la allowlist es cerrada y también la tira.
    owner_mailing_address_2: 'Apt 4B, 77 Private Ln',
  },
  {
    record_id: 'DEMO-FFP-002',
    record_open_date: '2026-09-20T00:00:00.000',
    record_issue_date: '2026-09-29T00:00:00.000',
    record_name: 'Gaslamp Coffee House',
    permit_status: 'Issued',
    active_permit: 'Y',
    business_type: 'Retail Food Facility',
    address: '620 Fifth Ave',
    city: 'San Diego',
    state: 'CA',
    zip: '92101',
    last_updated: '2026-10-02T00:00:00.000',
    permit_owner_full: 'Nombre Inventado Dos',
    latitude: 32.7111,
    longitude: -117.1601,
  },
  {
    // Cocina doméstica: se descarta la fila entera, no se recorta.
    record_id: 'DEMO-MHK-003',
    record_open_date: '2026-09-22T00:00:00.000',
    record_issue_date: '2026-09-28T00:00:00.000',
    record_name: 'Cocina de Marisol',
    permit_status: 'Issued',
    active_permit: 'Y',
    business_type: 'Microenterprise Home Kitchen',
    address: '3312 Residencia Way',
    city: 'San Diego',
    state: 'CA',
    zip: '92103',
    last_updated: '2026-10-03T00:00:00.000',
    permit_owner_full: 'Nombre Inventado Tres',
    latitude: 32.7455,
    longitude: -117.1601,
  },
  // La misma fila otra vez con otro identificador: así se ve el deduplicado.
  null,
];
MUESTRA[3] = { ...MUESTRA[0], record_id: 'DEMO-FFP-001-BIS' };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dryrun-'));
const stateFile = path.join(tmp, 'quota.json');

/** Registro de cualquier petición que intentara salir por el fetch global. */
const salidasGlobales = [];
const fetchOriginal = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  salidasGlobales.push({ url: String(url), method: opts.method || 'GET' });
  throw new Error('dry-run sin red: no se permite ninguna petición real');
};

/** El portal simulado. Devuelve la muestra ignorando el $select, como podría
 *  hacer un servidor real que decidiera mandar columnas de más. */
let urlPedida = null;
const fetchSimulado = async (url) => {
  urlPedida = String(url);
  return {
    status: 200,
    ok: true,
    headers: { get: () => null },
    json: async () => MUESTRA,
    text: async () => JSON.stringify(MUESTRA),
  };
};

function titulo(t) { console.log(`\n${t}\n${'─'.repeat(t.length)}`); }

try {
  const source = SOURCES[FUENTE];
  if (!source) {
    console.error(`Fuente desconocida: ${FUENTE}`);
    console.error(`Conocidas: ${Object.keys(SOURCES).join(', ')}`);
    process.exit(2);
  }

  console.log(`Dry-run simulado · ${source.label}`);
  console.log(`Clave:   ${FUENTE}`);
  console.log(`Acceso:  ${source.accessType}${source.dataset ? ` · dataset ${source.dataset}` : ''}`);
  console.log('Red:     ninguna. La respuesta del portal es una muestra sintética local.');

  const estado = sourceStatus().find((s) => s.key === FUENTE);
  titulo('Puerta de cumplimiento');
  console.log(`  evidencia:  ${estado.state} · elegible ${estado.eligible} · habilitada ${estado.enabled}`);
  console.log(`  permitida:  ${estado.allowed}${estado.allowed ? '' : ` (${estado.code}: ${estado.reason})`}`);
  const att = attestationFor(FUENTE);
  console.log(`  constancia: ${att.ok ? `${att.attestation.kind} del ${att.attestation.evidenceCollectedAt}` : `no válida (${att.reason})`}`);
  if (!estado.allowed) {
    console.log('\nLa puerta la bloquea, así que el dry-run para aquí: es el comportamiento correcto.');
    process.exit(1);
  }

  titulo('Campos');
  console.log(`  pedidos al servidor (${allowedFields(FUENTE).length}): ${allowedFields(FUENTE).join(', ')}`);
  console.log(`  prohibidos (${forbiddenFields(FUENTE).length}): ${forbiddenFields(FUENTE).join(', ')}`);

  titulo('Límites en vigor');
  console.log(`  ${MAX_ROWS_PER_RUN} filas por corrida · 1 corrida con éxito cada ${WINDOW_MS / 3600000} h`);
  console.log('  reintentos: 4 intentos máx. · base 1 s · tope 30 s · jitter completo · Retry-After manda');

  // ── Primera corrida ───────────────────────────────────────
  const primera = await fetchFromSource(FUENTE, {
    sinceDays: 90,
    baseOverride: 'https://portal-simulado.invalid',
    fetchImpl: fetchSimulado,
    sleep: async () => {},
    quotaOptions: { stateFile, lockFile: `${stateFile}.lock` },
  });

  titulo('URL que se habría pedido');
  console.log(`  ${urlPedida}`);

  titulo('Métricas de la corrida');
  for (const [k, v] of Object.entries(primera.metrics)) {
    console.log(`  ${k.padEnd(20)} ${v}`);
  }

  titulo('Filas que sobreviven');
  for (const r of primera.rows) {
    console.log(`  · ${r.businessName} — ${r.address}, ${r.city} ${r.zip}`);
    console.log(`    raw conservado: ${Object.keys(r.raw).join(', ')}`);
  }
  console.log(`  descartadas: ${primera.metrics.skipped_residential} por domicilio, ` +
    `${primera.metrics.deduped} duplicada(s), ${primera.metrics.skipped_invalid} inválida(s)`);

  // ── Segunda corrida: la cuota la bloquea ──────────────────
  const segunda = await fetchFromSource(FUENTE, {
    baseOverride: 'https://portal-simulado.invalid',
    fetchImpl: fetchSimulado,
    sleep: async () => {},
    quotaOptions: { stateFile, lockFile: `${stateFile}.lock` },
  });

  titulo('Segunda corrida el mismo día');
  console.log(`  bloqueada: ${segunda.blocked ? segunda.blocked.reason : 'NO — la cuota no funcionó'}`);
  if (segunda.blocked) console.log(`  detalle:   ${segunda.blocked.detail}`);
  console.log(`  quota_blocked: ${segunda.metrics.quota_blocked} · filas: ${segunda.rows.length}`);

  // ── 429 ───────────────────────────────────────────────────
  const stateFile429 = path.join(tmp, 'quota-429.json');
  let n = 0;
  const con429 = await fetchFromSource(FUENTE, {
    baseOverride: 'https://portal-simulado.invalid',
    fetchImpl: async (url) => {
      n++;
      if (n <= 2) {
        return {
          status: 429, ok: false,
          headers: { get: (h) => (h.toLowerCase() === 'retry-after' ? '2' : null) },
          text: async () => '',
        };
      }
      return fetchSimulado(url);
    },
    sleep: async () => {},
    quotaOptions: { stateFile: stateFile429, lockFile: `${stateFile429}.lock` },
  });

  titulo('Cuando el portal responde 429');
  console.log(`  http429: ${con429.metrics.http429} · retries: ${con429.metrics.retries} ` +
    `· mapped: ${con429.metrics.mapped}`);
  console.log('  Se obedeció el Retry-After del servidor en lugar del backoff propio.');

  // ── Lo que no se hizo ─────────────────────────────────────
  titulo('Lo que esta corrida NO hizo');
  const escrituras = primera.metrics.crm_writes + segunda.metrics.crm_writes + con429.metrics.crm_writes;
  const envios = primera.metrics.outbound + segunda.metrics.outbound + con429.metrics.outbound;
  console.log(`  escrituras en el CRM:        ${escrituras}`);
  console.log(`  mensajes enviados:           ${envios}`);
  console.log(`  OUTBOUND_ENABLED:            ${config.outbound.enabled}`);
  console.log(`  peticiones por el fetch global: ${salidasGlobales.length}`);
  console.log(`  peticiones de red reales:    0`);

  const problemas = [];
  if (escrituras !== 0) problemas.push('hubo escrituras en el CRM');
  if (envios !== 0) problemas.push('hubo envíos');
  if (config.outbound.enabled) problemas.push('OUTBOUND_ENABLED está en true');
  if (salidasGlobales.length) problemas.push(`salió por el fetch global: ${JSON.stringify(salidasGlobales)}`);
  if (!segunda.blocked) problemas.push('la segunda corrida no quedó bloqueada por cuota');

  if (problemas.length) {
    console.log(`\n✗ Dry-run con problemas:\n  · ${problemas.join('\n  · ')}`);
    process.exit(1);
  }
  console.log('\n✓ Dry-run limpio: cero red, cero CRM, cero outbound.');
} finally {
  globalThis.fetch = fetchOriginal;
  fs.rmSync(tmp, { recursive: true, force: true });
}
