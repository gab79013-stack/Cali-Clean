/**
 * Clasificador de correo entrante y borradores sugeridos.
 *
 * **Este módulo no envía, y no puede.** No importa ningún cliente de correo, no
 * conoce ninguna URL de envío y lo único que devuelve es texto dentro de un
 * objeto. Si algún día alguien quiere enviar, tendrá que escribir el envío en
 * otro sitio y a la vista de todos.
 *
 * Y no clasifica correo real por su cuenta: `classifyInbound` recibe metadata ya
 * leída por quien llama. La auditoría de este espacio de trabajo encontró 91
 * mensajes sincronizados y **ninguno vinculable** a las Companies del piloto —
 * 137 de 140 no tienen dominio, porque nunca se les inventó uno. Así que el
 * clasificador existe, está probado con fixtures, y espera.
 *
 * Tres cosas que NO hace, por diseño:
 *
 *   · no marca leído ni toca el hilo: solo mira metadata que ya estaba leída;
 *   · no fabrica un correo que no exista para poder clasificarlo;
 *   · no deduce el remitente de un dominio parecido. Vincular pide coincidencia
 *     exacta de dominio con una Company, y si no la hay, no hay vínculo.
 */

const clean = (v) => String(v ?? '').trim();

/** Categorías del clasificador. Cerradas: una categoría nueva se documenta. */
export const INBOUND_CATEGORIES = Object.freeze([
  'solicitud_presupuesto',   // piden precio o visita
  'pregunta_servicio',       // preguntan qué se hace, horarios, cobertura
  'respuesta_negativa',      // no les interesa, o piden no ser contactados
  'baja_explicita',          // piden explícitamente dejar de recibir
  'administrativo',          // facturas, contratos, cosas de un cliente ya activo
  'no_relacionado',          // no tiene que ver con el negocio
]);

const REGLAS = [
  { categoria: 'baja_explicita', señales: [/\bunsubscribe\b/i, /\bremove me\b/i, /\bopt[- ]?out\b/i, /\bno me (?:escriban|contacten)\b/i, /\bdar de baja\b/i] },
  { categoria: 'respuesta_negativa', señales: [/\bnot interested\b/i, /\bno thanks\b/i, /\bwe (?:already )?have a (?:vendor|cleaner|service)\b/i, /\bno (?:nos )?interesa\b/i] },
  { categoria: 'solicitud_presupuesto', señales: [/\bquote\b/i, /\bestimate\b/i, /\bpricing\b/i, /\bhow much\b/i, /\bpresupuesto\b/i, /\bcotiza(?:r|ción)\b/i, /\bwalk[- ]?through\b/i, /\bsite visit\b/i] },
  { categoria: 'pregunta_servicio', señales: [/\bdo you (?:offer|clean|service)\b/i, /\bavailability\b/i, /\bschedule\b/i, /\bhorario\b/i, /\b(?:ofrecen|hacen|cubren)\b/i, /\bwhat (?:services|areas)\b/i] },
  { categoria: 'administrativo', señales: [/\binvoice\b/i, /\bw-?9\b/i, /\bcertificate of insurance\b/i, /\bfactura\b/i, /\bcontrato\b/i, /\bpurchase order\b/i] },
];

/**
 * Clasifica un mensaje a partir de SU METADATA, no de su cuerpo completo.
 *
 * `asunto` y `extracto` los aporta quien llama. El extracto es deliberadamente
 * corto: para decidir si alguien pide un presupuesto no hace falta —ni conviene—
 * arrastrar el correo entero por el código.
 */
export function classifyInbound({ asunto = '', extracto = '' } = {}) {
  const texto = `${clean(asunto)} \n ${clean(extracto)}`;
  if (!clean(texto)) {
    return { categoria: 'no_relacionado', confianza: 'baja', señalesEncontradas: [], why: 'sin asunto ni extracto' };
  }
  const encontradas = [];
  let categoria = 'no_relacionado';
  for (const regla of REGLAS) {
    const hit = regla.señales.find((re) => re.test(texto));
    if (hit) {
      // El orden de REGLAS es la prioridad: una baja explícita gana a todo lo
      // demás aunque el mismo correo pregunte un precio.
      categoria = regla.categoria;
      encontradas.push(String(hit));
      break;
    }
  }
  return {
    categoria,
    confianza: encontradas.length ? 'media' : 'baja',
    señalesEncontradas: encontradas,
    why: encontradas.length
      ? `coincidió una señal de ${categoria}`
      : 'ninguna señal conocida: se deja sin clasificar en vez de forzar una categoría',
  };
}

/**
 * Plantillas de borrador. Devuelven texto, nunca un envío.
 *
 * Las dos categorías que NO tienen plantilla son deliberadas: a una baja
 * explícita no se le responde con una plantilla —se respeta y se marca
 * `OPTED_OUT_DO_NOT_CONTACT`— y a un "no me interesa" tampoco se le insiste.
 */
export const DRAFT_TEMPLATES = Object.freeze({
  solicitud_presupuesto: {
    asunto: 'Sobre su consulta de limpieza comercial',
    cuerpo: [
      'Gracias por escribir. Para darle un presupuesto que no cambie después, necesito',
      'tres datos: metros cuadrados aproximados, frecuencia que busca y si hay zonas que',
      'requieran tratamiento específico (cocina, suelos tratados, zonas de alto tránsito).',
      '',
      'Con eso le envío un presupuesto por escrito. Si prefiere, paso a verlo sin coste.',
    ].join('\n'),
  },
  pregunta_servicio: {
    asunto: 'Sobre nuestros servicios de limpieza comercial',
    cuerpo: [
      'Gracias por su interés. Trabajamos limpieza comercial en el condado de San Diego:',
      'mantenimiento periódico, limpieza post-obra y servicios puntuales.',
      '',
      'Dígame qué tipo de local es y qué frecuencia necesita, y le concreto disponibilidad.',
    ].join('\n'),
  },
  administrativo: {
    asunto: 'Sobre su solicitud administrativa',
    cuerpo: [
      'Recibido. Lo paso a administración y le responden con la documentación que pide.',
    ].join('\n'),
  },
});

export const NO_DRAFT_CATEGORIES = Object.freeze({
  baja_explicita: 'una baja se respeta, no se contesta con una plantilla. Se marca OPTED_OUT_DO_NOT_CONTACT.',
  respuesta_negativa: 'un "no me interesa" no se rebate. Se registra y se deja en paz.',
  no_relacionado: 'sin categoría no hay plantilla: la revisa una persona.',
});

/**
 * Prepara un borrador SUGERIDO. El resultado es un artefacto interno: lleva
 * `sendable: false` y `channel: 'none'` porque no hay por dónde enviarlo, y eso
 * es una propiedad del objeto, no una promesa en un comentario.
 */
export function suggestDraft(categoria, { companyName = '' } = {}) {
  const plantilla = DRAFT_TEMPLATES[categoria];
  if (!plantilla) {
    return {
      sendable: false,
      channel: 'none',
      draft: null,
      why: NO_DRAFT_CATEGORIES[categoria] || `categoría "${categoria}" sin plantilla`,
    };
  }
  return {
    sendable: false,
    channel: 'none',
    draft: {
      asunto: plantilla.asunto,
      cuerpo: plantilla.cuerpo,
      para: null,                 // nunca una dirección: esto no se envía
      destinatarioSugerido: clean(companyName) || null,
    },
    why: 'borrador interno para que una persona lo revise, lo edite y lo envíe ella',
  };
}

export default { classifyInbound, suggestDraft, INBOUND_CATEGORIES, DRAFT_TEMPLATES };
