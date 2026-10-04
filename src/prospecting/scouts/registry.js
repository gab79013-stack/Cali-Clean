/**
 * Registro de los scouts de la fase 3: manifiesto, puerta y guard duro.
 *
 * Separado del allowlist de San Diego a propósito. Cada scout responde por su
 * propio manifiesto (`config/scouts/<id>.json`), su propia evidencia
 * (`config/source-attestation-<slug>.json` con su digest), su propia cuota y su
 * propia decisión operativa. Que una fuente esté en regla no dice nada de otra.
 *
 * La puerta tiene las mismas dos capas que ya gobiernan County y City, y en el
 * mismo orden, porque el orden es parte de la respuesta:
 *
 *   elegible → habilitada → implementada → constancia vigente
 *
 * Un scout no sale a la red si falla cualquiera de las cuatro, y hoy fallan
 * todos en la cuarta: su evidencia está marcada como pendiente porque Cloud no
 * tiene egress a sus hosts y no puede auditarla. Eso es fail-closed funcionando,
 * no un error que arreglar.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../../config.js';
import { attestationFor } from '../sources/attestation.js';

export const SCOUT_IDS = Object.freeze(['cslb_contractors', 'hud_multifamily', 'hcai_facilities']);

/** Dónde vive el manifiesto de cada scout. */
const manifestDir = () => process.env.SCOUT_MANIFEST_DIR || path.join(ROOT, 'config', 'scouts');

let cache = null;

export function loadManifests({ reload = false, dir = manifestDir() } = {}) {
  if (cache && !reload) return cache;
  const out = {};
  for (const id of SCOUT_IDS) {
    const file = path.join(dir, `${id}.json`);
    try {
      out[id] = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      // Un manifiesto ilegible no se sustituye por valores por defecto: el scout
      // se queda sin manifiesto y la puerta lo bloquea.
      out[id] = { scoutId: id, broken: true, error: err.message };
    }
  }
  cache = out;
  return out;
}

export function manifestFor(scoutId, opts = {}) {
  return loadManifests(opts)[scoutId] || null;
}

/** Campos que un scout puede conservar, según su manifiesto. */
export function allowedFields(scoutId) {
  return manifestFor(scoutId)?.fields?.allowed || [];
}

/** Campos que no se piden nunca al servidor. */
export function neverRequested(scoutId) {
  return manifestFor(scoutId)?.fields?.neverRequested || [];
}

/**
 * Guard duro del outbound.
 *
 * No devuelve un valor: lanza. Un guard que se pueda ignorar leyendo mal su
 * resultado no es un guard, y esta fase no envía nada bajo ninguna
 * circunstancia.
 */
export function assertOutboundDisabled(config) {
  if (config?.outbound?.enabled !== false) {
    throw new Error(
      'OUTBOUND_ENABLED tiene que ser false para correr cualquier parte de la fase 3. '
      + `Vale ${JSON.stringify(config?.outbound?.enabled)}. No se continúa.`,
    );
  }
  return true;
}

/**
 * ¿Puede este scout salir a la red ahora mismo?
 *
 * Devuelve el motivo exacto cuando no, para que un informe lo pueda explicar sin
 * que nadie tenga que leer el código.
 */
export function checkScoutAllowed(scoutId, { now = Date.now(), maxAgeDays = 180 } = {}) {
  if (!SCOUT_IDS.includes(scoutId)) {
    return { allowed: false, reason: 'scout_desconocido' };
  }
  const m = manifestFor(scoutId);
  if (!m || m.broken) {
    return { allowed: false, reason: 'sin_manifiesto', detail: m?.error || 'no se pudo leer el manifiesto' };
  }
  if (m.eligible !== true) {
    return { allowed: false, reason: 'no_elegible', state: m.state, detail: m.decision };
  }
  if (m.enabled !== true) {
    return {
      allowed: false, reason: 'no_habilitada', state: m.state, eligible: true,
      detail: m.decision, blockers: m.blockers || [],
    };
  }
  if (m.implemented !== true) {
    return { allowed: false, reason: 'acceso_no_implementado', state: m.state, eligible: true };
  }

  const att = attestationFor(scoutId, { now, maxAgeDays });
  if (!att.ok) {
    return {
      allowed: false,
      reason: att.reason === 'fuente_no_atestiguada' ? 'sin_constancia_operativa' : 'constancia_invalida',
      state: m.state,
      eligible: true,
      detail: (att.problems || []).join('; ') || att.reason,
    };
  }
  // La verificación en vivo desde Cloud no se da por hecha: mientras la
  // evidencia no se haya obtenido desde aquí, se dice.
  return {
    allowed: true,
    state: m.state,
    eligible: true,
    attestationFile: att.file,
    liveVerifiedFromCloud: att.checks?.liveVerifiedFromCloud === true,
  };
}

export function assertScoutAllowed(scoutId, opts) {
  const check = checkScoutAllowed(scoutId, opts);
  if (!check.allowed) {
    const err = new Error(
      `El scout "${scoutId}" no puede salir a la red: ${check.reason}`
      + (check.detail ? ` (${check.detail})` : ''),
    );
    err.code = check.reason;
    err.scoutId = scoutId;
    throw err;
  }
  return check;
}

/** Estado de los tres, para un informe o un panel. */
export function scoutStatus(opts = {}) {
  return SCOUT_IDS.map((id) => {
    const m = manifestFor(id) || {};
    return {
      scoutId: id,
      displayName: m.displayName || id,
      label: m.label || id,
      accessType: m.accessType || null,
      egressHost: m.egressHost || null,
      dedupNamespace: m.dedupNamespace || null,
      state: m.state || 'SIN_MANIFIESTO',
      eligible: m.eligible === true,
      enabled: m.enabled === true,
      implemented: m.implemented === true,
      maxAcceptedPerRun: m.limits?.maxAcceptedPerRun ?? null,
      blockers: m.blockers || [],
      ...checkScoutAllowed(id, opts),
    };
  });
}

/** Los hosts que habría que permitir para una preview real. Uno por scout. */
export function requiredEgressHosts() {
  return SCOUT_IDS.map((id) => manifestFor(id)?.egressHost).filter(Boolean);
}

/** Métricas de una corrida de scout. Solo recuentos, nunca filas. */
export const emptyScoutMetrics = () => ({
  requests: 0,
  bytes: 0,
  fetched: 0,
  accepted: 0,
  rejected_personal: 0,
  rejected_residential: 0,
  rejected_inactive: 0,
  rejected_out_of_area: 0,
  rejected_unverifiable: 0,
  rejected_malformed: 0,
  deduped: 0,
  retries: 0,
  http429: 0,
  quota_blocked: 0,
  errors: 0,
  duration_ms: 0,
  // Invariantes de la fase, medidas y reportadas en cada corrida.
  crm_writes: 0,
  outbound: 0,
});

/** Suma un rechazo a la métrica que le corresponde por su `kind`. */
export function countRejection(metrics, kind) {
  const campo = `rejected_${kind || 'unverifiable'}`;
  if (metrics[campo] === undefined) metrics.rejected_unverifiable++;
  else metrics[campo]++;
  return metrics;
}

export default loadManifests;
