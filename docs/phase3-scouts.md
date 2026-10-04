# Fase 3 · Los tres scouts

**Estado, fuente a fuente.** De tres candidatas, una pasó:

| Scout | Estado | Por qué |
|---|---|---|
| CaliClean Property & Manager Scout (HUD) | **ENABLED** | robots inexistente, API pública, esquema verificado en vivo desde Cloud |
| CaliClean Commercial Development Permit Scout (City) | **ENABLED** | la única con licencia **explícita**: el portal declara ODC PDDL 1.0 para el conjunto de datos |
| CaliClean ABC Active License Scout (ABC) | **ENABLED** | la única con **dominio público** declarado por el publicador, y la primera que pasa las nueve comprobaciones sin salvedades |
| CaliClean Education & Childcare Facility Scout (CDE) | `PENDING_LICENSE_REVIEW` | auditada en vivo y bien en todo menos una cosa: la declaración de copyright del sitio no es legible |

Dos candidatas se **retiraron**, con su expediente en `docs/retired/`:
`CaliClean Commercial Facility Scout` (HCAI/CDPH), porque su robots prohíbe las
rutas que necesitaba, y `CaliClean State License Scout` (CSLB), porque el WAF de
su portal rechaza la descarga con un 403 y no se intenta sortear. **CSLB no
cuenta entre los scouts utilizables**; la sustituye la de permisos de
desarrollo.

County y City no se tocaron: siguen habilitadas, con su Routine y su comando.

---

## Hosts y recursos exactos

| Scout | Host | Recurso exacto |
|---|---|---|
| CaliClean Property & Manager Scout | `egis.hud.gov` | `/arcgis/rest/services/gotit/MultifamilyProperties/MapServer/0/query` |
| CaliClean Education & Childcare Facility Scout | `www.cde.ca.gov` | `/schooldirectory/report?rid=dl1&tp=txt` (volcado TSV) |
| CaliClean Commercial Development Permit Scout | `seshat.datasd.org` | `/development_permits/approvals_issued_2026_datasd.csv` (ficha en `data.sandiego.gov`) |
| CaliClean ABC Active License Scout | `www.abc.ca.gov` | `/wp-content/uploads/DailyExport-CSV.zip` (ficha en `/licensing/licensing-reports/`) |

Los tres están permitidos y los tres se han comprobado desde este contenedor.
CDE tiene cuatro artefactos con huella real y uno ausente, y ese uno le invalida
la attestation **a propósito**: un `sha256` de ceros se trata como evidencia
AUSENTE, no como una huella débil, así que la fuente no cruza la puerta.

## Auditoría de los permisos de desarrollo: la licencia primero

Seis comprobaciones, las seis en verde, y en este orden porque una depende de la
anterior:

| Qué | Resultado |
|---|---|
| ficha del portal | **200**, 45 856 B, `sha256:a7b04755…a624e`. Publisher: Development Services |
| enlace exacto | la ficha enlaza "Issued approvals (2026)" → `…/approvals_issued_2026_datasd.csv`. **Copiado, no deducido** |
| **licencia** | **ODC PDDL 1.0**, declarada por el publicador en el campo *License* del conjunto de datos |
| robots, dos hosts | `data.sandiego.gov` → **404** (`sha256:40695cb6…1fbbd`) · `seshat.datasd.org` → **403** (`sha256:a824bc77…0d938`) |
| esquema | GET con `Range 0-8191`: **54 columnas**. Las 14 de la allowlist existen las 14 |
| tamaño y cadencia | HEAD 200, `Content-Length: 21 386 385`, ETag `"dbbd27a5…515e"`, `Last-Modified` Oct 2. Cadencia **diaria** declarada |

**La licencia es lo que enciende esta fuente, y no el robots.** Un 404 y un 403
sobre `robots.txt` son hallazgos: significan que no hay política publicada, no
que haya permiso. Lo que concede es la PDDL, que es una dedicación al dominio
público y está escrita y enlazada por el publicador en la ficha del propio
conjunto de datos. El pie del portal lleva además un `© 2002–2026 City of San
Diego. All rights reserved.` genérico: una concesión específica y escrita vence a
un aviso de plantilla.

