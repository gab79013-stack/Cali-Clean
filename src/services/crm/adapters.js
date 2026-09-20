import crypto from 'node:crypto';

/**
 * Adaptadores de CRM.
 *
 * Cada uno traduce el lead canónico al formato de su CRM y lo crea. Todos
 * reciben `(payload, cfg, http)` y devuelven `{ ref }` con el identificador que
 * el CRM asignó, para poder enlazar después.
 *
 * `http` se inyecta para poder probarlos sin red.
 */

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';
const lastName = (name) => {
  const parts = String(name || '').trim().split(/\s+/);
  // Muchos CRM exigen apellido. El nombre del negocio sirve de relleno honesto.
  return parts.slice(1).join(' ');
};

export const adapters = {
  // ── Webhook genérico: sirve para n8n, Make, Zapier o una API propia ──
  webhook: {
    label: 'Webhook genérico',
    needs: ['webhookUrl'],
    async push(payload, cfg, http) {
      const headers = {};
      if (cfg.webhookSecret) {
        const signature = crypto.createHmac('sha256', cfg.webhookSecret)
          .update(JSON.stringify(payload)).digest('hex');
        headers['X-CaliClean-Signature'] = `sha256=${signature}`;
      }
      const res = await http.post(cfg.webhookUrl, payload, headers);
      return { ref: res?.id || res?.contact_id || res?.lead_id || null, raw: res };
    },
  },

  // ── EspoCRM: el más habitual en los instaladores de Hostinger ──
  espocrm: {
    label: 'EspoCRM',
    needs: ['baseUrl', 'apiKey'],
    async push(payload, cfg, http) {
      const base = String(cfg.baseUrl).replace(/\/$/, '');
      const body = {
        // EspoCRM exige apellido: si no hay contacto con nombre, va la empresa.
        firstName: firstName(payload.contact.name) || undefined,
        lastName: lastName(payload.contact.name) || payload.company || 'Lead',
        accountName: payload.company || undefined,
        emailAddress: payload.contact.email,
        phoneNumber: payload.contact.phone || undefined,
        website: payload.contact.website || undefined,
        addressCity: payload.location.city || undefined,
        addressPostalCode: payload.location.zip || undefined,
        addressStreet: payload.location.address || undefined,
        source: payload.channel === 'outbound' ? 'Cold Call' : 'Web Site',
        status: 'New',
        opportunityAmount: payload.value.annual || payload.value.quote || undefined,
        opportunityAmountCurrency: 'USD',
        description: describe(payload),
      };
      const res = await http.post(`${base}/api/v1/Lead`, body, { 'X-Api-Key': cfg.apiKey });
      return { ref: res?.id || null, raw: res };
    },
  },

  // ── SuiteCRM v8 (JSON:API con OAuth2) ──
  suitecrm: {
    label: 'SuiteCRM',
    needs: ['baseUrl', 'apiKey', 'apiSecret'],
    async push(payload, cfg, http) {
      const base = String(cfg.baseUrl).replace(/\/$/, '');
      // SuiteCRM v8 pide un token antes de cada escritura.
      const token = await http.post(`${base}/Api/access_token`, {
        grant_type: 'client_credentials',
        client_id: cfg.apiKey,
        client_secret: cfg.apiSecret,
      });
      const access = token?.access_token;
      if (!access) throw new Error('SuiteCRM no devolvió access_token');

      const res = await http.post(`${base}/Api/V8/module`, {
        data: {
          type: 'Leads',
          attributes: {
            first_name: firstName(payload.contact.name) || '',
            last_name: lastName(payload.contact.name) || payload.company || 'Lead',
            account_name: payload.company || '',
            email1: payload.contact.email,
            phone_work: payload.contact.phone || '',
            website: payload.contact.website || '',
            primary_address_city: payload.location.city || '',
            primary_address_postalcode: payload.location.zip || '',
            primary_address_street: payload.location.address || '',
            lead_source: payload.channel === 'outbound' ? 'Cold Call' : 'Web Site',
            status: 'New',
            description: describe(payload),
          },
        },
      }, {
        Authorization: `Bearer ${access}`,
        'Content-Type': 'application/vnd.api+json',
        Accept: 'application/vnd.api+json',
      });
      return { ref: res?.data?.id || null, raw: res };
    },
  },

  // ── Perfex CRM ──
  perfex: {
    label: 'Perfex CRM',
    needs: ['baseUrl', 'apiKey'],
    async push(payload, cfg, http) {
      const base = String(cfg.baseUrl).replace(/\/$/, '');
      const res = await http.post(`${base}/api/leads`, {
        name: payload.contact.name || payload.company || 'Lead',
        company: payload.company || '',
        email: payload.contact.email,
        phonenumber: payload.contact.phone || '',
        website: payload.contact.website || '',
        city: payload.location.city || '',
        zip: payload.location.zip || '',
        address: payload.location.address || '',
        source: payload.channel === 'outbound' ? 2 : 1,
        status: 1,
        description: describe(payload),
      }, { authtoken: cfg.apiKey });
      return { ref: res?.id || res?.lead_id || null, raw: res };
    },
  },

  // ── Vtiger (webservice clásico, auth por desafío) ──
  vtiger: {
    label: 'Vtiger',
    needs: ['baseUrl', 'apiUser', 'apiKey'],
    async push(payload, cfg, http) {
      const base = String(cfg.baseUrl).replace(/\/$/, '');
      const challenge = await http.get(
        `${base}/webservice.php?operation=getchallenge&username=${encodeURIComponent(cfg.apiUser)}`);
      const token = challenge?.result?.token;
      if (!token) throw new Error('Vtiger no devolvió token de desafío');

      const session = await http.form(`${base}/webservice.php`, {
        operation: 'login',
        username: cfg.apiUser,
        accessKey: crypto.createHash('md5').update(token + cfg.apiKey).digest('hex'),
      });
      const sessionName = session?.result?.sessionName;
      if (!sessionName) throw new Error('Vtiger rechazó el login');

      const res = await http.form(`${base}/webservice.php`, {
        operation: 'create',
        sessionName,
        elementType: 'Leads',
        element: JSON.stringify({
          lastname: lastName(payload.contact.name) || payload.company || 'Lead',
          firstname: firstName(payload.contact.name) || '',
          company: payload.company || payload.contact.name || 'Lead',
          email: payload.contact.email,
          phone: payload.contact.phone || '',
          website: payload.contact.website || '',
          city: payload.location.city || '',
          code: payload.location.zip || '',
          leadsource: payload.channel === 'outbound' ? 'Cold Call' : 'Web Site',
          description: describe(payload),
          assigned_user_id: cfg.assignedUserId || undefined,
        }),
      });
      return { ref: res?.result?.id || null, raw: res };
    },
  },

  // ── HubSpot ──
  hubspot: {
    label: 'HubSpot',
    needs: ['apiKey'],
    async push(payload, cfg, http) {
      const base = (cfg.baseUrl || 'https://api.hubapi.com').replace(/\/$/, '');
      const res = await http.post(`${base}/crm/v3/objects/contacts`, {
        properties: {
          email: payload.contact.email,
          firstname: firstName(payload.contact.name) || undefined,
          lastname: lastName(payload.contact.name) || undefined,
          phone: payload.contact.phone || undefined,
          company: payload.company || undefined,
          website: payload.contact.website || undefined,
          zip: payload.location.zip || undefined,
          city: payload.location.city || undefined,
          hs_lead_status: 'NEW',
          lifecyclestage: 'lead',
        },
      }, { Authorization: `Bearer ${cfg.apiKey}` });
      return { ref: res?.id || null, raw: res };
    },
  },

  // ── Go High Level ──
  gohighlevel: {
    label: 'Go High Level',
    needs: ['apiKey'],
    async push(payload, cfg, http) {
      const base = (cfg.baseUrl || 'https://services.leadconnectorhq.com').replace(/\/$/, '');
      const res = await http.post(`${base}/contacts/`, {
        locationId: cfg.locationId || undefined,
        email: payload.contact.email,
        phone: payload.contact.phone || undefined,
        name: payload.contact.name || payload.company || undefined,
        companyName: payload.company || undefined,
        website: payload.contact.website || undefined,
        postalCode: payload.location.zip || undefined,
        city: payload.location.city || undefined,
        source: payload.attribution.source,
        tags: [payload.channel, payload.service.segment, payload.scoring.temperature].filter(Boolean),
      }, { Authorization: `Bearer ${cfg.apiKey}`, Version: '2021-07-28' });
      return { ref: res?.contact?.id || res?.id || null, raw: res };
    },
  },
};

