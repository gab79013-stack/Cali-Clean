import { config, pricing } from '../config.js';
import { label, pickLocale } from './i18n.js';

const B = config.business;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (n) => `$${Number(n || 0).toLocaleString('en-US')}`;
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';

/** Layout común: HTML de email a prueba de clientes (tablas, estilos inline). */
function layout({ locale, preheader, heading, body, cta, ctaUrl, secondary, unsubscribeUrl, pixelUrl }) {
  const es = locale === 'es';
  return `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(heading)}</title></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:24px 12px;">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 4px rgba(16,24,40,.08);">
    <tr><td style="background:#0f766e;padding:22px 28px;">
      <a href="${esc(B.site)}" style="color:#ffffff;font-size:20px;font-weight:700;text-decoration:none;letter-spacing:-.3px;">${esc(B.name)}</a>
      <div style="color:#99f6e4;font-size:12px;margin-top:3px;">${es ? 'Limpieza profesional · California' : 'Professional cleaning · California'}</div>
    </td></tr>
    <tr><td style="padding:30px 28px 8px;">
      <h1 style="margin:0 0 14px;font-size:22px;line-height:1.3;color:#0f172a;">${heading}</h1>
      <div style="font-size:15px;line-height:1.62;color:#334155;">${body}</div>
    </td></tr>
    ${cta ? `<tr><td style="padding:12px 28px 6px;">
      <a href="${esc(ctaUrl)}" style="display:inline-block;background:#0f766e;color:#fff;text-decoration:none;padding:14px 26px;border-radius:9px;font-weight:600;font-size:15px;">${esc(cta)}</a>
    </td></tr>` : ''}
    ${secondary ? `<tr><td style="padding:6px 28px 20px;font-size:14px;color:#64748b;line-height:1.55;">${secondary}</td></tr>` : '<tr><td style="height:16px"></td></tr>'}
    <tr><td style="padding:18px 28px;border-top:1px solid #e2e8f0;background:#f8fafc;font-size:12px;color:#64748b;line-height:1.6;">
      <strong style="color:#334155;">${esc(B.name)}</strong><br>
      ${B.phone ? `${es ? 'Tel' : 'Phone'}: <a href="tel:${esc(B.phone.replace(/[^+\d]/g, ''))}" style="color:#0f766e;">${esc(B.phone)}</a> · ` : ''}
      <a href="mailto:${esc(B.email)}" style="color:#0f766e;">${esc(B.email)}</a><br>
      ${B.address ? `${esc(B.address)}<br>` : ''}
      ${unsubscribeUrl ? `<a href="${esc(unsubscribeUrl)}" style="color:#94a3b8;text-decoration:underline;">${es ? 'Darme de baja' : 'Unsubscribe'}</a>` : ''}
    </td></tr>
  </table>
</td></tr></table>
${pixelUrl ? `<img src="${esc(pixelUrl)}" width="1" height="1" alt="" style="display:block">` : ''}
</body></html>`;
}

const stripHtml = (html) => html
  .replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(p|div|tr|h1|h2|li)>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\n{3,}/g, '\n\n').trim();

