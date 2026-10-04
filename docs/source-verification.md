# Auditoría de fuentes · San Diego

**Verificado:** 2026-10-03, ampliado el **2026-10-04** (America/Los_Angeles),
manualmente desde una red autorizada por el operador.
**Evidencia machine-readable:** [`config/source-allowlist.json`](../config/source-allowlist.json)
**Constancia con hash, comprobable sin red:** [`config/source-attestation.json`](../config/source-attestation.json)
**Estado operativo: una fuente habilitada** — `sdcounty_food_facility_permits`.
Las dos municipales siguen apagadas; la de certificados ya tiene el acceso
implementado y probado, y espera decisión operativa y egress.

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

**`sd_business_tax_certificates` · ELIGIBLE_BUT_DISABLED · acceso `csv-static` IMPLEMENTADO (2026-10-04)**

> **Por qué esta fuente es más peligrosa que la del condado.** El condado publica
> establecimientos. La ciudad publica **titulares**: `business_owner_name` es el
> nombre de una persona física, y una parte grande de los certificados son
> autónomos trabajando desde su casa. Un filtro laxo aquí no produce leads
> mediocres: produce una lista de particulares con su domicilio.

### Evidencia del 2026-10-04 (recogida por el operador, no por Cloud)

| | |
|---|---|
| Publicador | City Treasurer, City of San Diego |
| Página del dataset | https://data.sandiego.gov/datasets/business-tax-certificates/ (actualización declarada: 2026-10-03) |
| CSV oficial | `https://seshat.datasd.org/business_tax_certificates/sd_businesses_active_datasd.csv` |
| HEAD | **200** · content-length **18 861 591** · last-modified **Sat, 03 Oct 2026 09:06:24 GMT** · ETag presente · Accept-Ranges bytes |
| SHA256 del volcado | `5c3e7e6a…1109b` — huella de **un** volcado diario, no una constante |
| Licencia | **ODC PDDL 1.0** (dominio público) · FAQ: sin limitación de uso ni redistribución |
| Términos | Advierten que los datos **pueden contener errores y requieren verificación** → de ahí que una fila no demostrable se omita |
| Encabezado | 27 columnas, verificadas y registradas en la attestation |

Constancia: [`config/source-attestation-city.json`](../config/source-attestation-city.json),
con su propio digest. Comprobable sin red con `node scripts/verify-attestation.js`.

### El robots ilegible NO es permiso

`data.sandiego.gov/robots.txt` → **404**. `seshat.datasd.org/robots.txt` → **403**.
Ninguno de los dos se puede leer, y eso **no** se interpreta como vía libre para
recorrer HTML. La autorización que se usa es otra y es explícita: **la página
oficial del dataset presenta ese CSV como su descarga.** Así que el permiso es
sobre **el recurso**, no sobre el dominio, y el código lo hace cumplir:
`buildCsvUrl` compara la URL con la lista `robots.allowedResources` de la
auditoría y se niega a formar cualquier otra, incluida la propia página HTML.

### Las cuatro reglas que decide `city-btc-rules.js`

1. **Forma jurídica inequívoca.** Pasan `CORP`, `LLC`, `SCORP`, `LP`, `NO`, `PRF`.
   Quedan fuera `SOLE` (autónomo), `H-W` (matrimonio) y `TRUST` (patrimonio
   familiar): son personas. Un código que no esté en la lista **se descarta**, no
   se interpreta.
2. **Sector NAICS comercial**, con el motivo escrito sector a sector (12
   sectores). Y dentro de ellos, códigos excluidos por ser actividad domiciliaria
   o sobre personas: guarderías, alquiler de vivienda, manicura, artistas
   independientes, hogares con empleados domésticos.
3. **Certificado activo y vigente**: `account_status=Active`, no caducado y ya
   efectivo.
4. **Dirección comercial completa en San Diego**: número, calle, ciudad y ZIP de
   5 dígitos, sin PO Box, sin PMB, sin `Apt`/`Unit`/`Spc`, sin `residence`.

