import {
  OBJECTS, COMPANY_FIELDS, NEVER_OVERWRITE, assertEnum,
  links, emails, address,
  toLeadScore, toContactabilityStatus, toLeadStage, toLeadSource, toLastVerified,
} from './twenty-schema.js';

/**
 * Adaptador nativo de Twenty CRM.
 *
 * Tres invariantes gobiernan este archivo:
 *
 * 1. La credencial no se mira, no se copia y no se registra. Si hay
 *    TWENTY_API_KEY se usa para despliegues externos; si no, el entorno inyecta
 *    el Authorization en las peticiones al dominio permitido. Ninguna ruta de
 *    error imprime cabeceras, y `redact()` limpia lo que pudiera colarse.
 *
 * 2. Nada se escribe sin haber consultado antes. El upsert es siempre
 *    lookup → plan → aplicar, y un conflicto de unicidad se resuelve volviendo
 *    a consultar, nunca creando otra vez.
 *
 * 3. Lo que no se sabe no se envía. Un campo sin valor verificado se omite del
 *    cuerpo: mandarlo vacío borraría lo que ya hubiera en el CRM.
 */

const DEFAULT_TIMEOUT_MS = 20000;

// ── Secreto ──────────────────────────────────────────────────
/**
 * Limpia cualquier credencial que pudiera aparecer en un mensaje de error.
 * Es la última red: el código nunca pone cabeceras en un log, pero un servidor
 * puede devolver la petición entera en su respuesta de error.
 */
export function redact(text) {
  let out = String(text ?? '');
  const key = process.env.TWENTY_API_KEY;
  if (key && key.length >= 8) out = out.split(key).join('[REDACTADO]');
  out = out.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTADO]');
  out = out.replace(/("?(?:authorization|x-api-key|api[_-]?key)"?\s*[:=]\s*"?)[^"'\s,}]{8,}/gi, '$1[REDACTADO]');
  return out;
}

/**
 * Cabeceras de la petición. Se construyen en el momento del envío y no se
 * guardan ni se devuelven: nadie aguas arriba tiene por qué verlas.
 */
function authHeaders() {
  const key = process.env.TWENTY_API_KEY;
  // Sin clave propia, el entorno de ejecución añade el Authorization para el
  // dominio autorizado. Mandar una cabecera vacía rompería esa inyección.
  return key ? { Authorization: `Bearer ${key}` } : {};
}

/**
 * Un 401/403 cuando no hay clave propia casi nunca es un problema de permisos:
 * es que la petición no pasó por el proxy que inyecta el Authorization, y el
 * `fetch` de Node no lo usa salvo que se le diga. Sin esta pista, el error
 * parece de credenciales y se pierde media tarde buscando donde no es.
 */
function proxyHint(status) {
  if (status !== 401 && status !== 403) return '';
  if (process.env.TWENTY_API_KEY) return '';
  if (!process.env.HTTPS_PROXY || process.env.NODE_USE_ENV_PROXY) return '';
  return '\n  Pista: hay un HTTPS_PROXY configurado y el fetch de Node no lo está usando.'
    + '\n  Vuelve a ejecutar con NODE_USE_ENV_PROXY=1 para que la petición reciba el Authorization.';
}

export class TwentyError extends Error {
  constructor(message, { status, code, body } = {}) {
    super(redact(message));
    this.name = 'TwentyError';
    this.status = status;
    this.code = code;
    this.body = body === undefined ? undefined : JSON.parse(redact(JSON.stringify(body ?? null)));
  }
}

/** ¿Es este error un choque con una restricción de unicidad? */
export function isDuplicateConflict(err) {
  if (!err) return false;
  if (err.status === 409) return true;
  const text = `${err.code || ''} ${err.message || ''}`.toLowerCase();
  return /duplicate|unique|already exists|conflict|23505/.test(text);
}

// ── Cliente HTTP ─────────────────────────────────────────────
export function createClient({ baseUrl = process.env.TWENTY_BASE_URL, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!baseUrl) throw new Error('TWENTY_BASE_URL no está configurada.');
  const root = String(baseUrl).replace(/\/+$/, '');

  async function request(method, path, { body, query } = {}) {
    const url = new URL(`${root}/rest${path}`);
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url.toString(), {
        method,
        headers: {
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...authHeaders(),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 400) }; }
      if (!res.ok) {
        const detail = parsed?.messages?.join('; ') || parsed?.message || parsed?.error || `HTTP ${res.status}`;
        throw new TwentyError(`Twenty ${method} ${path}: ${detail}${proxyHint(res.status)}`, {
          status: res.status, code: parsed?.code, body: parsed,
        });
      }
      return parsed;
    } catch (err) {
      if (err instanceof TwentyError) throw err;
      if (err.name === 'AbortError') throw new TwentyError(`Twenty ${method} ${path}: tiempo de espera agotado`, { status: 0 });
      throw new TwentyError(`Twenty ${method} ${path}: ${err.message}`, { status: 0 });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    baseUrl: root,
    get: (path, query) => request('GET', path, { query }),
    post: (path, body) => request('POST', path, { body }),
    patch: (path, body) => request('PATCH', path, { body }),
  };
}