/** Tabla de desglose del presupuesto usada en el email de cotización. */
function quoteTable(lead, quote, locale) {
  const es = locale === 'es';
  const rows = [
    [es ? 'Servicio' : 'Service', label(locale, 'serviceType', quote.serviceType)],
    [es ? 'Tamaño' : 'Size', quote.size],
    [es ? 'Frecuencia' : 'Frequency', label(locale, 'frequency', quote.frequency)],
    [es ? 'Duración estimada' : 'Estimated time', `${quote.estimatedHours} h`],
  ];
  if (quote.addons?.length) {
    rows.push([es ? 'Extras' : 'Add-ons', quote.addons.map((a) => label(locale, 'addons', a)).join(', ')]);
  }
  if (lead.preferred_date) rows.push([es ? 'Fecha deseada' : 'Preferred date', lead.preferred_date]);

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:11px;margin:18px 0;">
  <tr><td style="padding:18px 20px;background:#ecfdf5;border-radius:11px 11px 0 0;">
    <div style="font-size:12px;text-transform:uppercase;letter-spacing:.7px;color:#0f766e;font-weight:700;">${es ? 'Tu estimado' : 'Your estimate'}</div>
    <div style="font-size:32px;font-weight:800;color:#065f46;margin-top:5px;">${money(quote.low)} – ${money(quote.high)}</div>
    ${quote.discountLabel ? `<div style="font-size:13px;color:#047857;margin-top:5px;">${es ? `Incluye ${quote.discountLabel} de descuento por servicio recurrente` : `Includes ${quote.discountLabel} recurring-service discount`}</div>` : ''}
  </td></tr>
  ${rows.map(([k, v], i) => `<tr><td style="padding:11px 20px;${i ? 'border-top:1px solid #f1f5f9;' : ''}font-size:14px;color:#334155;">
    <span style="color:#64748b;">${esc(k)}:</span> <strong>${esc(v)}</strong></td></tr>`).join('')}
</table>`;
}

/**
 * Catálogo de plantillas. Cada una recibe { lead, quote, locale, links } y
 * devuelve { subject, html, text }.
 */
export const templates = {
  // ── 1. Cotización instantánea (se dispara al enviar el formulario) ──
  quote: (ctx) => {
    const { lead, quote, locale, links } = ctx;
    const es = locale === 'es';
    const fn = firstName(lead.name);
    const heading = es
      ? `${fn ? `${esc(fn)}, t` : 'T'}u presupuesto de limpieza está listo`
      : `${fn ? `${esc(fn)}, y` : 'Y'}our cleaning quote is ready`;
    const body = `
      <p style="margin:0 0 12px;">${es
        ? `Gracias por pedir tu presupuesto en <strong>${esc(B.name)}</strong>. Esto es lo que costaría el servicio que configuraste:`
        : `Thanks for requesting a quote from <strong>${esc(B.name)}</strong>. Here is what the service you configured would cost:`}</p>
      ${quoteTable(lead, quote, locale)}
      <p style="margin:0 0 12px;">${es
        ? 'El precio final se confirma al ver el espacio, pero rara vez se mueve de este rango. Si reservas ahora, mantenemos este precio durante 7 días.'
        : 'The final price is confirmed once we see the space, but it rarely moves outside this range. Book now and we hold this price for 7 days.'}</p>
      <ul style="margin:0 0 14px;padding-left:20px;color:#334155;">
        <li>${es ? 'Personal asegurado y con antecedentes verificados' : 'Insured, background-checked cleaners'}</li>
        <li>${es ? 'Productos seguros para niños y mascotas' : 'Kid- and pet-safe products'}</li>
        <li>${es ? 'Garantía de satisfacción: si algo no quedó bien, volvemos gratis' : 'Satisfaction guarantee: if something is off, we come back free'}</li>
      </ul>`;
    return {
      subject: es
        ? `Tu presupuesto: ${money(quote.low)}–${money(quote.high)} · ${esc(B.name)}`
        : `Your quote: ${money(quote.low)}–${money(quote.high)} · ${esc(B.name)}`,
      preheader: es ? 'Precio bloqueado 7 días. Reserva tu fecha.' : 'Price locked for 7 days. Pick your date.',
      heading, body,
      cta: es ? 'Reservar mi limpieza' : 'Book my cleaning',
      ctaUrl: links.booking,
      secondary: B.phone
        ? (es
          ? `¿Prefieres hablar? Llámanos al <a href="tel:${esc(B.phone.replace(/[^+\d]/g, ''))}" style="color:#0f766e;">${esc(B.phone)}</a> · ${esc(B.hours)}`
          : `Prefer to talk? Call us at <a href="tel:${esc(B.phone.replace(/[^+\d]/g, ''))}" style="color:#0f766e;">${esc(B.phone)}</a> · ${esc(B.hours)}`)
        : (es ? `Horario de atención: ${esc(B.hours)}` : `Business hours: ${esc(B.hours)}`),
    };
  },

  // ── 2. Aviso interno al equipo ──
  internal_new_lead: (ctx) => {
    const { lead, quote } = ctx;
    const flame = { hot: '🔥', warm: '🌤', cold: '❄️' }[lead.temperature] || '';
    const reasons = JSON.parse(lead.score_reasons || '[]');
    const body = `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:10px;margin-bottom:16px;">
        ${[
          ['Score', `${lead.score}/100 ${flame} (${lead.temperature})`],
          ['Nombre', lead.name || '—'],
          ['Email', lead.email],
          ['Teléfono', lead.phone || '— (sin teléfono)'],
          ['ZIP', `${lead.zip || '—'}${lead.in_service_area ? '' : ' ⚠️ FUERA DE ÁREA'}`],
          ['Segmento', lead.segment],
          ['Servicio', `${lead.service_type || '—'} · ${lead.frequency || '—'}`],
          ['Tamaño', quote?.size || '—'],
          ['Estimado', `${money(quote?.low)} – ${money(quote?.high)}`],
          ['Valor anual', money(quote?.annualValue)],
          ['Fecha deseada', lead.preferred_date || '—'],
          ['Origen', `${lead.source || 'web'} · ${lead.utm_source || 'directo'} / ${lead.utm_campaign || '—'}`],
          ['Página', lead.landing_page || '—'],
        ].map(([k, v], i) => `<tr><td style="padding:9px 16px;${i ? 'border-top:1px solid #f1f5f9;' : ''}font-size:14px;color:#334155;">
          <span style="color:#64748b;display:inline-block;min-width:115px;">${esc(k)}</span><strong>${esc(v)}</strong></td></tr>`).join('')}
      </table>
      ${lead.message ? `<p style="margin:0 0 14px;padding:12px 14px;background:#f8fafc;border-left:3px solid #0f766e;font-style:italic;">${esc(lead.message)}</p>` : ''}
      <p style="margin:0 0 6px;font-weight:600;color:#0f172a;">Por qué puntúa ${lead.score}:</p>
      <ul style="margin:0 0 14px;padding-left:20px;color:#475569;font-size:14px;">
        ${reasons.map((r) => `<li>${r.points > 0 ? '+' : ''}${r.points} · ${esc(r.reason)}</li>`).join('')}
      </ul>
      <p style="margin:0;color:#b45309;font-weight:600;">${lead.temperature === 'hot' ? '⏱ Llamar en menos de 5 minutos: es un lead caliente.' : 'Responder hoy mismo.'}</p>`;
    return {
      subject: `${flame} Lead ${lead.temperature.toUpperCase()} ${lead.score}/100 · ${lead.name || lead.email} · ${money(quote?.price)}`,
      preheader: `${lead.segment} · ${lead.frequency || 'one_time'} · ${money(quote?.annualValue)}/año`,
      heading: `Nuevo lead: ${esc(lead.name || lead.email)}`,
      body,
      cta: 'Abrir en el panel',
      ctaUrl: ctx.links.admin,
      secondary: `Responder directamente a <a href="mailto:${esc(lead.email)}" style="color:#0f766e;">${esc(lead.email)}</a>${lead.phone ? ` o llamar al <a href="tel:${esc(String(lead.phone).replace(/[^+\d]/g, ''))}" style="color:#0f766e;">${esc(lead.phone)}</a>` : ''}.`,
      noFooterUnsubscribe: true,
    };
  },

  // ── 3. Seguimiento a las 2 horas ──
  followup_2h: (ctx) => {
    const { lead, quote, locale, links } = ctx;
    const es = locale === 'es';
    const fn = firstName(lead.name);
    return {
      subject: es ? `¿Alguna duda con tu presupuesto, ${fn || 'hola'}?` : `Any questions about your quote${fn ? `, ${fn}` : ''}?`,
      preheader: es ? 'Respondemos en minutos.' : 'We answer in minutes.',
      heading: es ? '¿Te quedó alguna duda?' : 'Anything still unclear?',
      body: `<p style="margin:0 0 12px;">${es
        ? `Te envié tu estimado de <strong>${money(quote.low)}–${money(quote.high)}</strong> hace un rato. Si algo no te cuadró —el precio, la fecha, qué incluye— respóndeme a este correo y lo resolvemos.`
        : `I sent your <strong>${money(quote.low)}–${money(quote.high)}</strong> estimate a little while ago. If something didn't add up — price, date, what's included — just reply to this email and we'll sort it out.`}</p>
      <p style="margin:0 0 12px;">${es
        ? 'Las dos preguntas que más nos hacen:'
        : 'The two questions we get most:'}</p>
      <p style="margin:0 0 10px;"><strong>${es ? '¿Traen sus productos?' : 'Do you bring supplies?'}</strong><br>${es ? 'Sí, todo incluido, sin costo extra.' : 'Yes — everything included, no extra charge.'}</p>
      <p style="margin:0 0 14px;"><strong>${es ? '¿Tengo que estar en casa?' : 'Do I need to be home?'}</strong><br>${es ? 'No hace falta. Muchos clientes nos dejan acceso y encuentran todo limpio al volver.' : 'No. Many clients give us access and come back to a clean home.'}</p>`,
      cta: es ? 'Ver disponibilidad' : 'See availability',
      ctaUrl: links.booking,
    };
  },

  // ── 4. Día 1: prueba social ──
  followup_d1: (ctx) => {
    const { lead, quote, locale, links } = ctx;
    const es = locale === 'es';
    return {
      subject: es ? `Lo que dicen quienes ya nos contrataron` : `What our clients say (and your quote is still open)`,
      preheader: es ? `Tu estimado de ${money(quote.price)} sigue disponible.` : `Your ${money(quote.price)} estimate is still available.`,
      heading: es ? 'No nos creas a nosotros' : "Don't take our word for it",
      body: `
        <p style="margin:0 0 16px;">${es
          ? `${esc(firstName(lead.name)) || 'Hola'}, cuando alguien deja entrar a un equipo de limpieza en su casa o su negocio, la pregunta real no es el precio: es la confianza.`
          : `${esc(firstName(lead.name)) || 'Hi'}, when you let a cleaning team into your home or business, the real question isn't price — it's trust.`}</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
          <tr><td style="padding:14px 16px;background:#f8fafc;border-left:3px solid #0f766e;border-radius:0 8px 8px 0;font-style:italic;color:#334155;">
            ${es ? '"Llevo ocho meses con ellos cada dos semanas. Nunca han fallado una cita y la casa queda impecable."' : '"Eight months of biweekly service. They have never missed an appointment and the house is spotless every time."'}
            <div style="font-style:normal;font-size:13px;color:#64748b;margin-top:7px;">— ${es ? 'Cliente residencial, Los Ángeles' : 'Residential client, Los Angeles'}</div>
          </td></tr>
          <tr><td style="height:10px"></td></tr>
          <tr><td style="padding:14px 16px;background:#f8fafc;border-left:3px solid #0f766e;border-radius:0 8px 8px 0;font-style:italic;color:#334155;">
            ${es ? '"Limpian nuestra oficina de noche. En un año, cero incidencias y cero quejas del equipo."' : '"They clean our office at night. One year in: zero incidents, zero complaints from staff."'}
            <div style="font-style:normal;font-size:13px;color:#64748b;margin-top:7px;">— ${es ? 'Cliente comercial' : 'Commercial client'}</div>
          </td></tr>
        </table>
        <p style="margin:0 0 12px;">${es
          ? `Tu estimado de <strong>${money(quote.low)}–${money(quote.high)}</strong> sigue en pie. ¿Lo agendamos?`
          : `Your <strong>${money(quote.low)}–${money(quote.high)}</strong> estimate is still open. Shall we schedule it?`}</p>`,
      cta: es ? 'Elegir mi fecha' : 'Pick my date',
      ctaUrl: links.booking,
    };
  },

  // ── 5. Día 3: oferta con vencimiento ──
  followup_d3: (ctx) => {
    const { quote, locale, links } = ctx;
    const es = locale === 'es';
    const off = pricing.firstCleanDiscount;
    const discounted = Math.round(quote.price * (1 - off / 100) / 5) * 5;
    return {
      subject: es ? `${off}% en tu primera limpieza (48 horas)` : `${off}% off your first cleaning (48 hours)`,
      preheader: es ? `${money(quote.price)} → ${money(discounted)}` : `${money(quote.price)} → ${money(discounted)}`,
      heading: es ? `${off}% de descuento en tu primera limpieza` : `${off}% off your first cleaning`,
      body: `
        <p style="margin:0 0 14px;">${es
          ? 'Sabemos que probar un servicio nuevo cuesta. Así que te lo ponemos fácil:'
          : 'Trying a new service is a leap. So we are making the first step easy:'}</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
          <tr><td align="center" style="padding:22px;background:#ecfdf5;border-radius:11px;">
            <div style="font-size:15px;color:#64748b;text-decoration:line-through;">${money(quote.price)}</div>
            <div style="font-size:36px;font-weight:800;color:#065f46;margin:4px 0;">${money(discounted)}</div>
            <div style="font-size:13px;color:#047857;">${es ? 'primera limpieza · código' : 'first cleaning · code'} <strong>WELCOME${off}</strong></div>
          </td></tr>
        </table>
        <p style="margin:0 0 12px;">${es
          ? 'El código vence en 48 horas y solo aplica a la primera visita. Si después decides seguir con nosotros, el precio vuelve al estimado normal (y baja aún más si eliges servicio recurrente).'
          : 'The code expires in 48 hours and applies to your first visit only. If you continue with us afterwards the price returns to the normal estimate (and drops further with recurring service).'}</p>`,
      cta: es ? 'Usar mi descuento' : 'Claim my discount',
      ctaUrl: `${links.booking}${links.booking.includes('?') ? '&' : '?'}promo=WELCOME${off}`,
    };
  },

  // ── 6. Día 7: aporte de valor, sin venta dura ──
  followup_d7: (ctx) => {
    const { locale, links } = ctx;
    const es = locale === 'es';
    return {
      subject: es ? 'Las 7 zonas que casi nadie limpia (y deberían)' : 'The 7 spots almost nobody cleans (but should)',
      preheader: es ? 'Checklist rápido, tardas 10 minutos.' : 'Quick checklist, 10 minutes of work.',
      heading: es ? 'Las 7 zonas olvidadas de una casa limpia' : 'The 7 forgotten spots in a clean home',
      body: `
        <p style="margin:0 0 14px;">${es
          ? 'Sin venderte nada: esto es lo que revisamos primero cuando entramos a un espacio y lo que más se pasa por alto.'
          : 'No pitch today — this is what we check first when we walk into a space, and what gets missed most.'}</p>
        <ol style="margin:0 0 16px;padding-left:22px;color:#334155;line-height:1.85;">
          <li>${es ? 'Rejillas de ventilación del baño' : 'Bathroom exhaust vents'}</li>
          <li>${es ? 'Parte superior de puertas y marcos' : 'Tops of doors and frames'}</li>
          <li>${es ? 'Detrás y debajo del refrigerador' : 'Behind and under the fridge'}</li>
          <li>${es ? 'Rieles de ventanas corredizas' : 'Sliding window tracks'}</li>
          <li>${es ? 'Interruptores y manijas (lo más tocado de la casa)' : 'Switches and handles — the most touched surfaces'}</li>
          <li>${es ? 'Patas de sillas y muebles' : 'Chair and furniture legs'}</li>
          <li>${es ? 'Filtro del lavavajillas' : 'Dishwasher filter'}</li>
        </ol>
        <p style="margin:0 0 12px;">${es
          ? 'Si prefieres no hacerlo tú, tu presupuesto sigue guardado y lo respetamos.'
          : 'If you would rather not do it yourself, your quote is still saved and we will honor it.'}</p>`,
      cta: es ? 'Ver mi presupuesto' : 'See my quote',
      ctaUrl: links.booking,
    };
  },

  // ── 7. Día 14: cierre educado ──
  followup_d14: (ctx) => {
    const { locale, links } = ctx;
    const es = locale === 'es';
    return {
      subject: es ? '¿Cerramos tu solicitud?' : 'Should we close your request?',
      preheader: es ? 'Un clic y lo dejamos abierto.' : 'One click keeps it open.',
      heading: es ? 'Última nota, prometido' : 'Last note, promise',
      body: `<p style="margin:0 0 12px;">${es
        ? 'No quiero llenarte la bandeja de entrada. Si ya resolviste tu limpieza por otro lado, perfecto: no volveremos a escribirte.'
        : "I don't want to clutter your inbox. If you already sorted your cleaning elsewhere, no problem — we won't email again."}</p>
      <p style="margin:0 0 14px;">${es
        ? 'Si sigue pendiente, tu estimado y el descuento de bienvenida se reactivan con un clic en el botón.'
        : 'If it is still on your list, your estimate and welcome discount reactivate with one click below.'}</p>`,
      cta: es ? 'Sigo interesado' : "I'm still interested",
      ctaUrl: links.booking,
      secondary: es
        ? 'Si no respondes, dejamos de escribirte automáticamente. Gracias por tu tiempo.'
        : 'If you do nothing, we stop emailing automatically. Thanks for your time.',
    };
  },

  // ── 8. Comercial · día 1: propuesta ──
  commercial_d1: (ctx) => {
    const { lead, quote, locale, links } = ctx;
    const es = locale === 'es';
    return {
      subject: es
        ? `Propuesta de limpieza para su ${label(locale, 'serviceType', lead.service_type, 'negocio').toLowerCase()}`
        : `Cleaning proposal for your ${label(locale, 'serviceType', lead.service_type, 'business').toLowerCase()}`,
      preheader: es ? `${money(quote.price)} por visita · ${label(locale, 'frequency', quote.frequency)}` : `${money(quote.price)} per visit · ${label(locale, 'frequency', quote.frequency)}`,
      heading: es ? 'Los números de su contrato' : 'The numbers behind your contract',
      body: `
        <p style="margin:0 0 14px;">${es
          ? 'Esto es lo que implicaría tener el espacio cubierto todo el año:'
          : 'Here is what covering your space year-round would look like:'}</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:10px;margin-bottom:16px;">
          ${[
            [es ? 'Por visita' : 'Per visit', money(quote.price)],
            [es ? 'Frecuencia' : 'Frequency', label(locale, 'frequency', quote.frequency)],
            [es ? 'Inversión anual' : 'Annual investment', money(quote.annualValue)],
            [es ? 'Horas de equipo por visita' : 'Crew hours per visit', `${quote.estimatedHours} h`],
          ].map(([k, v], i) => `<tr><td style="padding:11px 18px;${i ? 'border-top:1px solid #f1f5f9;' : ''}font-size:14px;color:#334155;">
            <span style="color:#64748b;display:inline-block;min-width:150px;">${esc(k)}</span><strong>${esc(v)}</strong></td></tr>`).join('')}
        </table>
        <p style="margin:0 0 10px;">${es ? 'Incluido en todos los contratos comerciales:' : 'Included in every commercial contract:'}</p>
        <ul style="margin:0 0 14px;padding-left:20px;color:#334155;line-height:1.7;">
          <li>${es ? 'Seguro de responsabilidad civil y compensación laboral' : 'Liability insurance and workers comp'}</li>
          <li>${es ? 'Supervisor asignado y checklist firmado por visita' : 'Assigned supervisor and signed checklist per visit'}</li>
          <li>${es ? 'Sustitución garantizada si falta personal' : 'Guaranteed backup staffing'}</li>
          <li>${es ? 'Facturación mensual única' : 'Single monthly invoice'}</li>
        </ul>
        <p style="margin:0 0 12px;">${es
          ? 'Podemos hacer una visita al sitio sin costo esta semana y cerrar el número exacto.'
          : 'We can do a free walkthrough this week and lock the exact number.'}</p>`,
      cta: es ? 'Agendar visita al sitio' : 'Schedule a walkthrough',
      ctaUrl: links.booking,
    };
  },

  // ── 9. Comercial · día 4: comparativa / objeción de precio ──
  commercial_d4: (ctx) => {
    const { quote, locale, links } = ctx;
    const es = locale === 'es';
    return {
      subject: es ? 'Lo que cuesta un contrato de limpieza mal cerrado' : 'What a bad cleaning contract really costs',
      preheader: es ? 'Rotación, quejas, horas perdidas.' : 'Turnover, complaints, lost hours.',
      heading: es ? 'El precio no es el problema' : 'Price is not the problem',
      body: `
        <p style="margin:0 0 14px;">${es
          ? 'La mayoría de las empresas no cambia de proveedor de limpieza por precio, sino por lo mismo tres veces: faltan días, cambia el personal cada mes, nadie responde el teléfono.'
          : "Most companies don't switch cleaning vendors over price. They switch for the same three reasons: missed days, a new crew every month, nobody answering the phone."}</p>
        <p style="margin:0 0 14px;">${es
          ? `Nuestro contrato de <strong>${money(quote.price)}</strong> por visita incluye penalización por visita no cubierta: si no vamos, no se cobra y se compensa la siguiente. Es la parte del contrato que nadie más pone por escrito.`
          : `Our <strong>${money(quote.price)}</strong> per-visit contract includes a missed-visit clause: if we don't show, you don't pay, and the next visit is credited. That's the part nobody else puts in writing.`}</p>
        <p style="margin:0 0 12px;">${es ? '¿Le muestro referencias de negocios similares al suyo?' : 'Want references from businesses like yours?'}</p>`,
      cta: es ? 'Solicitar referencias' : 'Request references',
      ctaUrl: links.booking,
    };
  },

  // ── 10. Reactivación (día 45) ──
  reactivation: (ctx) => {
    const { quote, locale, links } = ctx;
    const es = locale === 'es';
    return {
      subject: es ? 'Tu presupuesto se venció (podemos renovarlo)' : 'Your quote expired — we can refresh it',
      preheader: es ? 'Precios actualizados, mismo servicio.' : 'Updated pricing, same service.',
      heading: es ? 'Ha pasado un mes' : 'It has been a month',
      body: `<p style="margin:0 0 14px;">${es
        ? `Tu estimado de ${money(quote.price)} caducó, pero la agenda de este mes todavía tiene huecos. Si sigues buscando, te preparo un presupuesto actualizado hoy mismo.`
        : `Your ${money(quote.price)} estimate expired, but this month's calendar still has openings. If you're still looking, I'll refresh your quote today.`}</p>`,
      cta: es ? 'Actualizar mi presupuesto' : 'Refresh my quote',
      ctaUrl: links.booking,
    };
  },

  // ── 11. Outbound · primer contacto en frío ──
  // El cuerpo lo escribe el agente redactor; la plantilla solo garantiza la
  // estructura, el aviso de procedencia y la baja.
  outbound_intro: (ctx) => {
    const { copy, locale, links } = ctx;
    const es = locale === 'es';
    return {
      subject: copy.subject,
      preheader: copy.ask.slice(0, 110),
      heading: copy.subject,
      body: `
        <p style="margin:0 0 14px;">${esc(copy.opener)}</p>
        <p style="margin:0 0 14px;">${esc(copy.value)}</p>
        <p style="margin:0 0 14px;"><strong>${esc(copy.ask)}</strong></p>`,
      cta: es ? 'Ver precios al instante' : 'See instant pricing',
      ctaUrl: links.booking,
      secondary: outboundDisclosure(locale),
    };
  },

  // ── 12. Outbound · seguimiento breve (día 4) ──
  outbound_bump: (ctx) => {
    const { copy, lead, locale, links } = ctx;
    const es = locale === 'es';
    const company = esc(lead?.company || '');
    return {
      subject: es ? `Re: ${copy.subject}` : `Re: ${copy.subject}`,
      preheader: es ? 'Una línea y lo dejo.' : 'One line and I am done.',
      heading: es ? '¿Lo dejo por aquí?' : 'Should I leave it here?',
      body: `
        <p style="margin:0 0 14px;">${es
          ? `Le escribí hace unos días sobre la limpieza de ${company}. Sé lo que es una bandeja llena, así que voy al grano:`
          : `I wrote a few days ago about cleaning at ${company}. I know what a full inbox looks like, so straight to it:`}</p>
        <p style="margin:0 0 14px;">${es
          ? 'Si le interesa un número, se lo doy hoy. Si no, respóndame "no" y no vuelvo a escribir.'
          : 'If you want a number, I can get you one today. If not, reply "no" and I will not write again.'}</p>`,
      cta: es ? 'Quiero el número' : 'Send me the number',
      ctaUrl: links.booking,
      secondary: outboundDisclosure(locale),
    };
  },

  // ── 13. Outbound · prueba concreta (día 9) ──
  outbound_proof: (ctx) => {
    const { quote, locale, links, lead } = ctx;
    const es = locale === 'es';
    return {
      subject: es ? 'Cómo cobramos (sin letra pequeña)' : 'How we price it (no fine print)',
      preheader: es ? `Desde ${money(quote?.price)} por visita.` : `From ${money(quote?.price)} per visit.`,
      heading: es ? 'Los números, sin rodeos' : 'The numbers, plainly',
      body: `
        <p style="margin:0 0 14px;">${es
          ? `Para un espacio como el de ${esc(lead?.company || 'su negocio')}, un servicio típico sale por <strong>${money(quote?.price)}</strong> por visita.`
          : `For a space like ${esc(lead?.company || 'yours')}, a typical service runs <strong>${money(quote?.price)}</strong> per visit.`}</p>
        <ul style="margin:0 0 14px;padding-left:20px;color:#334155;line-height:1.7;">
          <li>${es ? 'Sin contrato de permanencia' : 'No lock-in contract'}</li>
          <li>${es ? 'Si faltamos una visita, no se cobra y se compensa la siguiente' : 'Miss a visit and you do not pay — the next one is credited'}</li>
          <li>${es ? 'Seguro de responsabilidad civil y compensación laboral' : 'Liability insurance and workers comp'}</li>
        </ul>
        <p style="margin:0 0 14px;">${es
          ? 'Puede calcular su propio precio en 30 segundos, sin hablar con nadie:'
          : 'You can price it yourself in 30 seconds, without talking to anyone:'}</p>`,
      cta: es ? 'Calcular mi precio' : 'Price it myself',
      ctaUrl: links.booking,
      secondary: outboundDisclosure(locale),
    };
  },

  // ── 14. Outbound · cierre (día 16) ──
  outbound_close: (ctx) => {
    const { locale, links } = ctx;
    const es = locale === 'es';
    return {
      subject: es ? 'Cierro su ficha' : 'Closing your file',
      preheader: es ? 'Sin respuesta, sin más correos.' : 'No reply, no more email.',
      heading: es ? 'Último correo, de verdad' : 'Last email, for real',
      body: `<p style="margin:0 0 14px;">${es
        ? 'No he sabido nada, así que cierro su ficha y dejo de escribir. Si en algún momento necesita limpieza, aquí estamos y el precio se calcula solo desde el enlace.'
        : 'I have not heard back, so I am closing your file and will stop writing. If you ever need cleaning, we are here and the price calculates itself from the link.'}</p>`,
      cta: es ? 'Guardar el enlace' : 'Keep the link',
      ctaUrl: links.booking,
      secondary: outboundDisclosure(locale),
    };
  },
};

const isUsableCopy = (copy) =>
  Boolean(copy && ['subject', 'opener', 'value', 'ask'].every((k) => typeof copy[k] === 'string' && copy[k].trim()));

/** Aviso de procedencia: por qué recibe este correo alguien que no lo pidió. */
function outboundDisclosure(locale) {
  const text = locale === 'es' ? config.outbound.disclosureEs : config.outbound.disclosureEn;
  return `<span style="font-size:12.5px;color:#94a3b8;">${esc(text)}</span>`;
}

/** Renderiza una plantilla al HTML y texto plano definitivos. */
export function renderTemplate(name, ctx) {
  const fn = templates[name];
  if (!fn) throw new Error(`Plantilla desconocida: ${name}`);
  // Un correo en frío sin el texto del agente redactor sería un correo genérico
  // a alguien que no pidió nada. Antes que eso, no se envía.
  if (name.startsWith('outbound_') && !isUsableCopy(ctx.copy)) {
    throw new Error(`La plantilla ${name} necesita el texto redactado del prospecto`);
  }
  const locale = pickLocale(ctx.locale || ctx.lead?.locale);
  const parts = fn({ ...ctx, locale });
  const html = layout({
    locale,
    preheader: parts.preheader || '',
    heading: parts.heading,
    body: parts.body,
    cta: parts.cta,
    ctaUrl: parts.ctaUrl,
    secondary: parts.secondary,
    unsubscribeUrl: parts.noFooterUnsubscribe ? null : ctx.links?.unsubscribe,
    pixelUrl: parts.noFooterUnsubscribe ? null : ctx.links?.pixel,
  });
  return { subject: parts.subject, html, text: stripHtml(html) };
}

export default renderTemplate;
