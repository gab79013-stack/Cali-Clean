import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../../config.js';

/**
 * Puerta de cumplimiento de las fuentes.
 *
 * Una fuente no se consulta por estar escrita en el catálogo: se consulta
 * cuando alguien comprobó su robots.txt y sus términos y dejó constancia. La
 * comprobación la hace `scripts/verify-sources.js` y se guarda aquí.
 *
 * El motivo de que esto sea código y no una nota en el README: una fuente
 * añadida "para probar" y olvidada acaba rastreando un sitio que no lo permite,
 * y para entonces nadie recuerda que faltaba verificarla.
 */

const ATTESTATION_FILE = process.env.SOURCE_ATTESTATION_PATH
  || path.join(ROOT, 'data', 'source-compliance.json');

/** Una verificación caduca: los términos de un portal cambian sin avisar. */
export const MAX_ATTESTATION_AGE_DAYS = Number(process.env.SOURCE_ATTESTATION_MAX_AGE_DAYS || 180);

export function loadAttestations(file = ATTESTATION_FILE) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
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
 * ¿Se puede consultar esta fuente ahora mismo?
 * Devuelve el motivo exacto cuando no, para que el panel lo pueda explicar.
 */
export function checkSourceAllowed(key, source, { attestations = loadAttestations() } = {}) {
  if (!source) return { allowed: false, reason: 'fuente_desconocida' };

  const att = attestations[key];
  if (!att) {
    return {
      allowed: false,
      reason: 'sin_verificar',
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
  return { allowed: true, verifiedAt: att.verifiedAt || att.recordedAt };
}

export function assertSourceAllowed(key, source, opts) {
  const check = checkSourceAllowed(key, source, opts);
  if (!check.allowed) {
    const err = new Error(
      `La fuente "${key}" no está habilitada: ${check.reason}` +
      (check.detail ? ` (${check.detail})` : ''),
    );
    err.code = check.reason;
    throw err;
  }
  return check;
}

export const attestationFile = () => ATTESTATION_FILE;