// ── Lectura ──────────────────────────────────────────────────
/**
 * Busca una empresa por su clave de deduplicación.
 *
 * Pide dos registros a propósito. No se pudo confirmar por el metadata (devuelve
 * 403) que `dedupKey` tenga índice único, y en la instancia hay registros con la
 * clave vacía: si una clave devolviera varios, actualizar "el primero" sería
 * elegir al azar qué empresa se machaca. Ante esa ambigüedad, se para.
 */
export async function findCompanyByDedupKey(client, dedupKey) {
  // Se normaliza también al buscar: si la búsqueda y la escritura usaran
  // formatos distintos, el lookup nunca encontraría nada y cada pasada crearía
  // una empresa nueva.
  const key = normalizeDedupKey(dedupKey);
  if (!key) throw new Error('findCompanyByDedupKey requiere una clave no vacía.');

  const res = await client.get(`/${OBJECTS.companies}`, {
    filter: `${COMPANY_FIELDS.dedupKey}[eq]:${key}`,
    limit: 2,
    depth: 0,
  });
  const rows = res?.data?.[OBJECTS.companies] || [];
  if (rows.length > 1) {
    throw new TwentyError(
      `La clave de deduplicación "${key}" devuelve ${rows.length} empresas. ` +
      'No se actualiza ninguna: resuélvelo en el CRM antes de volver a sincronizar.',
      { code: 'AMBIGUOUS_DEDUP_KEY' },
    );
  }
  return rows[0] || null;
}

/**
 * La clave de deduplicación más baja que ya existe con un namespace dado.
 *
 * Es cómo se recupera el cursor de una fuente sin guardarlo en ningún sitio: si
 * la clave se deriva del identificador del registro oficial, el CRM ya sabe
 * hasta dónde se llegó. Un GET, una fila, cero escrituras.
 *
 * Mira también los registros borrados en blando: una empresa que alguien
 * eliminó sigue habiendo sido ingerida, y volver a traerla el día siguiente
 * sería resucitar lo que el administrador decidió retirar.
 */
export async function lowestDedupKeyWithPrefix(client, prefix) {
  const clean = trim(prefix, 60);
  if (!clean) throw new Error('lowestDedupKeyWithPrefix requiere un prefijo.');

  const query = {
    filter: `${COMPANY_FIELDS.dedupKey}[startsWith]:${clean}`,
    // Sintaxis verificada contra el OpenAPI de la instancia:
    // `campo[AscNullsLast]`, no `campoAsc`.
    order_by: `${COMPANY_FIELDS.dedupKey}[AscNullsLast]`,
    limit: 1,
    depth: 0,
  };
  const res = await client.get(`/${OBJECTS.companies}`, query);
  const rows = res?.data?.[OBJECTS.companies] || [];
  return rows[0]?.[COMPANY_FIELDS.dedupKey] || null;
}

/**
 * La empresa ACTIVA de un namespace con el `lastVerified` más reciente.
 *
 * Es la autoridad durable de la cuota de 24 h: cada empresa ingerida lleva la
 * marca del snapshot con el que se escribió, así que la más reciente dice
 * cuándo se consultó el portal por última vez, y eso sobrevive a que el
 * contenedor muera. Un GET, una fila, cero escrituras.
 *
 * `deletedAt[is]:NULL` no es decoración: una empresa que alguien retiró no
 * puede seguir gobernando lo que el sistema hace hoy.
 */