/**
 * Nota que se escribe en el CRM. Es lo que lee el comercial antes de llamar,
 * así que lleva el porqué del lead, no solo sus datos.
 */
function describe(payload) {
  const lines = [];
  lines.push(`Servicio: ${payload.service.segment} · ${payload.service.type || '—'} · ${payload.service.frequency || '—'}`);
  if (payload.value.quote) {
    lines.push(`Estimado: $${payload.value.quote} por visita` +
      (payload.value.annual ? ` · $${payload.value.annual} al año` : ''));
  }
  lines.push(`Puntuación: ${payload.scoring.score}/100 (${payload.scoring.temperature})`);
  for (const r of (payload.scoring.reasons || []).slice(0, 6)) {
    lines.push(`  ${r.points > 0 ? '+' : ''}${r.points} ${r.reason}`);
  }
  if (payload.prospecting) {
    lines.push('');
    lines.push(`Origen: prospección automática · ${payload.prospecting.source}`);
    const signal = payload.prospecting.signal || {};
    if (signal.type === 'permit_finaled') {
      lines.push(`Señal: obra finalizada el ${signal.finaledAt}` +
        (signal.valuation ? ` ($${signal.valuation})` : ''));
      if (signal.work) lines.push(`Obra: ${signal.work}`);
    } else if (signal.type === 'new_business') {
      lines.push(`Señal: negocio abierto el ${signal.openedAt}`);
    }
    lines.push(`Correo obtenido: ${payload.prospecting.email_source}`);
  }
  if (payload.message) {
    lines.push('');
    lines.push(`Mensaje del cliente: ${payload.message}`);
  }
  if (payload.attribution.landing_page) lines.push(`Página: ${payload.attribution.landing_page}`);
  return lines.join('\n');
}

export const ADAPTER_KEYS = Object.keys(adapters);
export default adapters;
