# Auditoría de fuentes · San Diego

**Verificado:** 2026-10-03, ampliado el **2026-10-04** (America/Los_Angeles),
manualmente desde una red autorizada por el operador.
**Evidencia machine-readable:** [`config/source-allowlist.json`](../config/source-allowlist.json)
**Constancia con hash, comprobable sin red:** [`config/source-attestation.json`](../config/source-attestation.json)
**Estado operativo: una fuente habilitada** — `sdcounty_food_facility_permits`.
Las dos municipales siguen apagadas.

---

## Elegible no es habilitada

Son dos preguntas distintas y el código las responde por separado:

| | Pregunta | Dónde se decide |
|---|---|---|
| **eligible** | ¿La licencia, los términos y el robots.txt nos permiten usar estos datos? | `config/source-allowlist.json`, versionado, lo escribe una persona |
| **enabled** | ¿Dejamos que este código salga a la red a por ellos? | el mismo archivo, campo aparte, decisión humana explícita |
| **constancia** | ¿Alguien lo comprobó, y hace cuánto? | una de las dos, y basta con una: `config/source-attestation.json` (importada, con hash, versionada) o `data/source-compliance.json` (local, fuera de git). Las dos caducan a los 180 días |

Una fuente sale a la red **solo si pasa las tres**. Hoy las tres son elegibles
y solo una está habilitada: lo que está cerrado, lo está por decisión escrita,
no por olvido.

Verificar con `scripts/verify-sources.js` **no habilita nada**: escribe la
constancia operativa y nada más. Encender una fuente es editar
`enabled: true` en el allowlist, a mano, sabiendo lo que se hace.

### Por qué hay dos tipos de constancia

Esta instalación corre sin salida a internet hacia los portales de datos, así
que no puede verificar nada en vivo. La constancia **importada** resuelve eso
sin mentir: el operador recoge la evidencia desde su red, la deja en
`config/source-attestation.json`, y aquí se comprueba lo que *se puede*
comprobar sin red.

    node scripts/verify-attestation.js

Lo que ese verificador demuestra: la estructura está completa, el digest
SHA256 del documento cuadra con su contenido (se recomputa en el momento) y la
evidencia no ha caducado. Lo que **no** demuestra, y lo dice en su salida: los
SHA256 de `robots.txt`, del metadata y de la muestra SODA son evidencia
importada —sin los artefactos ni red no se pueden recomputar— y no hay firma
criptográfica, porque no hay clave autorizada en el repositorio. Una
attestation que *traiga* un campo `signature` se **rechaza**: afirmar una
comprobación que no se hizo es peor que no hacerla.

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

**`sdcounty_food_facility_permits` · ENABLED (2026-10-04) · acceso `soda` (implementado)**

> **La única fuente habilitada.** Es la única con acceso implementado, licencia
> de dominio público, `/resource` permitido por robots y datos actuales.


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
| Política interna | 50 filas/corrida · **1 corrida con éxito cada 24 h** · ≥2000 ms entre peticiones · 4 intentos máx. con backoff exponencial (base 1 s, tope 30 s, jitter completo) · `Retry-After` manda, truncado a 300 s |
| Evidencia del 2026-10-04 | `robots.txt` sha256 `0d8f9656…ab84` · metadata `b2d752bb…e5d7` · muestra SODA `850f68e3…b47d`, los tres con HTTP 200 |

**Campos permitidos** (y solo estos, vía `$select`):
`record_id`, `record_open_date`, `record_issue_date`, `record_name`,
`permit_status`, `active_permit`, `business_type`, `address`, `city`,
`state`, `zip`, `last_updated`.

**Prohibidos siempre:** `permit_owner_full`, `permit_owner`,
`permit_owner_email`, `latitude`, `longitude`.

Los prohibidos se excluyen **en origen**: el `$select` hace que el servidor no
llegue a enviarlos. El filtrado posterior es la segunda red, no la primera.

