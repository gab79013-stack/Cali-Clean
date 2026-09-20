import { config } from '../../config.js';
import { SEGMENTS, segmentLabel, segmentPain, segmentPlural } from '../icp.js';

/**
 * Agente redactor.
 *
 * Convierte la señal concreta que encontramos sobre un negocio en tres frases
 * que justifican el correo. Con Claude disponible, escribe; sin él, compone la
 * misma estructura desde plantillas. En los dos casos el resultado pasa por la
 * misma validación: si el texto sale mal, se usa el determinista.
 */

const money = (n) => `$${Number(n || 0).toLocaleString('en-US')}`;

/** Ficha que se le da al modelo y que también alimenta la versión determinista. */
export function buildBrief(prospect, quote) {
  const signal = safeParse(prospect.signal_json, {});
  const locale = prospect.locale === 'es' ? 'es' : 'en';
  return {
    locale,
    businessName: prospect.business_name,
    contactName: prospect.contact_name || '',
    city: prospect.city || '',
    segment: prospect.segment,
    segmentLabel: segmentLabel(prospect.segment, locale),
    segmentPlural: segmentPlural(prospect.segment, locale),
    pain: segmentPain(prospect.segment, locale),
    signalType: signal.type || '',
    signalDetail: signal.type === 'permit_finaled'
      ? { finaledAt: signal.finaledAt, work: signal.work, valuation: signal.valuation }
      : { openedAt: signal.openedAt, naicsDescription: signal.naicsDescription },
    estimate: quote ? { price: quote.price, frequency: quote.frequency, annual: quote.annualValue } : null,
  };
}

// ── Versión determinista ─────────────────────────────────────
/** Aperturas por señal: lo que hace que el correo no parezca masivo. */
function deterministicOpener(brief) {
  const es = brief.locale === 'es';
  const { signalType, signalDetail, businessName, city } = brief;

  if (signalType === 'permit_finaled') {
    return es
      ? `Vi que se cerró el permiso de obra de ${businessName}${city ? ` en ${city}` : ''}. Justo después de la obra viene la parte que nadie quiere: el polvo fino que vuelve a aparecer tres días seguidos.`
      : `I saw the building permit for ${businessName}${city ? ` in ${city}` : ''} was finaled. Right after construction comes the part nobody wants: the fine dust that keeps coming back for three days straight.`;
  }
  if (signalType === 'new_business' && signalDetail?.openedAt) {
    return es
      ? `Vi que ${businessName} abrió hace poco${city ? ` en ${city}` : ''}. Felicidades, en serio. Cuando se abre, la limpieza suele ser lo último que se resuelve y lo primero que nota un cliente.`
      : `I saw ${businessName} opened recently${city ? ` in ${city}` : ''}. Congratulations, genuinely. When you open, cleaning is usually the last thing you sort out and the first thing a customer notices.`;
  }
  return es
    ? `Le escribo desde Cali Clean sobre la limpieza de ${businessName}.`
    : `I am reaching out from Cali Clean about cleaning at ${businessName}.`;
}

function deterministicCopy(brief) {
  const es = brief.locale === 'es';
  const price = brief.estimate ? money(brief.estimate.price) : null;

  return {
    subject: es
      ? `${brief.businessName}: limpieza profesional${price ? ` desde ${price}` : ''}`
      : `${brief.businessName}: professional cleaning${price ? ` from ${price}` : ''}`,
    opener: deterministicOpener(brief),
    value: es
      ? `Trabajamos con ${brief.segmentPlural} en California y sabemos que ${brief.pain}. Personal asegurado, checklist firmado en cada visita y sustitución garantizada si falta alguien.`
      : `We work with ${brief.segmentPlural} across California and we know ${brief.pain}. Insured crews, a signed checklist every visit, and guaranteed backup staffing.`,
    ask: es
      ? '¿Le sirve que pase alguien a ver el espacio esta semana y le deje un número cerrado? Sin compromiso.'
      : 'Would a walkthrough this week work, so we can leave you a firm number? No obligation.',
    author: 'template',
  };
}