El *texto* de la PDDL vive en `opendefinition.org`, que no está permitido en la
política de red, y no se ha pedido. Lo que se leyó es la declaración del
publicador, y eso es lo que se afirma — ni una palabra más.

### La discrepancia de tamaño, explicada y no ignorada

El portal declara 9.57 MB y el archivo mide 20.4 MB. No es otro archivo: la cifra
del portal está cacheada para los ficheros del año en curso, que crecen a diario.
Los tres de 2026 están desviados por el mismo factor (~2.12×) y **el de 2025, que
ya es definitivo, coincide** (27.86 declarados / 27.88 reales). Ese caso de
control es lo que convierte una discrepancia en una explicación. Lo que se valida
del archivo es su ETag y su `Content-Length` observados, nunca la cifra
renderizada.

### El diccionario no describe este fichero

El diccionario descargable nombra **21 campos en minúsculas y con otros nombres**
—`address_job`, `job_apn`, `lat_job`, `date_approval_issue`— mientras el archivo
trae 54 en mayúsculas. Se registra como hallazgo. La semántica se toma del
diccionario que el portal renderiza, con la correspondencia escrita en el
manifiesto, y el esquema del que depende el código es **la cabecera real**, que se
contrasta en cada descarga.

### Auditoría de CDE: qué se leyó y qué no

Cinco comprobaciones, cuatro en verde:

| Qué | Resultado |
|---|---|
| `robots.txt` | **200**, 1696 B, `sha256:7f85d836…f825`. Ninguna directiva de `User-agent: *` alcanza `/schooldirectory/report`; sin `Crawl-delay` |
| archivo oficial | la página de descarga del CDE enlaza exactamente `…/schooldirectory/report?rid=dl1&tp=txt`. La URL **se copió, no se dedujo** |
| esquema | `fspubschls.asp`, revisado el 2024-09-19: **46 columnas**. Las 20 de la allowlist existen las 20 |
| términos | `Conditions of Use` leídas: privacidad y responsabilidad, **sin** prohibición de reutilización, cláusula no comercial ni restricción de automatización |
| **licencia** | **no legible.** `GET /re/cr/` → 302 a `validate.perfdrive.com` (bot manager de Radware) |

**La allowlist declarada a ciegas estaba mal, y el esquema real lo demostró.**
Nombraba `Ext` (se llama `Phone Ext`, con espacio), una columna `Email` que no
existe, y `AdmFName1/2/3` + `AdmEmail1/2/3` donde el archivo trae `AdmFName` y
`AdmLName` en singular y ningún correo. Prohibir columnas inventadas no protege
nada: la lista de nunca-pedidos es ahora el complemento **exacto** de la
allowlist sobre las 46 columnas reales, y dentro están los datos de persona que
el archivo sí trae.

**Por qué sigue apagada.** Los términos que gobiernan este archivo se leyeron y
no restringen la reutilización; el `Data Disclaimer` del propio CDE incluso
nombra "contactar a la agencia" como el uso previsto. Lo que no se pudo leer es
la declaración de copyright del sitio, que es justo donde viviría el "salvo
indicación contraria" de la información estatal de California — y cada página
lleva un `© California Department of Education` en el pie, que es una afirmación
de copyright sin concesión adjunta. **No se intentó sortear el reto**: ni se
ejecutó su JavaScript ni se cambió la huella del cliente.

La preview real no necesita esa página, porque no escribe nada. Cargar Companies
sí.

### Dos cerrojos que ningún flag abre

La puerta mira el robots del publicador **antes** de mirar `enabled`, y lo hace
en dos direcciones:

- un robots que **prohíbe** la ruta bloquea aunque alguien ponga `enabled: true`
  (`robots_prohibe`). Esto está aquí porque pasó: el de `data.chhs.ca.gov`
  resultó legible y prohibía justo `/api/`, y por eso HCAI se retiró;
- un robots que **nadie ha leído** bloquea igual (`robots_sin_leer`). Fue el
  caso de CDE hasta que se leyó. "Desconocer no es permiso" estaba escrito en su
  manifiesto, y una frase en un JSON no detiene nada; ahora es un cerrojo.