**Filas que se descartan enteras.** Una fila cuyo `business_type`, nombre,
estado del permiso o dirección delate un domicilio —*Microenterprise Home
Kitchen* (MHKO), *cottage food*, *residence*, *private home*— **no se recorta:
se tira completa**. Un permiso MHKO de California (AB 626) se concede sobre la
vivienda del titular, así que su dirección *es* un domicilio particular aunque
ningún campo prohibido aparezca. La comprobación se hace **antes** de recortar
campos, porque si se recortara primero `business_type` ya no estaría ahí para
delatarla.

### Lo que el dataset es de verdad (2026-10-04)

La primera corrida real devolvió **0 filas**. No fue la red ni la puerta: fue el
dataset. Comprobado con cuatro GET de agregados —respuestas de decenas de bytes,
sin traer una sola fila de datos:

| Hecho | Consecuencia |
|---|---|
| `record_open_date` y `record_issue_date` existen en el esquema pero están **vacíos en las 15 906 filas** (`count()` = 0) | Un `$where` sobre esas columnas devuelve 0 **con cualquier ventana**. Era la causa del cero |
| `last_updated` vale `2026-08-10` en **todas** las filas (min = max) | Es el sello del volcado mensual, no la fecha de cambio de cada fila. Ordena de forma estable; no sirve de cursor |
| `permit_status`: Permit Renewed 14 074 · Issued 1 481 · **Expired 351** | Hay que filtrar por estado, no solo por la bandera |
| `active_permit` es `'A'` **también en las expiradas** | La bandera por sí sola no significa activo. Se exigen las dos condiciones |
| `record_id`: 15 905 distintos en 15 906 filas | Hay **un identificador repetido**. La clave de deduplicación lo absorbe |
| El servidor devuelve además `id`, `permit_owner` y `permit_owner_full` | Una clave desconocida y dos prohibidas: las tres se caen en el filtro |

Así que la consulta dejó de filtrar por fecha. Filtra por permiso activo
(`active_permit = 'A' AND permit_status in ('Issued','Permit Renewed')`) y
recorre el dataset por `record_id` descendente, que es el único orden total que
tiene. Sin paginación: 50 filas, una corrida, y la siguiente continúa.

### El cursor durable no está en un archivo

El contenedor donde corre la Routine es **efímero**:
`data/source-runtime-state.json` desaparece entre ejecuciones. Un cursor
guardado ahí no es un cursor, es la ilusión de uno, y en la práctica cada día
volvería a empezar por la cabeza del dataset.

Hay exactamente una cosa durable en este sistema que ya sabe qué se ha
ingerido: **el propio CRM**. La clave de deduplicación es
`sdcounty-ffp:<record_id>`, determinista y con namespace estable, así que

> el cursor = el `record_id` más bajo que ya existe en Companies

y se recupera con un GET de una fila (`dedupKey[startsWith]` + `order_by`
ascendente + `limit=1`). No hace falta inventar persistencia, no se escribe nada
en ningún sitio, y no hay estado que pueda desincronizarse de la realidad:
el estado **es** la realidad.

Tres orígenes, en orden: `local` (el archivo, mientras el contenedor viva) →
`crm` (el durable) → ninguno (bootstrap de verdad). Y una regla que no se
negocia: **si el CRM está configurado y no se puede leer, no se hace bootstrap.**
Un bootstrap a ciegas gastaría la única corrida del día releyendo lo que ya
teníamos. Se para con `cursor_indeterminado` y se dice por qué.

### Un solo ciclo de recolección

    node scripts/source-run.js preview
    node scripts/source-run.js sync --snapshot <archivo> --confirm

`preview` consulta **una vez** y deja un snapshot saneado en `data/snapshots/`
(fuera de git) con su `sha256`. `sync` reutiliza exactamente ese archivo: ni una
petición más a la fuente, ni una cuota más, y lo que se escribiría es
literalmente lo que se enseñó. Si el archivo se edita a mano, el hash no cuadra
y se rechaza; si la sesión cambió (otro contenedor), tampoco se reutiliza: el
hash dice que el contenido no cambió, no que la autorización siga vigente.

La preview enseña conteos y campos **semánticos** —nombre comercial, ciudad,
tipo de establecimiento, estado del permiso, identificador recortado— nunca un
dato personal.