// ── Versión con Claude ───────────────────────────────────────
const SYSTEM_PROMPT = `Eres el responsable comercial de Cali Clean, una empresa de limpieza profesional en California.

Escribes el PRIMER correo en frío a un negocio del que solo sabes lo que aparece en registros públicos y en su propia web.

Reglas que no se rompen:
- Escribe en el idioma indicado en el campo "locale" ("es" = español, "en" = inglés).
- Tono de persona real escribiendo a otra persona real. Nada de "esperamos que este correo le encuentre bien".
- La apertura debe usar el dato concreto que aparece en la ficha (la obra cerrada, la apertura reciente). Si el dato es débil, no lo infles: sé directo sobre por qué escribes.
- Nunca afirmes cosas que no están en la ficha: ni que visitaste el local, ni que os conocéis, ni número de empleados, ni problemas que no sabes que tienen.
- Nada de exageraciones ("el mejor de California"), ni urgencia falsa, ni descuentos que no te han dado.
- Frases cortas. Cero relleno corporativo.

Devuelve SOLO un objeto JSON con estas claves:
{
  "subject": "asunto de menos de 60 caracteres, sin mayúsculas gritadas ni emojis",
  "opener": "1-2 frases que conectan con el dato concreto",
  "value": "2-3 frases sobre por qué Cali Clean encaja con ESTE tipo de negocio",
  "ask": "1 frase pidiendo algo pequeño y fácil de aceptar"
}`;

/** Un texto del modelo solo se usa si cumple la forma esperada. */
export function validateCopy(copy, brief) {
  if (!copy || typeof copy !== 'object') return { ok: false, reason: 'not_an_object' };
  for (const key of ['subject', 'opener', 'value', 'ask']) {
    if (typeof copy[key] !== 'string' || !copy[key].trim()) return { ok: false, reason: `missing:${key}` };
  }
  if (copy.subject.length > 90) return { ok: false, reason: 'subject_too_long' };
  const body = `${copy.opener} ${copy.value} ${copy.ask}`;
  if (body.length > 1400) return { ok: false, reason: 'body_too_long' };
  // Placeholders sin rellenar: señal de que el modelo no entendió la ficha.
  if (/\{\{|\[\[|\bXXXX?\b|\[nombre\]|\[name\]/i.test(body + copy.subject)) {
    return { ok: false, reason: 'unfilled_placeholder' };
  }
  // El nombre del negocio debe aparecer: si no, el correo es genérico.
  const name = brief.businessName.split(/\s+/)[0];
  if (name && name.length > 3 && !`${copy.subject} ${body}`.toLowerCase().includes(name.toLowerCase())) {
    return { ok: false, reason: 'business_name_missing' };
  }
  return { ok: true };
}

async function claudeCopy(brief) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: config.ai.apiKey });

  const response = await client.messages.create({
    model: config.ai.model,
    max_tokens: 2000,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: config.ai.effort,
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            subject: { type: 'string' },
            opener: { type: 'string' },
            value: { type: 'string' },
            ask: { type: 'string' },
          },
          required: ['subject', 'opener', 'value', 'ask'],
          additionalProperties: false,
        },
      },
    },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `Ficha del prospecto:\n${JSON.stringify(brief, null, 2)}` }],
  });

  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text);
}

/**
 * Redacta el correo de un prospecto. Nunca lanza: si el modelo falla o devuelve
 * algo inservible, cae en la plantilla y lo deja anotado.
 */
export async function writeCopy(prospect, quote) {
  const brief = buildBrief(prospect, quote);
  const fallback = deterministicCopy(brief);

  if (!config.ai.enabled || !config.ai.apiKey) return fallback;

  try {
    const copy = await claudeCopy(brief);
    const check = validateCopy(copy, brief);
    if (!check.ok) return { ...fallback, author: `template(ai_rejected:${check.reason})` };
    return { ...copy, author: `ai:${config.ai.model}` };
  } catch (err) {
    return { ...fallback, author: `template(ai_error:${String(err.message).slice(0, 80)})` };
  }
}

const safeParse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };

export default writeCopy;
