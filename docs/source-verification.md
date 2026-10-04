# Auditoría de fuentes · San Diego

**Verificado:** 2026-10-03 (America/Los_Angeles), manualmente desde una red autorizada.
**Evidencia machine-readable:** [`config/source-allowlist.json`](../config/source-allowlist.json)
**Estado operativo al cerrar la auditoría: ninguna fuente habilitada.**

---

## Elegible no es habilitada

Son dos preguntas distintas y el código las responde por separado:

| | Pregunta | Dónde se decide |
|---|---|---|
| **eligible** | ¿La licencia, los términos y el robots.txt nos permiten usar estos datos? | `config/source-allowlist.json`, versionado, lo escribe una persona |
| **enabled** | ¿Dejamos que este código salga a la red a por ellos? | el mismo archivo, campo aparte, decisión humana explícita |
| **constancia** | ¿Esta instalación lo comprobó, y hace cuánto? | `data/source-compliance.json`, fuera de git, caduca a los 180 días |

Una fuente sale a la red **solo si pasa las tres**. Hoy las tres fuentes son
elegibles y ninguna está habilitada, así que el sistema está cerrado por
diseño, no por olvido.

Verificar con `scripts/verify-sources.js` **no habilita nada**: escribe la
constancia operativa y nada más. Encender una fuente es editar
`enabled: true` en el allowlist, a mano, sabiendo lo que se hace.

---

## A · City of San Diego — Business Tax Certificates

**`sd_business_tax_certificates` · ELIGIBLE_BUT_DISABLED · acceso `csv-static` (no implementado)**

