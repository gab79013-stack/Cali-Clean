# Fase 3 · Los tres scouts

**Estado, fuente a fuente.** De tres candidatas, una pasó:

| Scout | Estado | Por qué |
|---|---|---|
| CaliClean Property & Manager Scout (HUD) | **ENABLED** | robots inexistente, API pública, esquema verificado en vivo desde Cloud |
| CaliClean State License Scout (CSLB) | `BLOCKED_BY_PUBLISHER` | la secuencia de descarga existe y se verificó control por control, pero el WAF del portal la rechaza con 403 |
| CaliClean Education & Childcare Facility Scout (CDE) | `UNVERIFIED_DISABLED` | su host no está permitido: no se han podido leer licencia, términos, robots ni esquema |

`CaliClean Commercial Facility Scout` (HCAI/CDPH) fue **retirada** y sustituida
por la de centros educativos. El expediente está en `docs/retired/`.

County y City no se tocaron: siguen habilitadas, con su Routine y su comando.

---

## Hosts y recursos exactos

| Scout | Host | Recurso exacto |
|---|---|---|
| CaliClean State License Scout | `web.cslb.ca.gov` | `/onlineservices/dataportal/ContractorList` (descarga WebForms) |
| CaliClean Property & Manager Scout | `egis.hud.gov` | `/arcgis/rest/services/gotit/MultifamilyProperties/MapServer/0/query` |
| CaliClean Education & Childcare Facility Scout | `www.cde.ca.gov` | `/schooldirectory/report?rid=dl1&tp=txt` (volcado TSV) |

Los dos primeros están permitidos y verificados desde este contenedor. El
tercero **no**: `www.cde.ca.gov` da `CONNECT tunnel failed, response 403`. Hasta
que lo esté, su evidencia declara `evidencePending: true` y
`liveVerifiedFromCloud: false`, y **eso invalida la attestation a propósito**:
una fuente cuya evidencia nadie ha podido comprobar no cruza la puerta. Un
`sha256` de ceros se trata como evidencia AUSENTE, no como una huella débil.

### Dos cerrojos que ningún flag abre

La puerta mira el robots del publicador **antes** de mirar `enabled`, y lo hace
en dos direcciones:

- un robots que **prohíbe** la ruta bloquea aunque alguien ponga `enabled: true`
  (`robots_prohibe`). Esto está aquí porque pasó: el de `data.chhs.ca.gov`
  resultó legible y prohibía justo `/api/`, y por eso HCAI se retiró;
- un robots que **nadie ha leído** bloquea igual (`robots_sin_leer`). Es el caso
  de CDE hoy. "Desconocer no es permiso" estaba escrito en su manifiesto, y una
  frase en un JSON no detiene nada; ahora es un cerrojo.

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
| 2 | `hud_multifamily` | propiedad institucional con dirección y número de unidades: situable |
| 3 | `cslb_contractors` | licencia de contratista **sin dirección**: no se puede situar, así que pierde |

Por encima de las tres, lo que ya está en el CRM: una Company existente **nunca se
modifica** desde aquí. El candidato se omite.

Un detalle que costó un bug: se comparan **las dos** claves de cada candidato
—nombre y nombre+dirección— no "la más específica que tenga". CSLB no conserva
dirección, así que su única firma es el nombre; comparando solo la clave más
específica de cada uno, `harborviewelementary` nunca coincidiría con
`harborviewelementary|1200harborblvd`, y CSLB habría duplicado cada entidad
que otra fuente ya hubiera traído.

---

## Reglas y filtros, scout a scout

### 1 · CaliClean State License Scout (CSLB)

**Descarga.** No hay URL estable: hay un formulario con estado, y **la secuencia
es la autorización**. GET de la página para leer sus tokens → postback
seleccionando `M` (License Master) → postback sobre `lbMasterCSV` → `text/csv`
con adjunto `MasterLicenseData.csv`. Los tokens se renuevan en cada postback;
reutilizar los viejos hace que el portal responda una página de error en lugar
del CSV.

Cuatro negativas, cada una comprobada por una prueba:

- **un redirect se rechaza** — la descarga verificada entrega el CSV
  directamente, así que un 302 lleva a un recurso que nadie auditó;
- **HTML en vez de CSV se rechaza** — parsear una página de error como datos
  sería inventar filas;
- **un adjunto que no es el esperado se rechaza**;
- **no se raspea nada** — ni buscadores de licencias individuales, ni otras
  páginas del portal.

**Filtros.** `County == San Diego` · `PrimaryStatus == CLEAR` · `BusinessType` solo
`Corporation` o `Limited Liability` (valores exactos observados; una variante
exige fixture y documentación) · `Classifications(s)` contiene **`B` como token
exacto**.

> El guion **no** separa. `B` es General Building y `B-2` es Residential
> Remodeling: otra clase, y además apunta a vivienda. Partir por cualquier
> carácter no alfanumérico convertía `B-2` en `["B","2"]` y aceptaba como clase B
> a un contratista que no la tiene.

**Lo que se conserva:** `LicenseNo`, nombre comercial no personal, `BusinessType`,
`PrimaryStatus`, `SecondaryStatus`, `Classifications(s)`, `LastUpdate`, `sourceUrl`
y `verifiedAt`. **Nunca** dirección, teléfono, personas, bonds, workers comp,
pólizas ni la fila cruda — ni en el staging, ni en un log, ni en el texto de un
error. El volcado se borra al terminar en un `finally`.

**Clave:** `cslb:<LicenseNo>`. Dedupe cruzado adicional por nombre normalizado,
porque esta fuente **no conserva dirección a propósito**.

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

**Nunca** `Phone`, `Ext`, `FaxNumber`, `Email`, `AdmFName*`, `AdmLName*`,
`AdmEmail*`, `Latitude`, `Longitude` ni los campos `Mail*`. La allowlist es
cerrada, así que una columna nueva con datos de una persona se cae **sin esperar a
que alguien la prohíba**.

`Website` **sí** se conserva: es el sitio oficial del centro tal como lo publica
la fuente. No se adivina, no se construye y no se visita.

**Clave:** `cde:<CDSCode>` + dedupe por nombre+dirección normalizados.

**Licencia: NO verificada.** No se asume dominio público. La información estatal
de California lo es "salvo indicación contraria", y la indicación contraria es
justo lo que hay que ir a leer — y para leerla hace falta el host.

---

## Cuotas, guards y lock

Cada scout tiene lo suyo y no estorba a los demás ni a County/City:

- **tope de 50 candidatos válidos** por corrida — de candidatos aceptados, no de
  filas leídas, así que se deja de paginar al alcanzarlo;
- **una corrida con éxito cada 24 h**, cuota local con lock crash-safe;
- **guard durable derivado del CRM** por prefijo de clave (`cslb:`, `hud-mf:`,
  `cde:`), con tolerancia de desfase de reloj: sin ella, un CRM dos segundos
  adelantado leería su propia marca como "fechada en el futuro" y bloquearía cada
  corrida para siempre;
- **lock global de fase**, porque dos orquestaciones a la vez leerían el mismo
  índice del CRM y podrían planificar dos veces la misma creación. Caduca a los 30
  min y, al romperlo, lo dice: un lock roto en silencio esconde que algo murió a
  medias.

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

    npm run phase3:preview        # los tres scouts, en secuencia, sin escribir
    npm run phase3:plan           # capa central sobre los staging que haya

`apply` existe y está cerrado: exige `--confirm`, `--allow-writes`,
`--expect-hashes` y `TWENTY_WRITE_ENABLED=true`, y aun con los cuatro se detiene
explicando qué falta (egress, evidencia, `enabled`, preview revisada).

## Hosts

Permitidos y verificados desde este contenedor:

    web.cslb.ca.gov
    egis.hud.gov

Pendiente, y es el único que falta para poder auditar CDE de verdad:

    www.cde.ca.gov

Mientras no esté, CDE se queda `UNVERIFIED_DISABLED`. No se ha editado la
política de red: ese cambio es del usuario.