export async function latestVerifiedWithPrefix(client, prefix) {
  const clean = trim(prefix, 60);
  if (!clean) throw new Error('latestVerifiedWithPrefix requiere un prefijo.');

  const res = await client.get(`/${OBJECTS.companies}`, {
    filter: `${COMPANY_FIELDS.dedupKey}[startsWith]:${clean},deletedAt[is]:NULL`,
    order_by: `${COMPANY_FIELDS.lastVerified}[DescNullsLast]`,
    limit: 1,
    depth: 0,
  });
  const row = (res?.data?.[OBJECTS.companies] || [])[0];
  if (!row) return null;
  return {
    dedupKey: row[COMPANY_FIELDS.dedupKey] ?? null,
    lastVerified: row[COMPANY_FIELDS.lastVerified] ?? null,
    deletedAt: row.deletedAt ?? null,
  };
}

/**
 * Índice de lo que el CRM ya tiene: claves de deduplicación y nombre+dirección.
 *
 * Es lo que permite a una fuente sin cursor saber qué es nuevo, y lo que evita
 * crear por segunda vez un negocio que ya entró por otra procedencia. Dos
 * registros del mismo restaurante —uno del condado, otro de la ciudad— no
 * comparten identificador, pero sí nombre y calle.
 *
 * Pagina hasta agotar, con un tope de páginas para que un CRM con cien mil
 * empresas no deje la corrida leyendo para siempre. Si se agota el tope se dice,
 * porque un índice incompleto crearía duplicados sin que nadie se enterara.
 */
export async function loadCrmIndex(client, { pageSize = 60, maxPages = 50, normalize } = {}) {
  const dedupKeys = new Set();
  const crossKeys = new Set();
  const names = [];
  let cursor = null;
  let pages = 0;
  let complete = true;

  for (;;) {
    if (pages >= maxPages) { complete = false; break; }
    const query = { limit: pageSize, depth: 0, order_by: 'id[AscNullsLast]' };
    if (cursor) query.starting_after = cursor;
    const res = await client.get(`/${OBJECTS.companies}`, query);
    const rows = res?.data?.[OBJECTS.companies] || [];
    pages++;

    for (const row of rows) {
      const key = trim(row[COMPANY_FIELDS.dedupKey]);
      if (key) dedupKeys.add(key);
      const name = trim(row[COMPANY_FIELDS.name]);
      const street = trim(row[COMPANY_FIELDS.address]?.addressStreet1);
      if (name && typeof normalize === 'function') {
        crossKeys.add(`${normalize(name)}|${normalize(street)}`);
      }
      names.push(name);
    }

    const next = res?.pageInfo?.endCursor;
    if (!rows.length || !res?.pageInfo?.hasNextPage || !next) break;
    cursor = next;
  }

  return { dedupKeys, crossKeys, total: names.length, pages, complete };
}

// ── Mapeo ────────────────────────────────────────────────────
const trim = (v, max = 400) => String(v ?? '').trim().slice(0, max);

/**
 * Normaliza la clave de deduplicación al formato que ya usa el CRM.
 *
 * Las empresas que hay en la instancia llevan el dominio desnudo
 * ("cal-prop.com"), mientras que el generador interno produce claves con
 * espacio de nombres ("web:cal-prop.com"). Sincronizar sin reconciliar las dos
 * convenciones habría creado un duplicado de cada empresa que ya existía, que
 * es justo lo que un upsert idempotente tiene que impedir.
 *
 * Las claves que no vienen de un dominio conservan su prefijo: no hay
 * convención previa en el CRM para ellas y mezclarlas sería peor.
 */
export function normalizeDedupKey(raw) {
  const key = trim(raw, 120);
  if (!key) return '';
  const webPrefixed = key.match(/^web:(.+)$/i);
  if (webPrefixed) return webPrefixed[1].replace(/^www\./i, '').toLowerCase();
  // Un dominio suelto también se normaliza, para que "WWW.Acme.com" y
  // "acme.com" no acaben siendo dos empresas distintas.
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(key) && !key.includes(' ')) {
    return key.replace(/^www\./i, '').toLowerCase();
  }
  return key;
}