Y uno más, en el propio scout: al descargar se contrasta la **cabecera real**
contra el esquema atestiguado. Si falta una columna de la allowlist, la corrida
se para — perder `Zip` significaría dejar de exigir dirección completa sin que
nadie se enterase. Una columna de más no para nada, porque la allowlist es
cerrada y se cae sola; se cuenta en la procedencia, y solo la cuenta: el nombre
de una columna sale del archivo igual que su contenido.

---

## Arquitectura: los scouts no conocen el CRM

    scout ──► staging sellado ──► capa central ──► plan Companies-only
    (red)      (hash, runId,       (valida,          (no ejecuta)
                caducidad)          deduplica,
                                    prioriza)

Ningún módulo de `src/prospecting/scouts/` importa el adaptador de Twenty, y hay
una prueba que lo comprueba recorriendo los archivos. La capa central tampoco:
recibe el índice del CRM **ya cargado** como parámetro. Esa separación es la que
hace que un scout nuevo no pueda escribir por error.

### Lo que produce un scout

Un archivo de staging y nada más. Sellado con:

- **hash** SHA256 sobre el contenido canónico — si alguien edita el archivo, la
  capa central lo rechaza;
- **runId** — dos corridas del mismo día son distinguibles y un informe puede
  citar cuál se usó;
- **createdAt + expiresAt** — caduca a las 6 h. Lo que se vio hace tres días no es
  lo que hay hoy, y escribir desde datos caducados es cómo se resucita una
  instalación que ya cerró;
- **sessionId** — solo se reutiliza desde la sesión que lo creó. El hash dice que
  el contenido no cambió; no dice que la autorización siga vigente.

### Lo que hace la capa central, en orden

1. **Valida** cada staging por separado: esquema, procedencia, privacidad,
   frescura y hash. Un staging que no valida se descarta **entero**; no se
   rescatan "las filas buenas" de un archivo que pudo ser alterado.
2. **Carga el índice del CRM una sola vez**, y si queda incompleto no continúa:
   con un índice a medias se crean duplicados.
3. **Deduplica** contra las Companies existentes y entre los tres staging.
4. **Planifica** creaciones de Companies. No ejecuta nada.

No muta el staging: los archivos se leen y se dejan como estaban.

### Prioridad cuando dos fuentes describen la misma entidad

Determinista y razonada. El criterio es **cuánto se puede verificar de la ficha
que quedaría**:

| Orden | Scout | Por qué |
|---|---|---|
| 1 | `cde_schools` | identificador oficial (CDSCode), dirección del centro y sitio web publicado por la fuente: la más completa |
| 2 | `ca_abc_active_licenses` | licencia activa con premisa física, tipo de establecimiento y dirección: el negocio **está operando hoy** |
| 3 | `city_development_permits` | permiso emitido con fecha, clasificación de edificación comercial y dirección de la obra: fechable y situable |
| 4 | `hud_multifamily` | propiedad institucional con dirección y número de unidades: situable, pero sin fecha de actividad |

Por encima de las tres, lo que ya está en el CRM: una Company existente **nunca se
modifica** desde aquí. El candidato se omite.

Un detalle que costó un bug: se comparan **las dos** claves de cada candidato
—nombre y nombre+dirección— no "la más específica que tenga". Una fuente que no
conserve dirección tiene como única firma el nombre; comparando solo la clave más
específica de cada uno, `harborviewelementary` nunca coincidiría con
`harborviewelementary|1200harborblvd`, y esa fuente habría duplicado cada entidad
que otra ya hubiera traído.

---

## Reglas y filtros, scout a scout

### 1 · CaliClean Commercial Development Permit Scout (City of San Diego)

**Fuente.** El CSV de aprobaciones **emitidas** del año en curso del conjunto
"Approvals for development projects" de Development Services. Una sola petición
GET por corrida, con `If-None-Match` e `If-Modified-Since`; un 304 no gasta la
ventana del día. El archivo (20.4 MB) se hashea entero, se lee en streaming desde
un temporal y **se borra siempre**: trae APN, latitud, longitud, número de cuenta
fiduciaria y número de plano.

**Seis condiciones, y las seis tienen que cumplirse:**

