import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../../config.js';

/**
 * Attestation operativa basada en hashes.
 *
 * Qué es y qué NO es, porque la diferencia decide cuánto vale:
 *
 *   ES   un registro reproducible de la evidencia que alguien obtuvo desde una
 *        red autorizada: URLs, estados HTTP, licencia, robots, límites y los
 *        SHA256 de los tres artefactos que descargó. Lleva su propio digest
 *        SHA256, que cualquiera puede recomputar sin red.
 *
 *   NO ES una firma. No hay clave autorizada en este repositorio y no se
 *        inventa ninguna: un digest demuestra que el documento no ha cambiado
 *        desde que se escribió, no quién lo escribió.
 *
 *   NO ES una verificación de los hashes upstream. Los tres SHA256 de los
 *        artefactos son datos IMPORTADOS. Quien verifica offline no puede
 *        recomputarlos, porque no tiene los artefactos ni red para pedirlos.
 *        El verificador lo dice en voz alta en lugar de dejarlo entender mal.
 */

export const ATTESTATION_VERSION = 1;
export const DIGEST_FIELD = 'digest';

const attestationPath = () => process.env.SOURCE_ATTESTATION_FILE
  || path.join(ROOT, 'config', 'source-attestation.json');

/**
 * Serialización canónica: claves ordenadas en todos los niveles y sin el campo
 * del propio digest. Dos personas que escriban el mismo contenido en distinto
 * orden obtienen el mismo hash.
 */
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).filter((k) => k !== DIGEST_FIELD).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

export function computeDigest(attestation) {
  return `sha256:${crypto.createHash('sha256').update(canonicalize(attestation), 'utf8').digest('hex')}`;
}

export function loadAttestation(file = attestationPath()) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Campos sin los que la attestation no significa nada. */
const REQUIRED_TOP = ['version', 'kind', 'generatedAt', 'evidenceCollectedAt', 'collectedFrom', 'sources', 'digest'];
const REQUIRED_PER_SOURCE = ['sourceId', 'license', 'robots', 'limits', 'artifacts', 'decision'];
const REQUIRED_ARTIFACT = ['url', 'httpStatus', 'sha256'];
const SHA256_RE = /^[0-9a-f]{64}$/i;

/**
 * Valida estructura, digest y edad. Todo offline, sin una sola petición.
 *
 * Devuelve `{ valid, checks, problems }`: `checks` dice qué se comprobó de
 * verdad, para que nadie confunda "digest correcto" con "hashes upstream
 * verificados".
 */
export function verifyAttestation(attestation, { now = Date.now(), maxAgeDays = 180 } = {}) {
  const problems = [];
  const checks = {
    structure: false,
    digest: false,
    age: false,
    upstreamHashesRecomputed: false,   // nunca true: haría falta red y artefactos
    signature: 'no_aplica_sin_clave_autorizada',
    networkFetchPerformed: false,
  };

  if (!attestation || typeof attestation !== 'object') {
    return { valid: false, checks, problems: ['la attestation no es un objeto'] };
  }

  for (const field of REQUIRED_TOP) {
    if (attestation[field] === undefined) problems.push(`falta el campo "${field}"`);
  }
  if (attestation.version !== ATTESTATION_VERSION) {
    problems.push(`versión ${attestation.version}, se esperaba ${ATTESTATION_VERSION}`);
  }
  if (attestation.kind !== 'hash-based-attestation') {
    problems.push(`kind "${attestation.kind}": se esperaba "hash-based-attestation"`);
  }
  if (attestation.signature !== undefined) {
    // Una firma aquí sería una afirmación que este repositorio no puede
    // sostener: no hay clave autorizada con la que comprobarla.
    problems.push('lleva un campo "signature" y no hay clave autorizada para validarlo');
  }

  const sources = attestation.sources && typeof attestation.sources === 'object' ? attestation.sources : {};
  if (!Object.keys(sources).length) problems.push('no declara ninguna fuente');

  for (const [key, entry] of Object.entries(sources)) {
    for (const field of REQUIRED_PER_SOURCE) {
      if (entry?.[field] === undefined) problems.push(`${key}: falta "${field}"`);
    }
    const artifacts = entry?.artifacts;
    if (!artifacts || typeof artifacts !== 'object' || !Object.keys(artifacts).length) {
      problems.push(`${key}: no declara artefactos con hash`);
      continue;
    }
    for (const [name, art] of Object.entries(artifacts)) {
      for (const field of REQUIRED_ARTIFACT) {
        if (art?.[field] === undefined) problems.push(`${key}/${name}: falta "${field}"`);
      }
      if (art?.sha256 !== undefined && !SHA256_RE.test(String(art.sha256))) {
        problems.push(`${key}/${name}: el sha256 no tiene forma de SHA256`);
      }
      if (art?.httpStatus !== undefined && art.httpStatus !== 200) {
        problems.push(`${key}/${name}: httpStatus ${art.httpStatus}, se esperaba 200`);
      }
    }
  }
  checks.structure = problems.length === 0;

  // ── Digest ──
  const expected = computeDigest(attestation);
  if (attestation.digest === expected) {
    checks.digest = true;
  } else {
    problems.push(`digest no coincide: documento ${attestation.digest}, recomputado ${expected}`);
  }

  // ── Edad ──
  const collected = Date.parse(attestation.evidenceCollectedAt);
  if (!Number.isFinite(collected)) {
    problems.push('evidenceCollectedAt no es una fecha válida');
  } else {
    const ageDays = (now - collected) / 86400000;
    if (ageDays < 0) {
      problems.push(`la evidencia está fechada en el futuro (${Math.abs(Math.round(ageDays))} días)`);
    } else if (ageDays > maxAgeDays) {
      problems.push(`evidencia de hace ${Math.round(ageDays)} días (máximo ${maxAgeDays})`);
    } else {
      checks.age = true;
      checks.ageDays = Math.round(ageDays * 10) / 10;
    }
  }

  return { valid: problems.length === 0, checks, problems, expectedDigest: expected };
}

/** Attestation vigente para una fuente, ya verificada. */
export function attestationFor(sourceId, { now = Date.now(), maxAgeDays = 180, file = attestationPath() } = {}) {
  const att = loadAttestation(file);
  if (!att) return { ok: false, reason: 'sin_attestation' };
  const result = verifyAttestation(att, { now, maxAgeDays });
  if (!result.valid) return { ok: false, reason: 'attestation_invalida', problems: result.problems };
  const entry = att.sources?.[sourceId];
  if (!entry) return { ok: false, reason: 'fuente_no_atestiguada' };
  return { ok: true, entry, attestation: att, checks: result.checks };
}

export const attestationFilePath = attestationPath;