/**
 * Traduce un prospecto al cuerpo de Company.
 *
 * Solo salen campos con un valor verificado. Un `undefined` significa "no lo
 * sé", y por eso se elimina del cuerpo en lugar de enviarse vacío.
 */
export function mapProspectToCompany(prospect = {}) {
  const dedupKey = normalizeDedupKey(prospect.dedupKey ?? prospect.dedupe_key);
  if (!dedupKey) {
    throw new Error('El prospecto no tiene clave de deduplicación: sin ella no hay upsert idempotente posible.');
  }

  const name = trim(prospect.businessName ?? prospect.business_name, 200);
  if (!name) throw new Error('El prospecto no tiene nombre de empresa.');

  const businessEmail = trim(prospect.email, 190).toLowerCase();
  const phone = trim(prospect.phone, 40);
  const optedOut = Boolean(prospect.optedOut ?? prospect.opted_out);
  const contactFormOnly = Boolean(prospect.contactFormOnly ?? prospect.contact_form_only);

  const contactability = toContactabilityStatus({
    optedOut,
    businessEmail: Boolean(businessEmail),
    phone: Boolean(phone),
    contactFormOnly,
  });
  const stage = toLeadStage({
    stage: prospect.stage,
    optedOut,
    hasVerifiedChannel: Boolean(businessEmail || phone),
  });

  const body = {
    [COMPANY_FIELDS.name]: name,
    [COMPANY_FIELDS.dedupKey]: dedupKey,
    [COMPANY_FIELDS.domainName]: links(prospect.website, name),
    [COMPANY_FIELDS.sourceUrl]: links(prospect.sourceUrl ?? prospect.source_url, trim(prospect.sourceLabel ?? prospect.source, 60)),
    [COMPANY_FIELDS.businessEmail]: emails(businessEmail),
    [COMPANY_FIELDS.serviceArea]: trim(prospect.serviceArea ?? prospect.service_area, 120) || undefined,
    [COMPANY_FIELDS.contactabilityStatus]: assertEnum('contactabilityStatus', contactability),
    [COMPANY_FIELDS.leadStage]: assertEnum('leadStage', stage),
    [COMPANY_FIELDS.leadScore]: toLeadScore(prospect.icpScore ?? prospect.icp_score),
    [COMPANY_FIELDS.leadSource]: toLeadSource(prospect.channel),
    [COMPANY_FIELDS.lastVerified]: toLastVerified(prospect.lastVerified ?? prospect.last_verified ?? prospect.updated_at),
    [COMPANY_FIELDS.address]: address({
      street: prospect.address, city: prospect.city, postcode: prospect.zip,
      state: prospect.state, country: prospect.country,
    }),
  };

  if (body[COMPANY_FIELDS.leadScore]) assertEnum('leadScore', body[COMPANY_FIELDS.leadScore]);
  assertEnum('leadSource', body[COMPANY_FIELDS.leadSource]);

  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  // Garantía estructural: estos nunca viajan en un cuerpo de escritura.
  for (const k of NEVER_OVERWRITE) delete body[k];
  return body;
}