**Por qué se pudo encender.** Los tres bloqueos de la auditoría del 2026-10-03
están resueltos, y cada uno con la prueba que lo sostiene (consta en
`resolvedBlockers` del allowlist):

| Bloqueo | Resuelto por | Prueba |
|---|---|---|
| 429 + `Retry-After` + backoff | `src/prospecting/sources/soda-client.js` | `test/soda-quota.test.js` |
| 1 corrida/día con persistencia | `src/prospecting/sources/quota.js` | `test/soda-quota.test.js` |
| Mapeo sin datos contra los que contrastarlo | Contrastado contra la **forma** de la muestra del 2026-10-04 atestiguada, y después contra una corrida real | `test/source-defense.test.js`, `test/source-bootstrap.test.js` |

**La primera corrida real ya pasó** (2026-10-04, bootstrap): 50 filas pedidas,
50 traídas, **38 empresas**, **12 cocinas domésticas descartadas enteras**, 0
escrituras en el CRM. Lo que la auditoría del 2026-10-03 había supuesto sobre
los valores de `permit_status` y `active_permit` resultó ser falso, y los
fixtures de las pruebas se corrigieron a los valores reales: una prueba que
corre contra valores que el portal no usa no prueba nada.

**Riesgo que queda.** La señal de cada prospecto dice `active_permit`, no
`new_business`: el dataset no da fecha de apertura, así que no se puede afirmar
que un negocio sea nuevo. Quien puntúe estos prospectos no recibirá bonus de
frescura, y eso es correcto, no una carencia.

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
- La allowlist de campos es **cerrada**: se cae lo prohibido *y* lo que nadie
  declaró. Una columna nueva con datos personales no espera a que alguien se
  acuerde de prohibirla.
- Una fila residencial **se descarta entera**, y la comprobación va antes del
  recorte de campos.
- Un 429 se **obedece**: `Retry-After` del servidor por delante del backoff
  propio, 4 intentos y se abandona la corrida diciéndolo.
- La cuota **persiste** con escritura atómica (temp + `fsync` + `rename`) y un
  lock con caducidad: dos corridas simultáneas no se pisan ni dejan la fuente
  bloqueada para siempre si una muere.
- Una corrida de fuentes **no toca el CRM ni envía nada**. No se comprueba
  leyendo las métricas: se levanta un Twenty simulado que registra todas las
  peticiones y se afirma sobre ese registro.

---

## Ver qué haría una corrida, sin red y sin CRM

    node scripts/dry-run-source.js

Imprime el juego completo de métricas de una corrida contra una muestra
sintética local: cuántas filas llegaron, cuántas se mapearon, cuántas cayeron
por domicilio o por duplicado, cuántos 429 hubo, y —en el mismo sitio— que las
escrituras en el CRM y los mensajes enviados son cero. Sale con error si
alguna de esas cosas deja de ser cierta.

---

## Pendiente

Lo que sigue sin hacer, y lo que haría falta para cada cosa:

1. **Ingestión `csv-static`** con `If-None-Match`/`If-Modified-Since` y caché
   local, si se quieren las dos fuentes municipales. Hoy `buildUrl` falla
   diciéndolo.
2. **Filtro organización/particular** para `APPROVAL_PERMIT_HOLDER`, si se
   quiere sacar a B de research-only.
3. **Egress hacia `data.sandiegocounty.gov`**: concedido y comprobado el
   2026-10-04. Ojo con el proxy: el `fetch` de Node no lo usa por defecto, y sin
   `NODE_USE_ENV_PROXY=1` la petición al CRM llega **sin** el `Authorization`
   que inyecta el entorno y vuelve con un 403 que parece de permisos. Los
   scripts de npm ya lo llevan.
4. Para cada fuente nueva: `enabled: true` a mano en el allowlist, y una
   constancia —importada con hash, o
   `node scripts/verify-sources.js <clave> --terms-ok` desde una red con
   acceso.

### Cuando se renueve la evidencia

La constancia caduca a los 180 días. Al renovarla, el digest **tiene que
recomputarse**: cambiar un campo sin recomputarlo invalida el documento, que es
exactamente lo que se quiere. El verificador imprime el digest esperado.