1. `APPROVAL_STATUS == 'Issued'` exacto. El fichero se llama "issued" porque las
   filas tienen fecha de emisión, pero el estado actual varía: en la corrida real
   había 17 228 filas en otros estados. Solo `Issued` significa "la ciudad dio
   permiso y la obra está viva".
2. **Emitido en los últimos 90 días**, medido contra `APPROVAL_ISSUE_DATE`. Para
   limpieza post-obra, un permiso de hace seis meses probablemente ya está
   terminado.
3. **Señal comercial explícita** en `JOB_BC_CODE_DESCRIPTION`, que es la
   clasificación de edificación del propio permiso — el campo que distingue una
   obra comercial de una vivienda, y no una adivinanza sobre el texto libre del
   alcance. `Add/Alt Tenant Improvements` (acondicionamiento de local) es el caso
   típico. **Una clasificación que no esté en la lista se rechaza, incluida la
   vacía:** sin señal no hay candidato, y en la corrida real eso descartó 8 738
   filas sin clasificación.
4. **Nada residencial ni ambiguo.** `residential`, `single-family`, `multifamily`,
   `apartment`, `condo`, `townhome`, `dwelling`, `SDU`, `ADU`, `JADU` y
   `companion unit` se buscan en la clasificación, en el alcance de la aprobación
   y del proyecto, en el título y en los tipos. Las dos clases que dicen
   "3+ Fam **or** NonRes" se rechazan como **uso mixto ambiguo**: el propio código
   no sabe cuál es, y no se interpreta a nuestro favor. Los permisos de rótulo se
   descartan por relevancia.
5. **Dirección completa.** `GIS_ADDRESS` llega a veces con el sufijo `[Pending]`,
   que significa que aún no está asignada; eso no es una dirección. Y se conserva
   **solo después** de la señal comercial.
6. **Titular inequívocamente empresarial.** Ver abajo: es la parte difícil.

**El titular es el campo peligroso.** El diccionario oficial lo define como
*"Contact name whom the Approval is issued to"* — un nombre de **contacto**, y en
el archivo real hay personas físicas. Así que no basta con que un nombre no
parezca una persona: hace falta una señal **positiva** de entidad, en dos niveles,
y el nivel por el que entró queda escrito en la evidencia del candidato:

- **nivel 1** — sufijo de forma jurídica (`LLC`, `Inc`, `Corp`, `Co`, `Ltd`, `LP`,
  `LLP`, `PC`, `Partnership`);
- **nivel 2** — designador de actividad empresarial inequívoco **y** ninguna forma
  de nombre de persona.

Y una tercera regla que **salió de la preview real**: si el nombre mezcla una
persona con una empresa —`Persona - Empresa`, `Empresa / Persona`,
`Persona/Empresa`— se rechaza entero. La primera versión de la regla no lo hacía,
y entre 50 candidatos aceptados había tres así: tenían sufijo legal o palabra de
actividad, pasaban, y habrían metido el nombre de alguien en el CRM como si fuera
el de una empresa. Esa preview se descartó por eso.

**Una empresa, una Company.** El mismo titular puede tener diez permisos; gana el
más reciente, y con fecha igual, el id más bajo. En la corrida real eso colapsó
131 filas.

**El archivo no viene ordenado por fecha**, así que no se puede cortar en el
candidato 50 leyendo de arriba: eso daría "los primeros del archivo", no "los más
recientes". Se recorre entero y se conservan los 50 más recientes, con el id como
desempate para que dos corridas sobre el mismo archivo den exactamente la misma
lista.

**Nunca** `GIS_APN`, `GIS_LATITUDE`, `GIS_LONGITUDE`, `PROJECT_TRUST_ACCOUNT_NO`
ni `JOB_DRAWING_NUMBER`. **Y ningún motivo de rechazo lleva dentro el valor de la
fila**: rechazar una fila y después escribir su contenido en el motivo es
registrarla.

**Clave:** `city-dev:<APPROVAL_ID>` + dedupe por nombre y por nombre+dirección.

**La ciudad no sale de una columna** —el archivo no la trae— sino del alcance del
conjunto de datos, que son los permisos de la Ciudad de San Diego, y la
procedencia lo dice con esas palabras.

