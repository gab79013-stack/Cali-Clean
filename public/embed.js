/**
 * Cali Clean · widget de presupuesto instantáneo
 *
 * Uso en cualquier web (WordPress, Wix, HTML plano):
 *   <div id="cali-quote"></div>
 *   <script src="https://leads.cali-clean.net/embed.js" data-target="#cali-quote" async></script>
 *
 * Sin dependencias y dentro de un Shadow DOM: los estilos del sitio no pueden
 * romper el widget y el widget no puede romper el sitio.
 */
(function () {
  'use strict';
  var script = document.currentScript || (function () {
    var s = document.getElementsByTagName('script');
    return s[s.length - 1];
  })();
  var API = (script.getAttribute('data-api') || script.src.replace(/\/embed\.js.*$/, '')).replace(/\/$/, '');
  var TARGET = script.getAttribute('data-target') || '#cali-quote';
  var MODE = script.getAttribute('data-mode') || 'inline'; // inline | button
  var FORCE_LOCALE = script.getAttribute('data-locale') || '';

  var LOCALE = (FORCE_LOCALE || (navigator.language || 'en')).toLowerCase().indexOf('es') === 0 ? 'es' : 'en';
  var startedAt = Date.now();
  var state = { segment: 'residential', serviceType: 'standard', frequency: 'one_time',
                bedrooms: 2, bathrooms: 2, sqft: 2000, addons: [], step: 0 };
  var quote = null, cfg = null, root = null, busy = false;

  var T = {
    en: {
      title: 'Get your instant price', sub: 'No phone call. No waiting. 30 seconds.',
      q_segment: 'What needs cleaning?', home: 'My home', business: 'My business',
      q_service: 'What kind of cleaning?', q_size: 'How big is the space?',
      q_freq: 'How often?', q_addons: 'Any extras?', addons_skip: 'None, continue',
      bedrooms: 'Bedrooms', bathrooms: 'Bathrooms', sqft: 'Square feet',
      your_price: 'Your estimated price', per_visit: 'per visit', save: 'save',
      hours: 'hours of work', lock: 'Lock this price', back: 'Back', next: 'Continue',
      name: 'Full name', email: 'Email', phone: 'Phone', zip: 'ZIP code',
      date: 'Preferred date (optional)', notes: 'Anything we should know? (optional)',
      submit: 'Email me this quote', sending: 'Sending…',
      privacy: 'We email your quote and follow up once or twice. Unsubscribe anytime.',
      thanks_title: 'Check your inbox', thanks_sub: 'Your quote is on its way. We hold this price for 7 days.',
      call: 'Or call us now:', err_email: 'Please enter a valid email address.',
      err_generic: 'Something went wrong. Please try again or call us.',
      open: 'Get a free quote', required: 'Required',
    },
    es: {
      title: 'Tu precio al instante', sub: 'Sin llamadas. Sin esperas. 30 segundos.',
      q_segment: '¿Qué hay que limpiar?', home: 'Mi casa', business: 'Mi negocio',
      q_service: '¿Qué tipo de limpieza?', q_size: '¿De qué tamaño es el espacio?',
      q_freq: '¿Cada cuánto?', q_addons: '¿Algún extra?', addons_skip: 'Ninguno, continuar',
      bedrooms: 'Recámaras', bathrooms: 'Baños', sqft: 'Pies cuadrados',
      your_price: 'Tu precio estimado', per_visit: 'por visita', save: 'ahorras',
      hours: 'horas de trabajo', lock: 'Bloquear este precio', back: 'Atrás', next: 'Continuar',
      name: 'Nombre completo', email: 'Correo', phone: 'Teléfono', zip: 'Código postal',
      date: 'Fecha deseada (opcional)', notes: '¿Algo que debamos saber? (opcional)',
      submit: 'Enviarme el presupuesto', sending: 'Enviando…',
      privacy: 'Te enviamos tu presupuesto y un par de seguimientos. Puedes darte de baja cuando quieras.',
      thanks_title: 'Revisa tu correo', thanks_sub: 'Tu presupuesto va en camino. Mantenemos este precio 7 días.',
      call: 'O llámanos ahora:', err_email: 'Escribe un correo válido.',
      err_generic: 'Algo falló. Inténtalo de nuevo o llámanos.',
      open: 'Presupuesto gratis', required: 'Obligatorio',
    }
  }[LOCALE];

  var LABELS = {
    en: {
      standard: ['Standard', 'Regular upkeep'], deep: ['Deep clean', 'Top to bottom'],
      move: ['Move in / out', 'Empty property'], post_construction: ['Post-construction', 'After remodeling'],
      office: ['Office', 'Desks, common areas'], retail: ['Retail', 'Storefront'],
      medical: ['Medical', 'Clinic, dental'], restaurant: ['Restaurant', 'Kitchen, dining'],
      one_time: ['One time', null], weekly: ['Weekly', null], biweekly: ['Every 2 weeks', null],
      monthly: ['Monthly', null], daily: ['Daily', null],
      fridge: 'Inside fridge', oven: 'Inside oven', windows_interior: 'Interior windows',
      laundry: 'Laundry', garage: 'Garage', cabinets: 'Inside cabinets', patio: 'Patio / balcony',
      windows_exterior: 'Exterior windows', carpet_shampoo: 'Carpet shampoo',
      floor_wax: 'Floor wax', disinfection: 'Disinfection',
    },
    es: {
      standard: ['Estándar', 'Mantenimiento regular'], deep: ['Profunda', 'De arriba a abajo'],
      move: ['Mudanza', 'Propiedad vacía'], post_construction: ['Post-obra', 'Tras remodelación'],
      office: ['Oficina', 'Escritorios, áreas comunes'], retail: ['Local', 'Tienda'],
      medical: ['Clínica', 'Consultorio, dental'], restaurant: ['Restaurante', 'Cocina, comedor'],
      one_time: ['Una vez', null], weekly: ['Semanal', null], biweekly: ['Cada 2 semanas', null],
      monthly: ['Mensual', null], daily: ['Diaria', null],
      fridge: 'Refrigerador por dentro', oven: 'Horno por dentro', windows_interior: 'Ventanas por dentro',
      laundry: 'Lavandería', garage: 'Garaje', cabinets: 'Gabinetes por dentro', patio: 'Patio / balcón',
      windows_exterior: 'Ventanas por fuera', carpet_shampoo: 'Lavado de alfombras',
      floor_wax: 'Encerado de pisos', disinfection: 'Desinfección',
    }
  }[LOCALE];
  var lbl = function (key, i) { var v = LABELS[key]; return Array.isArray(v) ? v[i || 0] : (i ? null : v || key); };

  var CSS = '\
:host{all:initial;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}\
*,*::before,*::after{box-sizing:border-box;}\
.cc{background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(15,23,42,.10);max-width:520px;width:100%;overflow:hidden;color:#0f172a;}\
.hd{background:linear-gradient(135deg,#0f766e,#0d9488);color:#fff;padding:20px 24px;}\
.hd h2{margin:0;font-size:19px;font-weight:700;letter-spacing:-.2px;}\
.hd p{margin:4px 0 0;font-size:13px;opacity:.9;}\
.bar{height:4px;background:rgba(255,255,255,.25);border-radius:3px;margin-top:14px;overflow:hidden;}\
.bar i{display:block;height:100%;background:#fff;transition:width .3s ease;}\
.bd{padding:22px 24px 24px;}\
.q{font-size:16px;font-weight:600;margin:0 0 14px;}\
.opts{display:grid;gap:9px;}\
.opts.two{grid-template-columns:1fr 1fr;}\
.opt{display:flex;flex-direction:column;gap:2px;text-align:left;border:1.5px solid #e2e8f0;background:#fff;border-radius:11px;padding:13px 15px;cursor:pointer;font-size:14.5px;font-weight:600;color:#0f172a;transition:all .15s;width:100%;}\
.opt:hover{border-color:#0f766e;background:#f0fdfa;}\
.opt.sel{border-color:#0f766e;background:#f0fdfa;box-shadow:0 0 0 3px rgba(15,118,110,.10);}\
.opt small{font-weight:400;color:#64748b;font-size:12.5px;}\
.opt .tag{position:absolute;}\
.pill{display:inline-block;background:#fef3c7;color:#92400e;font-size:11px;font-weight:700;padding:2px 7px;border-radius:20px;margin-left:7px;}\
.steppers{display:grid;gap:14px;}\
.stp{display:flex;align-items:center;justify-content:space-between;border:1.5px solid #e2e8f0;border-radius:11px;padding:11px 14px;}\
.stp span{font-size:14.5px;font-weight:500;}\
.ctr{display:flex;align-items:center;gap:12px;}\
.ctr button{width:32px;height:32px;border-radius:8px;border:1.5px solid #cbd5e1;background:#fff;font-size:18px;line-height:1;cursor:pointer;color:#0f766e;font-weight:700;}\
.ctr button:hover{border-color:#0f766e;background:#f0fdfa;}\
.ctr b{min-width:26px;text-align:center;font-size:16px;}\
.rng{width:100%;margin:8px 0 0;accent-color:#0f766e;}\
.chips{display:flex;flex-wrap:wrap;gap:8px;}\
.chip{border:1.5px solid #e2e8f0;background:#fff;border-radius:20px;padding:8px 14px;font-size:13.5px;cursor:pointer;color:#334155;}\
.chip.sel{border-color:#0f766e;background:#0f766e;color:#fff;}\
.price{background:#ecfdf5;border-radius:13px;padding:20px;text-align:center;margin-bottom:16px;}\
.price .lb{font-size:12px;text-transform:uppercase;letter-spacing:.7px;color:#0f766e;font-weight:700;}\
.price .amt{font-size:34px;font-weight:800;color:#065f46;margin:5px 0 2px;letter-spacing:-1px;}\
.price .mt{font-size:13px;color:#047857;}\
.f{display:grid;gap:11px;margin-bottom:6px;}\
.f.two{grid-template-columns:1fr 1fr;}\
input,textarea{width:100%;border:1.5px solid #e2e8f0;border-radius:10px;padding:12px 13px;font-size:15px;font-family:inherit;color:#0f172a;background:#fff;}\
input:focus,textarea:focus{outline:none;border-color:#0f766e;box-shadow:0 0 0 3px rgba(15,118,110,.10);}\
textarea{resize:vertical;min-height:70px;}\
.hp{position:absolute!important;left:-9999px!important;width:1px!important;height:1px!important;opacity:0!important;}\
.btn{display:block;width:100%;background:#0f766e;color:#fff;border:none;border-radius:11px;padding:15px;font-size:16px;font-weight:700;cursor:pointer;font-family:inherit;margin-top:6px;}\
.btn:hover{background:#0d5f58;}\
.btn:disabled{opacity:.6;cursor:not-allowed;}\
.nav{display:flex;gap:10px;margin-top:16px;align-items:center;}\
.back{background:none;border:none;color:#64748b;font-size:14px;cursor:pointer;padding:8px 4px;font-family:inherit;}\
.back:hover{color:#0f766e;}\
.err{background:#fef2f2;color:#b91c1c;border-radius:9px;padding:10px 13px;font-size:13.5px;margin-bottom:11px;}\
.pv{font-size:12px;color:#94a3b8;text-align:center;margin-top:11px;line-height:1.5;}\
.ok{text-align:center;padding:14px 0 6px;}\
.ok .ic{font-size:44px;line-height:1;}\
.ok h3{margin:12px 0 7px;font-size:21px;}\
.ok p{margin:0 0 18px;color:#475569;font-size:14.5px;line-height:1.6;}\
.ok .gobtn{display:inline-block;background:#0f766e;color:#fff;text-decoration:none;padding:13px 24px;border-radius:10px;font-weight:600;}\
.ok .tel{color:#0f766e;font-weight:600;text-decoration:none;}\
.fab{position:fixed;right:20px;bottom:20px;z-index:2147483000;background:#0f766e;color:#fff;border:none;border-radius:30px;padding:15px 24px;font-size:15px;font-weight:700;cursor:pointer;box-shadow:0 6px 20px rgba(15,118,110,.4);font-family:inherit;}\
.ov{position:fixed;inset:0;background:rgba(15,23,42,.6);z-index:2147483001;display:flex;align-items:center;justify-content:center;padding:16px;overflow:auto;}\
.cl{position:absolute;top:12px;right:14px;background:rgba(255,255,255,.2);border:none;color:#fff;width:30px;height:30px;border-radius:50%;font-size:17px;cursor:pointer;line-height:1;}\
@media(max-width:480px){.opts.two{grid-template-columns:1fr;}.f.two{grid-template-columns:1fr;}.bd{padding:18px 16px 20px;}}';

  // ── utilidades ──────────────────────────────────────────────
  function el(tag, attrs, html) {
    var n = document.createElement(tag);
    for (var k in attrs || {}) if (k === 'class') n.className = attrs[k]; else n.setAttribute(k, attrs[k]);
    if (html != null) n.innerHTML = html;
    return n;
  }
  function money(n) { return '$' + Number(n || 0).toLocaleString('en-US'); }
  function utm() {
    var p = new URLSearchParams(location.search), o = {};
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid']
      .forEach(function (k) { if (p.get(k)) o[k] = p.get(k); });
    try {
      var stored = JSON.parse(sessionStorage.getItem('cc_utm') || '{}');
      if (Object.keys(o).length) sessionStorage.setItem('cc_utm', JSON.stringify(o));
      else o = stored;
    } catch (e) { /* sessionStorage bloqueado */ }
    o.landing_page = location.href.slice(0, 380);
    o.referrer = document.referrer.slice(0, 380);
    return o;
  }
  function post(path, body) {
    return fetch(API + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); });
  }

  function refreshQuote() {
    return post('/api/quote', payload()).then(function (r) {
      quote = r.body.quote;
      return quote;
    }).catch(function () { return null; });
  }
  function payload() {
    return {
      segment: state.segment, serviceType: state.serviceType, frequency: state.frequency,
      bedrooms: state.bedrooms, bathrooms: state.bathrooms, sqft: state.sqft, addons: state.addons,
    };
  }

  // ── pasos del wizard ────────────────────────────────────────
  var STEPS = ['segment', 'service', 'size', 'frequency', 'addons', 'contact'];

  function render() {
    var bd = root.querySelector('.bd');
    var name = STEPS[state.step];
    bd.innerHTML = '';
    root.querySelector('.bar i').style.width = ((state.step / (STEPS.length - 1)) * 100) + '%';
    ({ segment: stepSegment, service: stepService, size: stepSize, frequency: stepFrequency,
       addons: stepAddons, contact: stepContact })[name](bd);
    if (state.step > 0 && name !== 'done') {
      var nav = el('div', { class: 'nav' });
      var back = el('button', { class: 'back', type: 'button' }, '← ' + T.back);
      back.onclick = function () { state.step--; render(); };
      nav.appendChild(back);
      bd.appendChild(nav);
    }
  }
  function advance() { state.step++; render(); }

  function optionList(container, items, selectedKey, onPick, twoCols) {
    var wrap = el('div', { class: 'opts' + (twoCols ? ' two' : '') });
    items.forEach(function (it) {
      var b = el('button', { class: 'opt' + (it.key === selectedKey ? ' sel' : ''), type: 'button' },
        it.title + (it.badge ? '<span class="pill">' + it.badge + '</span>' : '') +
        (it.sub ? '<small>' + it.sub + '</small>' : ''));
      b.onclick = function () { onPick(it.key); };
      wrap.appendChild(b);
    });
    container.appendChild(wrap);
  }

  function stepSegment(bd) {
    bd.appendChild(el('p', { class: 'q' }, T.q_segment));
    optionList(bd, [
      { key: 'residential', title: '🏠 ' + T.home, sub: LOCALE === 'es' ? 'Casa, apartamento, Airbnb' : 'House, apartment, Airbnb' },
      { key: 'commercial', title: '🏢 ' + T.business, sub: LOCALE === 'es' ? 'Oficina, local, clínica' : 'Office, retail, clinic' },
    ], state.segment, function (k) {
      state.segment = k;
      state.serviceType = k === 'commercial' ? 'office' : 'standard';
      state.frequency = k === 'commercial' ? 'weekly' : 'one_time';
      advance();
    }, true);
  }

  function stepService(bd) {
    bd.appendChild(el('p', { class: 'q' }, T.q_service));
    var types = cfg.pricing[state.segment].types;
    optionList(bd, types.map(function (k) {
      return { key: k, title: lbl(k, 0) || k, sub: lbl(k, 1) };
    }), state.serviceType, function (k) { state.serviceType = k; advance(); });
  }

  function stepSize(bd) {
    bd.appendChild(el('p', { class: 'q' }, T.q_size));
    if (state.segment === 'commercial') {
      var box = el('div', { class: 'stp' });
      box.style.display = 'block';
      box.innerHTML = '<span>' + T.sqft + ': <b style="color:#0f766e">' + state.sqft.toLocaleString('en-US') + '</b></span>';
      var rng = el('input', { type: 'range', class: 'rng', min: '500', max: '30000', step: '500', value: String(state.sqft) });
      rng.oninput = function () {
        state.sqft = Number(rng.value);
        box.querySelector('b').textContent = state.sqft.toLocaleString('en-US');
      };
      box.appendChild(rng);
      bd.appendChild(box);
    } else {
      var grid = el('div', { class: 'steppers' });
      [['bedrooms', T.bedrooms, 0, 10], ['bathrooms', T.bathrooms, 1, 8]].forEach(function (cfgRow) {
        var key = cfgRow[0], row = el('div', { class: 'stp' });
        row.innerHTML = '<span>' + cfgRow[1] + '</span>';
        var ctr = el('div', { class: 'ctr' });
        var minus = el('button', { type: 'button' }, '−');
        var val = el('b', null, String(state[key]));
        var plus = el('button', { type: 'button' }, '+');
        minus.onclick = function () { if (state[key] > cfgRow[2]) { state[key]--; val.textContent = state[key]; } };
        plus.onclick = function () { if (state[key] < cfgRow[3]) { state[key]++; val.textContent = state[key]; } };
        ctr.appendChild(minus); ctr.appendChild(val); ctr.appendChild(plus);
        row.appendChild(ctr); grid.appendChild(row);
      });
      bd.appendChild(grid);
    }
    var next = el('button', { class: 'btn', type: 'button' }, T.next);
    next.onclick = advance;
    bd.appendChild(next);
  }

  function stepFrequency(bd) {
    bd.appendChild(el('p', { class: 'q' }, T.q_freq));
    var freqs = cfg.pricing[state.segment].frequency;
    optionList(bd, Object.keys(freqs).map(function (k) {
      return { key: k, title: lbl(k, 0) || k, badge: freqs[k] ? '−' + freqs[k] : null };
    }), state.frequency, function (k) { state.frequency = k; advance(); });
  }

  function stepAddons(bd) {
    bd.appendChild(el('p', { class: 'q' }, T.q_addons));
    var catalog = cfg.pricing[state.segment].addons;
    var chips = el('div', { class: 'chips' });
    Object.keys(catalog).forEach(function (k) {
      var on = state.addons.indexOf(k) > -1;
      var c = el('button', { class: 'chip' + (on ? ' sel' : ''), type: 'button' },
        (lbl(k) || k) + ' +' + money(catalog[k]));
      c.onclick = function () {
        var i = state.addons.indexOf(k);
        if (i > -1) state.addons.splice(i, 1); else state.addons.push(k);
        c.className = 'chip' + (state.addons.indexOf(k) > -1 ? ' sel' : '');
      };
      chips.appendChild(c);
    });
    bd.appendChild(chips);
    var next = el('button', { class: 'btn', type: 'button' }, T.lock + ' →');
    next.onclick = function () {
      next.disabled = true;
      refreshQuote().then(advance);
    };
    bd.appendChild(next);
  }

  function stepContact(bd) {
    // El precio se muestra ANTES de pedir datos: es lo que hace que los dejen.
    var p = el('div', { class: 'price' });
    p.innerHTML = '<div class="lb">' + T.your_price + '</div>' +
      '<div class="amt">' + money(quote.low) + ' – ' + money(quote.high) + '</div>' +
      '<div class="mt">' + (quote.recurring ? T.per_visit + ' · ' : '') +
      '≈' + quote.estimatedHours + ' ' + T.hours +
      (quote.discountLabel ? ' · ' + T.save + ' ' + quote.discountLabel : '') + '</div>';
    bd.appendChild(p);

    var errBox = el('div', { class: 'err' }, '');
    errBox.style.display = 'none';
    bd.appendChild(errBox);

    var form = el('form', { novalidate: 'novalidate' });
    var two = el('div', { class: 'f two' });
    var iName = el('input', { type: 'text', name: 'name', placeholder: T.name, autocomplete: 'name' });
    var iPhone = el('input', { type: 'tel', name: 'phone', placeholder: T.phone, autocomplete: 'tel' });
    two.appendChild(iName); two.appendChild(iPhone);

    var one = el('div', { class: 'f' });
    var iEmail = el('input', { type: 'email', name: 'email', placeholder: T.email + ' *', autocomplete: 'email', required: 'required' });
    one.appendChild(iEmail);

    var two2 = el('div', { class: 'f two' });
    var iZip = el('input', { type: 'text', name: 'zip', placeholder: T.zip, inputmode: 'numeric', maxlength: '5', autocomplete: 'postal-code' });
    var iDate = el('input', { type: 'date', name: 'preferred_date', min: new Date().toISOString().slice(0, 10) });
    two2.appendChild(iZip); two2.appendChild(iDate);

    var one2 = el('div', { class: 'f' });
    var iMsg = el('textarea', { name: 'message', placeholder: T.notes });
    one2.appendChild(iMsg);

    // Honeypot: invisible para personas, irresistible para bots.
    var hp = el('input', { type: 'text', name: 'company_website', class: 'hp', tabindex: '-1', autocomplete: 'off' });

    var submit = el('button', { class: 'btn', type: 'submit' }, T.submit);
    [two, one, two2, one2, hp, submit].forEach(function (n) { form.appendChild(n); });
    form.appendChild(el('p', { class: 'pv' }, T.privacy));

    form.onsubmit = function (ev) {
      ev.preventDefault();
      if (busy) return;
      errBox.style.display = 'none';
      if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(iEmail.value.trim())) {
        errBox.textContent = T.err_email; errBox.style.display = 'block'; iEmail.focus();
        return;
      }
      busy = true; submit.disabled = true; submit.textContent = T.sending;

      var data = payload();
      data.name = iName.value; data.email = iEmail.value; data.phone = iPhone.value;
      data.zip = iZip.value; data.preferred_date = iDate.value; data.message = iMsg.value;
      data.company_website = hp.value; data.locale = LOCALE;
      data.form_time_ms = Date.now() - startedAt; data.source = MODE === 'button' ? 'widget_popup' : 'widget';
      var extra = utm();
      for (var k in extra) data[k] = extra[k];

      post('/api/leads', data).then(function (res) {
        busy = false;
        if (res.status >= 400) {
          submit.disabled = false; submit.textContent = T.submit;
          errBox.textContent = res.body && res.body.error === 'invalid_email' ? T.err_email : T.err_generic;
          errBox.style.display = 'block';
          return;
        }
        done(res.body);
      }).catch(function () {
        busy = false; submit.disabled = false; submit.textContent = T.submit;
        errBox.textContent = T.err_generic; errBox.style.display = 'block';
      });
    };
    bd.appendChild(form);
  }

  function done(res) {
    var bd = root.querySelector('.bd');
    root.querySelector('.bar i').style.width = '100%';
    bd.innerHTML = '';
    var ok = el('div', { class: 'ok' });
    ok.innerHTML = '<div class="ic">✅</div><h3>' + T.thanks_title + '</h3><p>' + T.thanks_sub + '</p>';
    var booking = res.bookingUrl || (cfg.business && cfg.business.bookingUrl);
    if (booking) {
      ok.appendChild(el('a', { href: booking, class: 'gobtn' }, LOCALE === 'es' ? 'Agendar ahora' : 'Book now'));
    }
    if (cfg.business.phone) {
      ok.appendChild(el('p', { class: 'pv' }, T.call + ' <a class="tel" href="tel:' +
        cfg.business.phone.replace(/[^+\d]/g, '') + '">' + cfg.business.phone + '</a>'));
    }
    bd.appendChild(ok);
    // Evento para Google Analytics / Meta Pixel si están presentes en la página.
    try {
      if (window.dataLayer) window.dataLayer.push({ event: 'generate_lead', value: res.quote && res.quote.price, currency: 'USD' });
      if (window.gtag) window.gtag('event', 'generate_lead', { value: res.quote && res.quote.price, currency: 'USD' });
      if (window.fbq) window.fbq('track', 'Lead', { value: res.quote && res.quote.price, currency: 'USD' });
    } catch (e) { /* analytics ausente */ }
  }

  // ── montaje ─────────────────────────────────────────────────
  function build() {
    var host = el('div');
    var shadow = host.attachShadow({ mode: 'open' });
    shadow.appendChild(el('style', null, CSS));
    var card = el('div', { class: 'cc' });
    card.innerHTML = '<div class="hd"><h2>' + T.title + '</h2><p>' + T.sub + '</p>' +
      '<div class="bar"><i style="width:0"></i></div></div><div class="bd"></div>';
    shadow.appendChild(card);
    root = shadow;
    return host;
  }

  function mountInline() {
    var target = document.querySelector(TARGET);
    if (!target) {
      target = el('div');
      script.parentNode.insertBefore(target, script);
    }
    target.appendChild(build());
    render();
  }

  function mountButton() {
    var fabHost = el('div');
    var fs = fabHost.attachShadow({ mode: 'open' });
    fs.appendChild(el('style', null, CSS));
    var fab = el('button', { class: 'fab', type: 'button' }, '✨ ' + T.open);
    fs.appendChild(fab);
    document.body.appendChild(fabHost);

    fab.onclick = function () {
      var ovHost = el('div');
      var os = ovHost.attachShadow({ mode: 'open' });
      os.appendChild(el('style', null, CSS));
      var ov = el('div', { class: 'ov' });
      var card = el('div', { class: 'cc' });
      card.style.position = 'relative';
      card.innerHTML = '<div class="hd"><button class="cl" type="button">×</button><h2>' + T.title + '</h2><p>' + T.sub +
        '</p><div class="bar"><i style="width:0"></i></div></div><div class="bd"></div>';
      ov.appendChild(card);
      os.appendChild(ov);
      document.body.appendChild(ovHost);
      root = os;
      state.step = 0;
      render();
      card.querySelector('.cl').onclick = function () { ovHost.remove(); };
      ov.onclick = function (e) { if (e.target === ov) ovHost.remove(); };
    };
  }

  fetch(API + '/api/config').then(function (r) { return r.json(); }).then(function (c) {
    cfg = c;
    if (MODE === 'button') mountButton(); else mountInline();
  }).catch(function (e) {
    console.error('[cali-clean] no se pudo cargar la configuración', e);
  });
})();