| | |
|---|---|
| Página del dataset | https://data.sandiego.gov/datasets/business-tax-certificates/ |
| Descarga oficial | `https://seshat.datasd.org/business_tax_certificates/sd_businesses_active_datasd.csv` |
| Evidencia | HEAD 200 · ETag y Last-Modified presentes · actualización diaria · cabecera real verificada |
| Licencia | **ODC PDDL 1.0** · términos: https://data.sandiego.gov/help/guides/terms/ |
| Redistribución | Permitida. La [FAQ oficial](https://data.sandiego.gov/help/guides/faq/) declara que no hay limitaciones de uso ni de redistribución |
| robots | `data.sandiego.gov/robots.txt` → **404** · `seshat.datasd.org/robots.txt` → **403** |
| Automatización | Documentada por el portal: el [tutorial oficial](https://data.sandiego.gov/help/tutorials/getitdone-closed-2025/) demuestra `pandas.read_csv` contra seshat |
| Límite publicado | Ninguno |
| Política interna | 1 descarga/día · GET condicional con `If-None-Match` / `If-Modified-Since` · caché local · sin crawling de HTML |

**Campos.** Solo `dba_name`, NAICS y dirección de empresa.
**Prohibido: `business_owner_name`** — nombre de persona física. No se mapea,
no se guarda en `raw_json` y no se registra.

**Por qué sigue apagada.** No existe ingestión CSV con ETag en el código. El
tipo de acceso `csv-static` está declarado pero no implementado, y
`buildUrl` lo dice en voz alta en lugar de fingir que funciona.

> Los dos `robots.txt` son ilegibles (404 y 403), que es una situación ambigua.
> Se resolvió a favor del uso porque el portal **documenta y enseña** la
> descarga automatizada de esos mismos archivos: la intención del publicador
> está expresada en otra parte y es inequívoca. Queda escrito aquí para que la
> próxima persona vea el razonamiento y no solo la conclusión.

---

## B · City of San Diego — Approvals for development projects

**`sd_development_approvals` · RESEARCH_ONLY_DISABLED · uso como lead PROHIBIDO**

| | |
|---|---|
| Página del dataset | https://data.sandiego.gov/datasets/development-permits/ |
| Descarga oficial | `https://seshat.datasd.org/development_permits/approvals_created_2026_datasd.csv` |
| Evidencia | HEAD 200 · ETag/Last-Modified · actualización diaria |
| Licencia | **ODC PDDL 1.0** |
| robots | Igual que A: 404 en el portal, 403 en seshat, automatización documentada |
| Política interna | 1 descarga/día · GET condicional · caché local |

**Prohibido: `APPROVAL_PERMIT_HOLDER`** — puede ser una persona física en lugar
de una empresa.

**Por qué es solo investigación.** Tres bloqueos, y hacen falta los tres:

1. Un filtro que distinga organización de particular en el titular del permiso.
2. Verificación externa por dos señales antes de tratar una aprobación como lead.
3. La ingestión `csv-static`, que no existe.

La puerta lo impone con `leadUseAllowed: false`: aunque alguien pusiera
`enabled: true`, `checkSourceAllowed` devuelve `solo_investigacion`.

---

## C · County of San Diego — Food Facility Permits

**`sdcounty_food_facility_permits` · ELIGIBLE_BUT_DISABLED · acceso `soda` (implementado)**

| | |
|---|---|
| Metadata | https://data.sandiegocounty.gov/api/views/c5ez-ufrd |
| Endpoint | `https://data.sandiegocounty.gov/resource/c5ez-ufrd.json` |
| Dataset id | `c5ez-ufrd` |
| Licencia | **Public Domain**, declarada en el metadata del dataset |
| Actualización | Mensual, con datos actuales |
| robots | **200** · `Crawl-delay: 1` · **no bloquea `/resource`** · **bloquea OData** |
| Acceso elegido | Solo SODA en `/resource`, nunca OData |
| Token | `X-App-Token` opcional, no requerido |
| Throttling | HTTP **429**; límites no especificados |
| Política interna | 50 filas/corrida · 1 corrida/día · ≥2000 ms entre peticiones · backoff exponencial · respetar `Retry-After` |

**Campos permitidos** (y solo estos, vía `$select`):
`record_id`, `record_open_date`, `record_issue_date`, `record_name`,
`permit_status`, `active_permit`, `business_type`, `address`, `city`,
`state`, `zip`, `last_updated`.

**Prohibidos siempre:** `permit_owner_full`, `permit_owner`,
`permit_owner_email`, `latitude`, `longitude`.

Los prohibidos se excluyen **en origen**: el `$select` hace que el servidor no
llegue a enviarlos. El filtrado posterior es la segunda red, no la primera.

**Por qué sigue apagada.** Tres pendientes:

1. Manejo de 429 con `Retry-After` y backoff exponencial — **no implementado**.
2. Control de 1 corrida/día — **no implementado**.
3. El mapeo a prospecto está escrito pero sin datos reales contra los que contrastarlo.

---

## D · Rechazadas

Ninguna puede construir su URL: `buildUrl` consulta la lista de datasets
prohibidos y lanza antes de formar la petición.

| Fuente | Dataset | Motivo |
|---|---|---|
| City permits (inventado) | `development-permits-set1` | **ID inventado** por una sesión anterior. El portal municipal no sirve ese dataset por Socrata |
| City businesses (inventado) | `business-listings` | **ID inventado**. El portal no es Socrata para ese contenido |
| County business licenses | — | Nunca tuvo dataset y no existe catálogo general de licencias del condado |
| County Building Permits | `dyzh-7eat` | Dominio público y `/resource` permitido, **pero** último dato de 2023 y `Last-Modified` de 2024: obsoleto para detectar obra reciente |
| Building Permits-Contractors | `76h4-nnmj` | **No declara licencia** y expone datos personales |

---

## Lo que el código hace cumplir

No son promesas de este documento; hay pruebas que fallan si se rompen:

- Una fuente no habilitada **no llega a abrir un socket**: `fetchFromSource`
  comprueba la puerta antes de construir la URL.
- Un dataset rechazado **no puede construir URL**, ni por error de copia.
- Los campos prohibidos **no se mapean, no se guardan y no se registran**.
- Un `accessType` no implementado **falla diciéndolo**, en lugar de devolver
  vacío y parecer que no hay datos.
- Los ids inventados **no aparecen en ninguna definición**.

---

## Pendiente antes de encender nada

Por orden:

1. **429 + `Retry-After` + backoff exponencial** en `apiFetch`. Hoy no existe:
   un 429 se propaga como error genérico.
2. **Cuota diaria por fuente** (1 corrida/día, 50 filas) con persistencia.
3. **Ingestión `csv-static`** con `If-None-Match`/`If-Modified-Since` y caché
   local, si se quieren las dos fuentes municipales.
4. **Filtro organización/particular** para `APPROVAL_PERMIT_HOLDER`, si se
   quiere sacar a B de research-only.
5. Poner `enabled: true` en el allowlist, a mano, para la fuente concreta.
6. `node scripts/verify-sources.js <clave> --terms-ok` desde una red con
   acceso, para dejar la constancia operativa.