/** Compara el valor propuesto con el que ya hay, respetando los tipos compuestos. */
function sameValue(current, next) {
  if (next === undefined) return true;              // no se propone nada
  if (current === null || current === undefined) return false;
  if (typeof next === 'object') {
    if ('primaryLinkUrl' in next) {
      // La API normaliza los enlaces y le quita la barra final: se le envía
      // ".../business-tax-certificates/" y devuelve ".../business-tax-certificates".
      // Comparar en crudo hacía que cada corrida propusiera un PATCH del mismo
      // enlace, y eso tapa los cambios de verdad: si todo "cambia" siempre, un
      // cambio real no se distingue de uno fantasma.
      //
      // Se quita UNA barra final y nada más. Dos rutas distintas siguen siendo
      // distintas: esto no es una normalización de URLs, es deshacer la única
      // que el servidor aplica.
      const sinBarra = (v) => trim(v).replace(/\/+$/, '');
      return sinBarra(current.primaryLinkUrl) === sinBarra(next.primaryLinkUrl);
    }
    if ('primaryEmail' in next) return trim(current.primaryEmail).toLowerCase() === trim(next.primaryEmail).toLowerCase();

    // ADDRESS: se comparan SOLO los subcampos que se proponen.
    //
    // Comparar el objeto entero con JSON.stringify no funciona: la API devuelve
    // el compuesto completo —addressStreet2 en blanco, addressLat y addressLng
    // en null— y nosotros enviamos los cuatro o cinco que conocemos. Así que
    // cada corrida veía un cambio donde no había ninguno y proponía un PATCH
    // idéntico en sustancia. Aparte del ruido, eso tapa los cambios de verdad:
    // si todo "cambia" siempre, un cambio real no se distingue.
    //
    // Un subcampo ausente en la propuesta significa "no lo sé", igual que en el
    // resto del adaptador, y no se usa para decidir que algo cambió.
    if (Object.keys(next).some((k) => k.startsWith('address'))) {
      return Object.entries(next).every(([k, v]) => {
        if (v === undefined) return true;
        const a = current?.[k];
        // null, undefined y cadena vacía son lo mismo para un subcampo de
        // dirección: los tres significan "aquí no hay nada".
        const norm = (x) => (x === null || x === undefined ? '' : trim(x));
        return norm(a) === norm(v);
      });
    }
    return JSON.stringify(current) === JSON.stringify(next);
  }
  if (next && typeof next === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(next)) {
    const a = new Date(current).getTime();
    const b = new Date(next).getTime();
    return Number.isFinite(a) && Number.isFinite(b) && a === b;
  }
  return trim(current) === trim(next);
}

/** Reduce el cuerpo a lo que de verdad cambia, para no reescribir lo intacto. */
export function diffCompany(existing, desired) {
  const changes = {};
  for (const [field, value] of Object.entries(desired)) {
    if (!sameValue(existing?.[field], value)) changes[field] = value;
  }
  return changes;
}

// ── Plan (solo lectura) ──────────────────────────────────────
/**
 * Decide qué se haría, sin tocar nada. Es lo que imprime el dry-run, y es
 * también el primer paso del camino real: el plan y la ejecución comparten
 * código, así que lo que se muestra es lo que se haría.
 */
export async function planCompanyUpsert(client, prospect) {
  const desired = mapProspectToCompany(prospect);
  const dedupKey = desired[COMPANY_FIELDS.dedupKey];
  const existing = await findCompanyByDedupKey(client, dedupKey);

  if (!existing) {
    return { action: 'create', dedupKey, name: desired[COMPANY_FIELDS.name], body: desired, existing: null, changes: desired };
  }

  const changes = diffCompany(existing, desired);
  // El dueño solo se propone cuando el registro no tiene ninguno.
  if (!existing[COMPANY_FIELDS.accountOwnerId] && prospect.accountOwnerId) {
    changes[COMPANY_FIELDS.accountOwnerId] = prospect.accountOwnerId;
  }
  delete changes[COMPANY_FIELDS.dedupKey];  // la clave no se reescribe

  return {
    action: Object.keys(changes).length ? 'update' : 'noop',
    dedupKey,
    name: desired[COMPANY_FIELDS.name],
    id: existing.id,
    body: changes,
    existing,
    changes,
  };
}

// ── Aplicación ───────────────────────────────────────────────
/**
 * Ejecuta el plan. En dry-run devuelve el plan sin una sola escritura.
 *
 * El caso interesante es el conflicto: si entre el lookup y el create otro
 * proceso creó la misma empresa, se vuelve a consultar y se resuelve como
 * actualización. En ninguna rama se crea dos veces.
 */