Y el nombre comercial no puede ser el del titular. Esa comparación es el único
uso permitido de `business_owner_name`: se lee **de paso**, dentro de la misma
iteración, y no se conserva en ningún sitio — ni en el prospecto, ni en
`raw_json`, ni en el snapshot, ni en un log, ni en el texto de un error. El CSV
descargado **se borra siempre** al terminar la corrida, porque lo contiene.

### Un GET por corrida, y el archivo no se queda

`csv-client.js`: una sola petición, GET condicional con `If-None-Match` y
`If-Modified-Since` (un **304** significa "no ha cambiado" y no gasta la ventana
del día), descarga a un temporal con `fsync`, SHA256 del **archivo completo**,
tope de 64 MB y de 120 s, y borrado en un `finally`. Se hashea entero y luego se
para de parsear al llegar a 50 candidatos: cortar la descarga daría un hash de un
trozo, que no sirve para comprobar nada.

`csv-parse.js` es un parser RFC 4180 incremental: aguanta comas y comillas dentro
de campos entrecomillados y saltos de línea dentro de un campo —los tres
aparecen en datos municipales reales— y **falla en voz alta** ante un campo sin
cerrar, texto tras la comilla de cierre o un número de columnas distinto al del
encabezado. Rellenar una fila corta desplazaría los valores y la ciudad acabaría
en el campo del estado.

### Cómo avanza, sin cursor

El CSV es un volcado completo y `account_key` no tiene un orden del que fiarse
(si son números de longitud variable, comparar como texto da un orden falso). En
su lugar se lee del CRM el **índice de lo ya ingerido** —claves y
nombre+dirección normalizados— y se toman los 50 primeros candidatos que no
estén. Determinista, idempotente, avanza solo, y de paso es la deduplicación
cruzada: un negocio que ya entró por el condado o a mano **se omite**, no se
modifica. Sin índice, la fuente no corre.

### Lo que la mantiene apagada

No es la licencia ni el código: es la **decisión operativa** y el **egress**. Los
dos dominios que hacen falta para una preview real son:

    data.sandiego.gov      (página oficial del dataset)
    seshat.datasd.org      (el CSV)

Ninguno está permitido hoy en la red de Cloud.

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

### La cuota de 24 h que sobrevive al contenedor

`data/source-runtime-state.json` muere con el contenedor, así que dos
contenedores del mismo día no se ven entre sí: cada uno cree ser el primero y
los dos consultan el portal. La cuota local no está mal — es que no puede saber
lo que no vivió.

La autoridad durable es el CRM, **sin crear ningún registro de control**. Cada
empresa ingerida lleva su `lastVerified`, que es la marca del snapshot con el que
se escribió, así que:

> última corrida con éxito = `max(lastVerified)` entre las Companies **activas**
> cuya `dedupKey` empieza por `sdcounty-ffp:`

Un GET, una fila, cero escrituras. La consulta es
`filter=dedupKey[startsWith]:sdcounty-ffp:,deletedAt[is]:NULL` con
`order_by=lastVerified[DescNullsLast]&limit=1`.

Qué queda fuera a propósito: las **5 demos retiradas** (en borrado blando —
alguien las apartó, su marca no puede gobernar lo que el sistema hace hoy) y los
**3 leads manuales** (otra procedencia, otra clave: no dicen nada sobre cuándo se
consultó este portal).

Las cuatro decisiones, y van **antes** de resolver el cursor y antes de construir
una sola URL:

| Situación | Resultado |
|---|---|
| Hay marca y han pasado < 24 h | **Bloqueado** · `quota_blocked=1`, `fetched=0`, `crm_writes=0`, `outbound=0`, cero peticiones al Condado |
| Han pasado ≥ 24 h (a las 24 h **exactas** ya pasa) | Permitido |
| Hay empresas del prefijo pero el CRM no se puede leer, o la marca falta, es ilegible, está en el futuro o viene de otro namespace | **Bloqueado** · fail-closed: no saber cuándo se corrió no es permiso para correr |
| No hay ninguna empresa del prefijo | Permitido (bootstrap de verdad) |

La cuota local sigue en pie como segunda defensa dentro del mismo contenedor.

