import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../../config.js';

/**
 * Puerta de cumplimiento de las fuentes, en dos capas que tienen que pasar las
 * dos para que una fuente llegue a tocar la red:
 *
 *   1. EVIDENCIA (config/source-allowlist.json, versionado).
 *      Lo que una persona verificó desde una red autorizada: licencia, robots,
 *      límites, campos permitidos y prohibidos, y la decisión. El código la lee,
 *      nunca la escribe.
 *
 *   2. CONSTANCIA OPERATIVA (data/source-compliance.json, fuera de git).
 *      Lo que esta instalación concreta comprobó y cuándo. Caduca.
 *
 * `eligible` no es `enabled`. Una fuente puede estar limpia legalmente y seguir
 * apagada porque su acceso no está implementado o porque nadie ha decidido
 * encenderla. Son dos preguntas distintas y se responden por separado.
 */

const ATTESTATION_FILE = process.env.SOURCE_ATTESTATION_PATH
  || path.join(ROOT, 'data', 'source-compliance.json');

const ALLOWLIST_FILE = process.env.SOURCE_ALLOWLIST_PATH
  || path.join(ROOT, 'config', 'source-allowlist.json');

/** Una verificación caduca: los términos de un portal cambian sin avisar. */
export const MAX_ATTESTATION_AGE_DAYS = Number(process.env.SOURCE_ATTESTATION_MAX_AGE_DAYS || 180);

// ── Capa 1: evidencia de la auditoría ────────────────────────
let allowlistCache = null;

export function loadAllowlist({ reload = false } = {}) {
  if (allowlistCache && !reload) return allowlistCache;
  try {
    allowlistCache = JSON.parse(fs.readFileSync(ALLOWLIST_FILE, 'utf8'));
  } catch {
    // Sin evidencia no hay fuentes: el fallo deja todo cerrado, no abierto.
    allowlistCache = { sources: {}, rejected: {} };
  }
  return allowlistCache;
}

export function allowlistEntry(key) {
  return loadAllowlist().sources?.[key] || null;
}

/**
 * Dataset ids que la auditoría prohibió para siempre: ids inventados, datasets
 * obsoletos y datasets que exponen datos personales. Se comprueban al construir
 * la URL, así que ni un error de copia puede resucitarlos.
 */
export function bannedDatasetIds() {
  const rejected = loadAllowlist().rejected || {};
  const ids = new Set();
  for (const entry of Object.values(rejected)) {
    for (const id of entry.bannedDatasetIds || []) ids.add(String(id).toLowerCase());
  }
  return ids;
}

export function isBannedDataset(datasetId) {
  if (!datasetId) return false;
  return bannedDatasetIds().has(String(datasetId).toLowerCase());
}

export function rejectionFor(datasetId) {
  const rejected = loadAllowlist().rejected || {};
  for (const [key, entry] of Object.entries(rejected)) {
    if ((entry.bannedDatasetIds || []).some((id) => String(id).toLowerCase() === String(datasetId).toLowerCase())) {
      return { key, ...entry };
    }
  }
  return null;
}

// ── Política de campos ───────────────────────────────────────
export function allowedFields(key) {
  return allowlistEntry(key)?.fields?.allowed || [];
}

export function forbiddenFields(key) {
  return allowlistEntry(key)?.fields?.forbidden || [];
}

/**
 * Quita de una fila los campos que la auditoría prohibió.
 *
 * Se aplica antes de mapear y antes de guardar la fila cruda. Sin esto, un
 * nombre de persona acabaría en `raw_json` aunque el mapeo no lo usara: el
 * sistema lo habría almacenado igual, y eso es exactamente lo que la política
 * de datos personales trata de impedir.
 */