### 2 · CaliClean Property & Manager Scout (HUD Multifamily)

**Consulta.** ArcGIS paginada con `returnGeometry=false` y `outFields` construido
con la allowlist: los campos de contacto y de persona **no se filtran después, es
que no se piden**. `orderByFields=PROPERTY_ID ASC`, porque sin orden estable la
paginación no es reproducible. Tope de páginas: un servicio que nunca diga que
acabó no puede dejar la corrida paginando para siempre.

Un error de ArcGIS llega **dentro de un 200**; tratarlo como página vacía sería
confundir un fallo con "no hay datos".

**Filtros.** `STD_ST == CA` · `TOTAL_UNIT_COUNT >= 5` · categoría no
single-family / vacant land / duplex · ciudad **o** ZIP en listas explícitas del
condado de San Diego · dirección completa y sin `Apt`/`Unit`/`PO Box`/`PMB`.

La Company representa la **propiedad** (`PROPERTY_NAME_TEXT`), no a una persona.
`MGMT_AGENT_ORG_NAME` sobrevive al staging solo si es una entidad inequívoca, y
viaja marcado **`managementAgentWritable: false`**: no hay campo seguro en el CRM
para un gestor y añadirlo sería cambiar el esquema del cliente.

**Clave:** `hud-mf:<PROPERTY_ID>` + dedupe por nombre+dirección normalizados.

### 3 · CaliClean Education & Childcare Facility Scout (CDE)

**Fuente.** El volcado público del directorio de escuelas del California
Department of Education (`pubschls`), delimitado por **tabuladores**. Es la vía de
descarga masiva que el propio directorio publica: no se raspa el buscador ni
ninguna página HTML. **Una sola petición GET por corrida**, con `If-None-Match` e
`If-Modified-Since`; un 304 no gasta la ventana del día.

El archivo se hashea entero, se lee en streaming desde un temporal y **se borra
siempre** (`finally`): trae nombre, apellido y **correo** de hasta tres
administradores por centro, más teléfono, fax y coordenadas. Nada de eso se
conserva en ningún sitio.

**Filtros.** `County == San Diego` · `StatusType == Active` · tiene que ser un
**centro**, no un distrito ni una oficina de condado (se descartan los
marcadores del volcado: `No Data`, `No School`, vacío) · no virtual (una escuela
virtual no tiene instalaciones que limpiar) · dirección comercial completa, con
ZIP de cinco dígitos y sin `Apt`/`Unit`/`PO Box`/`PMB`.

**Nada domiciliario, mire donde mire.** `Family Child Care Home`, `FCCH`,
`home-based`, `in-home` y `residence/residential` se buscan en el nombre, en
`SOCType`, en `DOCType`, en `EILName` **y** en la calle. Si algún día se añade una
fuente de cuidado infantil del CDSS, los Family Child Care Homes operan desde la
vivienda del titular: quedan fuera por definición, igual que cualquier tipo que no
se pueda afirmar institucional. Este scout solo acepta **centros**.

**Nunca** `AdmFName`, `AdmLName`, `Phone`, `Phone Ext`, `FaxNumber`,
`Latitude`, `Longitude` ni el bloque `Mail*` completo. La allowlist es
cerrada, así que una columna nueva con datos de una persona se cae **sin esperar a
que alguien la prohíba**.

`Website` **sí** se conserva: es el sitio oficial del centro tal como lo publica
la fuente. No se adivina, no se construye y no se visita.

**Clave:** `cde:<CDSCode>` + dedupe por nombre+dirección normalizados.

**Licencia: parcialmente verificada.** Ver la tabla de auditoría arriba. No se
asume dominio público mientras la declaración de copyright no sea legible.

**Y lo que la fuente publica no es un hecho verificado.** El propio CDE avisa de
que los centros autodeclaran estos datos voluntariamente y pueden estar
desactualizados o tener errores. Lo que se afirma del candidato es "esto es lo
que el directorio oficial publica hoy", no "esto es correcto".

---

### 4 · CaliClean ABC Active License Scout (California ABC)