**El hueco que queda, dicho en voz alta.** La marca mide *ingestión visible en el
CRM*, no *consulta al portal*. Si un día la preview consulta pero el `apply`
falla, nada se escribe y la marca no avanza, así que el siguiente contenedor
volverá a consultar. Cerrar eso exigiría un registro de control, y la condición
era no crearlo. Dentro del mismo contenedor lo cubre la cuota local.

### Un solo ciclo de recolección

    node scripts/source-run.js preview
    node scripts/source-run.js sync  --snapshot <archivo> --confirm
    node scripts/source-run.js apply --snapshot <archivo> --confirm \
         --expect-hash sha256:… --max-creates <n>

`preview` consulta **una vez** y deja un snapshot saneado en `data/snapshots/`
(fuera de git) con su `sha256`. `sync` reutiliza exactamente ese archivo: ni una
petición más a la fuente, ni una cuota más, y lo que se escribiría es
literalmente lo que se enseñó. Si el archivo se edita a mano, el hash no cuadra
y se rechaza; si la sesión cambió (otro contenedor), tampoco se reutiliza: el
hash dice que el contenido no cambió, no que la autorización siga vigente.

La preview enseña conteos y campos **semánticos** —nombre comercial, ciudad,
tipo de establecimiento, estado del permiso, identificador recortado— nunca un
dato personal.

`apply` es la única ruta que escribe, y escribe solo Companies. Necesita cinco
cerrojos a la vez: `--confirm`, `TWENTY_WRITE_ENABLED=true`, el hash esperado
pasado a mano (autoriza **un** snapshot concreto, no "el último que haya"), que
el hash, la sesión y el TTL del archivo cuadren, y un tope de creaciones también
a mano. Al primer error se para y no reintenta: un reintento automático sobre un
CRM a medio escribir es cómo se duplica.

`lastVerified` se escribe con la marca del **snapshot**, no con la hora de la
escritura. Es cuando de verdad se comprobó el dato contra el registro oficial, y
además es lo que hace la operación idempotente: con `new Date()` cada pasada
propondría actualizar ese campo y nunca llegaría a `noop`.

### Primera carga productiva (2026-10-04)

38 empresas creadas desde el snapshot `sha256:96a4cb17…b9d9`, con 38 POST y
ningún PATCH ni DELETE. Las 3 empresas que el administrador había creado a mano
quedaron intactas, y las 5 demos retiradas siguen en borrado blando.

Dos defectos de mapeo salieron a la luz justo antes y justo después de escribir,
y los dos están corregidos:

| Defecto | Por qué importaba |
|---|---|
| `toLeadSource('public_record')` devolvía `PUBLIC_WEBSITE` | Habría afirmado que el lead salió de la web del negocio, y a ese negocio no se le ha visitado la web. Ahora devuelve `BUSINESS_DIRECTORY`, que ya existe en el enum: no se cambia el esquema del CRM |
| `sameValue` comparaba la dirección con `JSON.stringify` | La API devuelve el compuesto completo (`addressStreet2` en blanco, `addressLat`/`addressLng` en null) y nosotros enviamos los que conocemos, así que **cada** corrida proponía 38 PATCH idénticos en sustancia. Peor que el ruido: si todo "cambia" siempre, un cambio real no se distingue. Ahora se comparan solo los subcampos que se proponen |

Tras la corrección, replanificar con el mismo snapshot da **38 `noop` y cero
escrituras**: la operación es idempotente de verdad, no solo "no crea de más".

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

### Cómo debe invocarlo una Routine diaria de escritura

    npm run sources:preview || exit $?
    SNAP=$(ls -t data/snapshots/sdcounty_food_facility_permits-*.json | head -1)
    HASH=$(jq -r .sha256 "$SNAP")
    TWENTY_WRITE_ENABLED=true NODE_USE_ENV_PROXY=1       node scripts/source-run.js apply --snapshot "$SNAP" --confirm       --expect-hash "$HASH" --max-creates 50

Qué significan los códigos de salida de `preview`, que es lo que decide si el
segundo paso debe correr:

| Salida | Qué pasó | Qué debe hacer la Routine |
|---|---|---|
| 0 | Hay candidatos y snapshot | Seguir al `apply` |
| 2 | Bloqueada (cuota durable, cuota local o cursor indeterminado) | **Terminar en silencio.** No es un fallo: es el guard |
| 3 | Consultó y ninguna fila sobrevivió a los filtros | Terminar. No hay nada que cargar |
| 1 | Error real (attestation, puerta, escrituras inesperadas) | Avisar |

**Una advertencia sobre `--expect-hash` en esa cadena.** Sacar el hash del mismo
archivo que protege lo convierte en una comprobación circular: ya no significa
"este snapshot concreto lo autorizó una persona", solo "el que acabo de hacer".
Lo que **sí** sigue comprobándose es la integridad del archivo, porque
`readSnapshot` recomputa el hash sobre el contenido y lo compara con el guardado;
una edición a mano se detecta igual. Si se quiere mantener el sentido original
—autorización humana por snapshot— el `apply` no puede ir en la misma Routine.

## Enriquecimiento de lo que ya está en el CRM

    npm run enrich:preview        # preview read-only, no escribe nada

`src/prospecting/enrich-planner.js` propone **solo lo que ya se sabe**. No visita
webs, no adivina dominios a partir del nombre, no construye correos y no inventa
teléfonos: un campo sin sustento se queda sin proponer, y el plan dice por qué.

Puntuación, tabulada para que un score sea explicable sin leer código:

| Puntos | Regla | Por qué |
|---|---|---|
| 25 | `canal_verificado` | hay un correo o teléfono comercial verificado |
| 15 | `segmento_conocido` | el segmento del ICP está identificado |
| 15 | `dentro_del_area` | el ZIP está en el área de servicio |
| 10 | `procedencia_oficial` | viene de un registro público con URL comprobable |
| 10 | `direccion_completa` | calle, ciudad y ZIP: se puede visitar |
| 10 | `entidad_juridica` | es una entidad, no una persona física |

Sin canal de contacto verificado una empresa **no puede estar cualificada**: no
hay por dónde escribirle. El techo sin canal es 60/100.

**Una limitación real, dicha donde se verá.** El CRM **no tiene campo** para el
tipo de establecimiento ni para el NAICS, así que para asignar un segmento hay
dos caminos: leerlo del dato oficial que trajimos (los snapshots locales, que es
lo que hace) o adivinarlo del nombre comercial (que no se hace). "Lucys Bakery
And Pizza" probablemente sea un restaurante, pero *probablemente* no es
verificable, y una ficha con un segmento inventado es peor que una sin segmento:
la primera se usa para decidir y la segunda se revisa.

## Monitoreo por fuente

`src/prospecting/sources/report.js` emite un informe por fuente con las métricas
separadas, y **alerta solo ante un fallo o un cambio significativo**: escrituras
o envíos distintos de cero, errores, un bloqueo que no sea de cuota, filas
traídas sin ningún candidato, un porcentaje de descarte altísimo, o un CSV cuyo
tamaño se aparta mucho del atestiguado. Una corrida bloqueada por cuota **no
alerta**: es el sistema funcionando. Un informe que avisa de todo acaba sin que
nadie lo lea.

### ¿Se puede montar el panel dentro de Twenty?

Comprobado por GET el 2026-10-04: **hoy no.**

    GET /rest/dashboards → 400 PERMISSION_DENIED
    ("Entity performing the request does not have permission")

El endpoint existe, pero la credencial no puede ni leerlo. Y el objeto
`Dashboard` solo expone `title`, `position` y `pageLayoutId`: los widgets viven
en un *page layout* que la API REST no modela, así que ni con permisos de lectura
se podría construir el contenido. Haría falta ampliar los permisos del token **y**
una vía para el page layout. Mientras tanto el informe por fuente cubre la
necesidad sin tocar el CRM.

### Cuando se renueve la evidencia

La constancia caduca a los 180 días. Al renovarla, el digest **tiene que
recomputarse**: cambiar un campo sin recomputarlo invalida el documento, que es
exactamente lo que se quiere. El verificador imprime el digest esperado.