export function scrubRow(key, row) {
  const forbidden = forbiddenFields(key);
  if (!row || typeof row !== 'object' || !forbidden.length) return row;
  const lower = new Set(forbidden.map((f) => f.toLowerCase()));
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (!lower.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

// ── Capa 2: constancia operativa ─────────────────────────────
export function loadAttestations(file = ATTESTATION_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function saveAttestation(key, record, file = ATTESTATION_FILE) {
  const all = loadAttestations(file);
  all[key] = { ...record, key, recordedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`);
  return all[key];
}

const daysSince = (iso) => {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? (Date.now() - t) / 86400000 : Infinity;
};

/**
 * ¿Puede esta fuente salir a la red ahora mismo?
 * Devuelve el motivo exacto cuando no, para que el panel lo pueda explicar.
 */
export function checkSourceAllowed(key, source, { attestations, allowlist } = {}) {
  if (!source) return { allowed: false, reason: 'fuente_desconocida' };
  if (allowlist) allowlistCache = allowlist;

  const entry = allowlistEntry(key);
  if (!entry) {
    return { allowed: false, reason: 'sin_auditar', detail: 'no figura en config/source-allowlist.json' };
  }
  if (source.dataset && isBannedDataset(source.dataset)) {
    const r = rejectionFor(source.dataset);
    return { allowed: false, reason: 'dataset_rechazado', detail: r?.reason, state: 'REJECTED' };
  }
  if (entry.eligible !== true) {
    return { allowed: false, reason: 'no_elegible', state: entry.state, detail: entry.decision };
  }
  // Aquí se separa elegible de habilitado: la auditoría puede haber dado el
  // visto bueno legal y la fuente seguir apagada a propósito.
  if (entry.enabled !== true) {
    return {
      allowed: false,
      reason: 'no_habilitada',
      state: entry.state,
      eligible: true,
      detail: entry.decision,
      blockers: entry.blockers || [],
    };
  }
  if (entry.implemented !== true) {
    return {
      allowed: false,
      reason: 'acceso_no_implementado',
      state: entry.state,
      eligible: true,
      detail: `accessType "${entry.accessType}" sin implementar`,
      blockers: entry.blockers || [],
    };
  }
  if (entry.leadUseAllowed === false) {
    return { allowed: false, reason: 'solo_investigacion', state: entry.state, eligible: true };
  }

  const atts = attestations || loadAttestations();
  const att = atts[key];
  if (!att) {
    return {
      allowed: false,
      reason: 'sin_constancia_operativa',
      state: entry.state,
      eligible: true,
      detail: `Ejecuta: node scripts/verify-sources.js ${key}`,
    };
  }
  if (att.robotsAllowed !== true) return { allowed: false, reason: 'robots_prohibe', detail: att.robotsDetail };
  if (att.endpointVerified !== true) return { allowed: false, reason: 'endpoint_sin_confirmar', detail: att.endpointDetail };
  if (att.termsReviewed !== true) return { allowed: false, reason: 'terminos_sin_revisar', detail: att.termsUrl };

  const age = daysSince(att.verifiedAt || att.recordedAt);
  if (age > MAX_ATTESTATION_AGE_DAYS) {
    return {
      allowed: false,
      reason: 'verificacion_caducada',
      detail: `Verificada hace ${Math.round(age)} días (máximo ${MAX_ATTESTATION_AGE_DAYS}).`,
    };
  }
  return { allowed: true, state: entry.state, eligible: true, verifiedAt: att.verifiedAt || att.recordedAt };
}

export function assertSourceAllowed(key, source, opts) {
  const check = checkSourceAllowed(key, source, opts);
  if (!check.allowed) {
    const err = new Error(
      `La fuente "${key}" no está habilitada: ${check.reason}` +
      (check.detail ? ` (${check.detail})` : ''),
    );
    err.code = check.reason;
    err.state = check.state;
    throw err;
  }
  return check;
}

export const attestationFile = () => ATTESTATION_FILE;
export const allowlistFile = () => ALLOWLIST_FILE;
export const _resetAllowlistCache = () => { allowlistCache = null; };
