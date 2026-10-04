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
 * Attestations, una por fuente y cada una con su propio digest.
 *
 * Un solo archivo con todas las fuentes obligaría a recomputar el digest del
 * documento cada vez que se añade una fuente, y entonces la huella de la
 * evidencia del condado —que el operador recogió un día concreto desde su red—
 * cambiaría por un motivo que no tiene nada que ver con ella. Separadas, cada
 * evidencia se verifica, caduca y se renueva por su cuenta.
 *
 * `SOURCE_ATTESTATION_FILE` sigue funcionando y gana: las pruebas lo usan para
 * apuntar a un archivo propio.
 */
export function attestationPaths() {
  if (process.env.SOURCE_ATTESTATION_FILE) return [process.env.SOURCE_ATTESTATION_FILE];
  if (process.env.SOURCE_ATTESTATION_FILES) {
    return process.env.SOURCE_ATTESTATION_FILES.split(',').map((f) => f.trim()).filter(Boolean);
  }
  // Se descubren por nombre en lugar de listarlas a mano: una lista fija
  // significa que añadir una fuente y olvidar su archivo la deja sin evidencia
  // sin que nada lo diga, y "sin evidencia" es justo lo que no debe pasar
  // desapercibido.
  const dir = path.join(ROOT, 'config');
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => /^source-attestation.*\.json$/.test(n))
    .sort()
    .map((n) => path.join(dir, n));
}

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
  if (attestation.collectedFrom?.liveVerifiedFromCloud === true) {
    checks.liveVerifiedFromCloud = true;
  } else {
    checks.liveVerifiedFromCloud = false;
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
      // Evidencia AUSENTE, no evidencia débil.
      //
      // Un sha256 de ceros tiene forma de hash y no es uno: es el marcador de un
      // artefacto que nadie ha descargado. Lo mismo con `evidencePending`. Las
      // dos cosas invalidan la attestation a propósito: una fuente cuya
      // evidencia está pendiente no puede pasar la puerta, y eso es lo que
      // mantiene los scouts apagados mientras no haya egress para auditarlos.
      if (art?.evidencePending === true) {
        problems.push(`${key}/${name}: la evidencia está pendiente (evidencePending)`);
      }
      if (/^0{64}$/.test(String(art?.sha256 ?? ''))) {
        problems.push(`${key}/${name}: el sha256 es un marcador de evidencia ausente, no una huella`);
      }
      // Un artefacto tiene que haberse descargado bien... salvo cuando el propio
      // estado ES el hallazgo.
      //
      // El caso que obliga a esto: un `robots.txt` que devuelve 404 es evidencia
      // legítima y de las importantes — dice que el publicador no tiene política.
      // Exigir 200 a todo artefacto dejaba dos salidas, las dos malas: registrar
      // un 404 como si fuera un 200, u omitir el robots de la evidencia. Así que
      // se admite un estado distinto cuando el documento lo declara como
      // observación esperada, y solo entonces.
      const estadoEsEvidencia = art?.httpStatusIsEvidence === true;
      if (art?.httpStatus !== undefined && art.httpStatus !== 200 && !estadoEsEvidencia) {
        problems.push(`${key}/${name}: httpStatus ${art.httpStatus}, se esperaba 200`);
      }
      if (estadoEsEvidencia && !art?.sha256Scope && !art?.note) {
        // Si el estado es el hallazgo, hay que decir cuál es el hallazgo.
        problems.push(`${key}/${name}: declara httpStatusIsEvidence sin explicar qué significa`);
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

/**
 * Attestation vigente para una fuente, ya verificada.
 *
 * Recorre los archivos de evidencia y se queda con el PRIMERO que declare esa
 * fuente. Que otro archivo esté caducado o malformado no bloquea a una fuente
 * cuya evidencia está en regla: cada fuente responde por la suya. Pero si el
 * archivo que SÍ la declara no valida, no se busca más: fail-closed.
 */
export function attestationFor(sourceId, { now = Date.now(), maxAgeDays = 180, file = null, files = null } = {}) {
  const candidates = file ? [file] : (files || attestationPaths());
  const problemsSeen = [];

  for (const candidate of candidates) {
    const att = loadAttestation(candidate);
    if (!att) continue;
    if (att.sources?.[sourceId] === undefined) continue;

    const result = verifyAttestation(att, { now, maxAgeDays });
    if (!result.valid) {
      return {
        ok: false, reason: 'attestation_invalida', problems: result.problems, file: candidate,
      };
    }
    return { ok: true, entry: att.sources[sourceId], attestation: att, checks: result.checks, file: candidate };
  }

  if (problemsSeen.length) return { ok: false, reason: 'attestation_invalida', problems: problemsSeen };
  return { ok: false, reason: 'fuente_no_atestiguada' };
}

export const attestationFilePath = attestationPath;
