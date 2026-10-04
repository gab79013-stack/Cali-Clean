/**
 * Informe por fuente, con alertas solo cuando hay algo que decir.
 *
 * El criterio de qué es una alerta: algo que **falló** o algo que **cambió de
 * forma significativa**. Una corrida bloqueada por cuota no es ninguna de las
 * dos cosas —es el sistema funcionando— y por eso no alerta. Un informe que
 * avisa de todo acaba sin que nadie lo lea, y entonces el día que avisa de algo
 * que importa, tampoco.
 *
 * Y una regla sobre el contenido: aquí no entra ni una fila cruda. Solo
 * recuentos, hashes y los nombres comerciales cuando se piden explícitamente.
 */

/** Umbrales que convierten un recuento en una señal. */
export const ALERT_RULES = Object.freeze({
  // Cualquiera de estos a más de cero es un fallo de contención, no una métrica.
  zeroTolerance: ['crm_writes', 'outbound'],
  // Si se trajeron filas y ninguna sobrevivió, algo cambió arriba.
  emptyAfterFetch: true,
  // Proporción de descartes por encima de la cual conviene mirar las reglas.
  skipRatioWarn: 0.97,
  // Variación del tamaño del CSV frente a lo atestiguado.
  csvBytesDriftWarn: 0.4,
});

const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

/**
 * Alertas de una corrida. Devuelve `[]` cuando no hay nada que contar, y eso es
 * el caso normal.
 */
export function detectAlerts({ sourceId, metrics = {}, csv = null, blocked = null, attestedBytes = null }) {
  const alerts = [];
  const add = (level, code, message) => alerts.push({ level, code, message, sourceId });

  for (const field of ALERT_RULES.zeroTolerance) {
    if ((metrics[field] || 0) > 0) {
      add('critical', `${field}_no_cero`,
        `${field} = ${metrics[field]} y tenía que ser 0: una corrida de fuentes no escribe ni envía.`);
    }
  }
  if ((metrics.errors || 0) > 0) {
    add('error', 'errores', `${metrics.errors} errores durante la corrida.`);
  }

  // Un bloqueo de cuota es el sistema funcionando. Uno de cursor o de índice es
  // una dependencia caída, y eso sí hay que contarlo.
  if (blocked) {
    const esperable = ['cuota_24h', 'cuota_24h_durable', 'sin_cambios_304'];
    if (!esperable.includes(blocked.reason)) {
      add('warn', `bloqueo_${blocked.reason}`, `bloqueada por ${blocked.reason}: ${blocked.detail}`);
    }
  }

  if (ALERT_RULES.emptyAfterFetch && (metrics.fetched || 0) > 0 && (metrics.mapped || 0) === 0) {
    add('warn', 'sin_candidatos',
      `se trajeron ${metrics.fetched} filas y ninguna sobrevivió: puede que el formato de origen haya cambiado.`);
  }

  const descartes = (metrics.skipped_personal || 0) + (metrics.skipped_residential || 0)
    + (metrics.skipped_inactive || 0) + (metrics.skipped_unverifiable || 0)
    + (metrics.skipped_invalid || 0) + (metrics.skipped_sensitive || 0);
  const vistas = metrics.fetched || 0;
  if (vistas > 100 && descartes / vistas > ALERT_RULES.skipRatioWarn) {
    add('warn', 'descarte_altisimo',
      `se descartó el ${pct(descartes, vistas)}% de ${vistas} filas: conviene mirar si una regla se pasó de estricta.`);
  }

  if (csv?.bytes && attestedBytes) {
    const drift = Math.abs(csv.bytes - attestedBytes) / attestedBytes;
    if (drift > ALERT_RULES.csvBytesDriftWarn) {
      add('warn', 'csv_tamano_distinto',
        `el CSV pesa ${csv.bytes} bytes y la evidencia registró ${attestedBytes} `
        + `(${Math.round(drift * 100)}% de diferencia): puede que el publicador haya cambiado el archivo.`);
    }
  }

  return alerts;
}

/** Informe de texto de una fuente. Recuentos, nunca filas. */
export function formatSourceReport({ sourceId, label, metrics = {}, csv = null, blocked = null, plan = null, alerts = [] }) {
  const lines = [];
  lines.push(`── ${label || sourceId} ──`);
  if (blocked) lines.push(`  estado: BLOQUEADA · ${blocked.reason} — ${blocked.detail}`);
  else lines.push('  estado: corrida completada');

  lines.push(`  red:     ${metrics.attempted || 0} petición(es)`
    + (metrics.fetched_bytes ? ` · ${(metrics.fetched_bytes / 1048576).toFixed(1)} MB` : '')
    + (metrics.retries ? ` · ${metrics.retries} reintentos` : '')
    + (metrics.http429 ? ` · ${metrics.http429} × HTTP 429` : ''));
  if (csv?.sha256) lines.push(`  csv:     sha256 ${csv.sha256.slice(0, 16)}…${csv.sha256.slice(-8)}`);
  if (csv?.headers?.lastModified) lines.push(`  volcado: ${csv.headers.lastModified}`);

  lines.push(`  filas:   ${metrics.fetched || 0} vistas → ${metrics.mapped || 0} candidatos`);
  const descartes = [
    ['personales', metrics.skipped_personal],
    ['domicilio', metrics.skipped_residential],
    ['inactivas', metrics.skipped_inactive],
    ['no verificables', metrics.skipped_unverifiable],
    ['ya en el CRM', metrics.skipped_duplicate_existing],
    ['duplicadas en la corrida', metrics.deduped],
    ['malformadas', metrics.skipped_invalid],
  ].filter(([, v]) => (v || 0) > 0);
  if (descartes.length) {
    lines.push(`  descartes: ${descartes.map(([k, v]) => `${v} ${k}`).join(' · ')}`);
  }

  if (plan) {
    lines.push(`  plan:    crear ${plan.create || 0} · actualizar ${plan.update || 0} `
      + `· sin cambios ${plan.noop || 0} · errores ${plan.error || 0}`);
  }
  lines.push(`  contención: crm_writes=${metrics.crm_writes || 0} · outbound=${metrics.outbound || 0}`);
  lines.push(`  duración: ${metrics.duration_ms || 0} ms`);

  if (alerts.length) {
    lines.push('  alertas:');
    for (const a of alerts) lines.push(`    [${a.level.toUpperCase()}] ${a.code}: ${a.message}`);
  } else {
    lines.push('  alertas: ninguna');
  }
  return lines.join('\n');
}

/**
 * Lo que se sabe hoy sobre un panel dentro de Twenty, comprobado por GET contra
 * la instancia el 2026-10-04.
 *
 * Vive aquí, y no en un documento, porque es la respuesta a "¿podemos montar el
 * dashboard?" y la va a buscar quien lea este módulo.
 */
export const TWENTY_DASHBOARD_FEASIBILITY = Object.freeze({
  checkedAt: '2026-10-04',
  endpointExists: true,
  readable: false,
  observed: 'GET /rest/dashboards → 400 PERMISSION_DENIED ("Entity performing the request does not have permission")',
  schemaLimitation: 'El objeto Dashboard solo expone title, position y pageLayoutId. Los widgets viven en un '
    + 'page layout que la API REST no modela, así que ni leyéndolo se podría construir el contenido.',
  conclusion: 'Hoy NO se puede, ni con permisos mínimos ni con los actuales: la credencial no puede leer '
    + 'dashboards y la API no expone los widgets. Haría falta ampliar permisos del token Y una vía para el '
    + 'page layout. Mientras tanto, el informe por fuente de este módulo cubre la necesidad sin tocar el CRM.',
});

export default formatSourceReport;