export async function upsertCompany(client, prospect, { dryRun = true } = {}) {
  const plan = await planCompanyUpsert(client, prospect);
  if (dryRun) return { ...plan, executed: false, dryRun: true };
  if (plan.action === 'noop') return { ...plan, executed: false, dryRun: false };

  if (plan.action === 'update') {
    const res = await client.patch(`/${OBJECTS.companies}/${plan.id}`, plan.body);
    return { ...plan, executed: true, dryRun: false, record: res?.data?.updateCompany || res?.data || null };
  }

  try {
    const res = await client.post(`/${OBJECTS.companies}`, plan.body);
    return { ...plan, executed: true, dryRun: false, record: res?.data?.createCompany || res?.data || null };
  } catch (err) {
    if (!isDuplicateConflict(err)) throw err;

    // Carrera perdida: alguien la creó entre nuestro lookup y nuestro create.
    const existing = await findCompanyByDedupKey(client, plan.dedupKey);
    if (!existing) {
      throw new TwentyError(
        `Conflicto de unicidad en "${plan.dedupKey}" pero la empresa no aparece al volver a consultarla. ` +
        'No se reintenta la creación para no duplicar.',
        { status: err.status, code: 'CONFLICT_UNRESOLVED' },
      );
    }
    const changes = diffCompany(existing, plan.body);
    delete changes[COMPANY_FIELDS.dedupKey];
    if (!Object.keys(changes).length) {
      return { ...plan, action: 'noop', id: existing.id, existing, executed: false, dryRun: false, resolvedFromConflict: true };
    }
    const res = await client.patch(`/${OBJECTS.companies}/${existing.id}`, changes);
    return {
      ...plan, action: 'update', id: existing.id, existing, body: changes, changes,
      executed: true, dryRun: false, resolvedFromConflict: true,
      record: res?.data?.updateCompany || res?.data || null,
    };
  }
}

// ── People y Opportunities (mínimos, solo con datos válidos) ──
/**
 * Una persona solo se crea si hay un nombre real y un canal de contacto.
 * Sin eso no hay nada que registrar, y rellenar con el nombre de la empresa
 * fabricaría un contacto que no existe.
 */
export function mapProspectToPerson(prospect = {}, companyId) {
  const raw = trim(prospect.contactName ?? prospect.contact_name, 120);
  if (!raw || !companyId) return null;

  // El nombre tiene que venir de la propia web del negocio, donde esa persona
  // se presenta como contacto. Un nombre sacado de un registro público (el
  // solicitante de una licencia de obra, por ejemplo) es un dato personal que
  // nadie publicó para ser contactado comercialmente, y no entra en el CRM.
  const origin = trim(prospect.contactSource ?? prospect.contact_source, 60);
  if (origin !== 'business_website') return null;

  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;              // "Recepción" no es una persona

  const email = trim(prospect.email, 190).toLowerCase();
  const phone = trim(prospect.phone, 40);
  if (!email && !phone) return null;

  const person = {
    name: { firstName: parts[0], lastName: parts.slice(1).join(' ') },
    companyId,
  };
  const mail = emails(email);
  if (mail) person.emails = mail;
  if (phone) person.phones = { primaryPhoneNumber: phone, additionalPhones: [] };
  const title = trim(prospect.jobTitle ?? prospect.job_title, 120);
  if (title) person.jobTitle = title;
  return person;
}

/**
 * Una oportunidad solo tiene sentido con un valor estimado. Sin importe sería
 * una fila vacía que ensucia el embudo del comercial.
 */
export function mapProspectToOpportunity(prospect = {}, companyId) {
  if (!companyId) return null;
  const annual = Number(prospect.estAnnualValue ?? prospect.est_annual_value ?? 0);
  const visit = Number(prospect.estVisitValue ?? prospect.est_visit_value ?? 0);
  const amount = annual > 0 ? annual : visit;
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const name = trim(prospect.businessName ?? prospect.business_name, 180);
  if (!name) return null;

  return {
    name: `${name} · limpieza`,
    companyId,
    stage: assertEnum('opportunityStage', 'NEW'),
    amount: { amountMicros: Math.round(amount * 1_000_000), currencyCode: 'USD' },
  };
}

/** Plan completo de un prospecto: empresa, y persona y oportunidad si procede. */
export async function planProspect(client, prospect) {
  const company = await planCompanyUpsert(client, prospect);
  const companyId = company.id || null;
  return {
    company,
    // Con la empresa aún sin crear no hay id al que colgarlas: se planean
    // igualmente para que el dry-run enseñe la intención completa.
    person: mapProspectToPerson(prospect, companyId ?? '<id-de-la-empresa-nueva>'),
    opportunity: mapProspectToOpportunity(prospect, companyId ?? '<id-de-la-empresa-nueva>'),
  };
}

export default {
  createClient, planProspect, upsertCompany, planCompanyUpsert,
  findCompanyByDedupKey, lowestDedupKeyWithPrefix, latestVerifiedWithPrefix,
  loadCrmIndex, redact,
};