**La fuente más limpia de la fase, y conviene decir por qué.** Es la única cuya
licencia es una concesión afirmativa del publicador: sus Conditions of Use dicen
que *"the information presented on this web site, unless otherwise indicated, is
considered in the public domain. It may be distributed or copied as permitted by
law."* Sin restricción comercial, sin exigencia de atribución, sin prohibición de
automatización. Se buscó lo contrario expresamente y no hay nada.

Y su `robots.txt` **sí se pronuncia**: `Disallow: /wp-admin/`, nada más. Lo que
prohíbe no es nuestra ruta. Eso es distinto de un 404 o un 403, que son hallazgos
y no permiso.

**Fuente.** El *Daily Data Export* en CSV, refrescado cada día hábil a las 7 a.m.
PT. Una sola petición GET por corrida, con GET condicional. **200 directo, cero
redirecciones** — la diferencia con CDPH, cuya descarga saltaba a
`s3.amazonaws.com`.

**Viene zipeado**, así que hay un paso más: 7.1 MB de ZIP que se inflan a 26.6 MB
de CSV. El lector de ZIP (`sources/zip-client.js`) no añade dependencias y toma
tres decisiones que importan:

- lee el **directorio central**, no el encabezado local, porque el local puede
  traer los tamaños a cero y un descriptor al final de los datos;
- comprueba el tope **contra lo que sale al inflar**, no solo contra lo que el ZIP
  declara: un ZIP de 7 MB puede anunciar poco y soltar 40 GB;
- borra los **dos** temporales siempre, el ZIP y el inflado.

**Seis condiciones.** Condado `SAN DIEGO` y estado de la premisa `CA` ·
`Type Status == ACTIVE` exacto · uno de **18 tipos de licencia con premisa fija**
relevante · dirección de premisa completa, sin PO Box ni PMB ni `APT` ·
`File Number` presente · nombre de negocio defendible.

**Los 18 tipos salen de la lista oficial de 85.** Dentro: restaurantes (41, 47),
bares (42, 48, 61), tiendas (20, 21), clubes (50, 51, 52), brewpubs (75), locales
de música (90), servicio restrictivo (70) y los estacionales de premisa fija.
Fuera: productores, importadores, mayoristas y corredores; todo lo móvil —trenes,
barcos, aviones—; lo temporal y de evento; los permisos de propósito especial; y
los **Bed and Breakfast Inn (67, 80), que pueden ser una vivienda** y son
ambiguos por definición.

**La Company es el NEGOCIO, no el titular.** El record layout oficial llama
`Primary Name` al titular de la licencia, y en este registro **hay personas
físicas**. Así que se prefiere el `DBA Name` —el nombre comercial— cuando no tiene
forma de nombre de persona, y el titular solo cuando es una entidad inequívoca. La
evidencia de cada candidato dice de cuál de los dos vino.

**Nunca** el bloque postal completo —`Mail Addr 1/2`, `Mail City`, `Mail State`,
`Mail Zip`—, que es donde aparece el domicilio del titular, ni `Prem Census
Tract #` ni `Geo Code`. El archivo **no trae** teléfono, correo ni coordenadas, y
eso se comprobó contra el record layout de 26 campos en vez de fingir un filtro
sobre campos que no existen.

**Dos quirks reales que las pruebas fijan.** La línea 1 **no es la cabecera**: es
un sello (`Updated Sunday 4th of October 2026 03:50:21 AM`), pese a que la página
oficial dice lo contrario; se salta y además se **conserva como procedencia**,
porque es la fecha que el dato declara de sí mismo. Y el archivo llega con **BOM**:
la primera preview real falló por eso —el parser veía un carácter y luego una
comilla en medio de un campo— y ahora se quita antes de parsear, con el fixture
reproduciendo el BOM a propósito.

**Clave:** `ca-abc:<File Number>` + dedupe por nombre y por nombre+dirección. El
mismo local puede tener dos licencias —una de cerveza y otra general— y eso no son
dos clientes: gana el expediente más bajo.

**Dos huellas en la procedencia**, no una: el ZIP tal como llegó y el CSV tal como
quedó al inflarse.

---

## Cuotas, guards y lock

Cada scout tiene lo suyo y no estorba a los demás ni a County/City:

- **tope de 50 candidatos válidos** por corrida — de candidatos aceptados, no de
  filas leídas, así que se deja de paginar al alcanzarlo;
- **una corrida con éxito cada 24 h**, cuota local con lock crash-safe;
- **guard durable derivado del CRM** por prefijo de clave (`city-dev:`, `hud-mf:`,
  `cde:`), con tolerancia de desfase de reloj: sin ella, un CRM dos segundos
  adelantado leería su propia marca como "fechada en el futuro" y bloquearía cada
  corrida para siempre;
- **lock global de fase**, porque dos orquestaciones a la vez leerían el mismo
  índice del CRM y podrían planificar dos veces la misma creación. Caduca a los 30
  min y, al romperlo, lo dice: un lock roto en silencio esconde que algo murió a
  medias.

### La grieta del reinicio de contenedor

Un staging sellado se ata a la sesión que lo creó: `boot_id` del contenedor. La
regla es que **una autorización no se hereda** — quien revisó una preview la
revisó en un proceso concreto, y el archivo en disco es lo único que queda
después.

Esa regla dejó un snapshot íntegro y vigente inservible: el contenedor se
reinició entre la revisión y la carga, el `boot_id` cambió, y la capa central
rechazó un documento cuyo hash cuadraba y cuyo TTL seguía corriendo.

`--allow-container-restart` abre una grieta **estrecha** en eso, y pide las
cuatro condiciones a la vez, todas aportadas por quien llama y no por el archivo:

| | Condición |
|---|---|
| a | el hash **recomputado del contenido** coincide con el hash **autorizado** (`--expect-hashes`), no con el que el archivo dice de sí mismo |
| b | el TTL sigue vigente |
| c | el `scoutId` y el `runId` son los esperados |
| d | la invocación pasa el flag explícitamente |

Si falta una, la sesión distinta sigue bloqueando, y el motivo dice **cuál**
faltó. Y la grieta perdona **solo eso**: un hash que no cuadra, un TTL vencido o
un documento de otra corrida siguen bloqueando igual, con flag o sin él.

La diferencia entre (a) y "el hash del archivo cuadra consigo mismo" es la que
importa: alguien puede añadir un candidato a mano **y recalcular el `sha256`**, y
entonces el archivo es coherente consigo mismo pero ya no es lo que se aprobó.
Hay una prueba para exactamente ese caso.

Cuando la grieta se usa, **se dice en el informe**: un override que no se ve es un
control que se perdió. La rutina diaria no lo pasa nunca, y hay una prueba que lo
comprueba.

## Lo que la sync central rechaza, antes de hacer nada

`People`/`Opportunities`/notas/mensajes/borrados · cualquier operación que no sea
crear · más de 50 por fuente · una fuente deshabilitada · constancia o cuota
vencida · un staging alterado · `OUTBOUND_ENABLED != false`.

El guard del outbound **lanza**: un guard que se pueda ignorar leyendo mal su
resultado no es un guard.

## Monitoreo

Informe por scout en stdout, con métricas separadas y **sin PII**. Alerta solo
ante `[ERROR]`/`[CRITICAL]` o un cambio significativo: filas traídas y ninguna
aceptada, `crm_writes` o `outbound` distintos de cero, errores, o un bloqueo que
no sea de cuota. Una corrida bloqueada por cuota **no alerta**: es el sistema
funcionando. Nada de email ni Slack: el push, si llega, será configuración de la
única Routine.

## Comandos

    npm run phase3:preview        # los scouts, en secuencia, sin escribir
    npm run phase3:plan           # capa central sobre los staging que haya

`apply` existe y está cerrado: exige `--confirm`, `--allow-writes`,
`--expect-hashes` y `TWENTY_WRITE_ENABLED=true`, y aun con los cuatro se detiene
explicando qué falta (egress, evidencia, `enabled`, preview revisada).

## Hosts

Permitidos y verificados desde este contenedor:

    egis.hud.gov
    seshat.datasd.org · data.sandiego.gov
    www.abc.ca.gov

    www.cde.ca.gov

`data.chhs.ca.gov` se retiró de la política al retirarse HCAI, y está comprobado
que ya no responde.
