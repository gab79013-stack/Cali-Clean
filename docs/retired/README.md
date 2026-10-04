# Fuentes retiradas

Lo que está aquí **no es código activo**: son manifiestos y evidencia de fuentes
que se evaluaron y no se usan. Se conservan porque el motivo del rechazo es el
resultado más valioso de una auditoría, y borrarlo invita a que alguien vuelva a
evaluar la misma fuente desde cero dentro de seis meses.

Estos archivos están fuera de `config/`, así que ningún cargador los lee: no hay
manera de activarlos por accidente.

## `hcai_facilities` — HCAI/CDPH Licensed Healthcare Facility Listing

**Retirada el 2026-10-04.** Dos motivos, el primero decisivo:

1. **El `robots.txt` de `data.chhs.ca.gov` es legible y prohíbe la ruta.** Para
   `User-agent: *` incluye `Disallow: /api/` y `Disallow: /datastore/*`, que son
   exactamente los endpoints que el scout necesitaba. Los `Allow: /` del archivo
   son para bots de monitorización concretos (Siteimprove, LinkCheck, Jigsaw),
   no para nosotros. Es un **no explícito y legible**, no una ambigüedad: la
   licencia gobierna la reutilización del dato, el robots gobierna el método de
   acceso, y el publicador dijo que no.
   `sha256` del robots observado: `a7f31d58b1ed022652917abe6e77208bb44ea1bbe5017517c0c14ece6633b279`
2. **El catálogo no declara licencia.** El `package_show` devuelve `license_id`
   y `license_title` vacíos, así que la atribución CC-BY que la auditoría
   original daba por hecha no se pudo confirmar en la fuente.

Se hizo **una única** petición de metadata a ese host, al verificar egress y
antes de leer el robots. Al descubrir la prohibición se dejó de pedir cualquier
cosa. Para desbloquearla haría falta permiso del publicador o una vía de descarga
que su robots permita — no un cambio de configuración nuestro.

Sustituida por `cde_schools` (**CaliClean Education & Childcare Facility Scout**).

## Qué se retiró con ella

| Archivo aquí | Qué era |
|---|---|
| `hcai_facilities.manifest.json` | el manifiesto, fuera de `config/` para que ningún loader lo lea |
| `hcai.attestation.json` | la constancia, con su evidencia tal como quedó |
| `ckan-client.js.retired` | el cliente del DataStore CKAN. Era el único consumidor de esa API; se saca del árbol activo con la extensión cambiada para que no se importe por descuido |

También se eliminó `evaluateHcaiRow` de `src/prospecting/scouts/rules.js`. Las
reglas que valían para cualquier registro de instalaciones con licencia —estado
abierto, licencia presente, dirección institucional y no residencial— viven ahora
en `evaluateCdeRow`, aplicadas a centros educativos. Hay una prueba que comprueba
que nada del árbol activo importa el cliente ni llama a la regla retirada: borrar
código no sirve de nada si queda un `import` que lo resucite.

---

# `cslb_contractors` · CaliClean State License Scout

**Fuente:** descarga masiva de licencias de contratista del CSLB,
`https://web.cslb.ca.gov/onlineservices/dataportal/ContractorList`.

**Retirada como opción activa el 2026-10-04.** No por licencia ni por robots —los
dos estaban a favor— sino porque **el publicador no deja descargar**:

- La secuencia de postbacks de WebForms se verificó control por control: el GET
  entrega los tokens y la cookie de sesión, el primer postback
  (`__EVENTTARGET=ctl00$MainContent$ddlStatus`, valor `M`) renderiza la página del
  dataset con `MainContent_lbMasterCSV` presente, y el segundo
  (`__EVENTTARGET=ctl00$MainContent$lbMasterCSV`) debería entregar el CSV.
- Ese tercer paso devuelve **HTTP 403 "Request Rejected"** del WAF del portal.
  Support IDs registrados: `62fca6cc-97e3-411d-9157-f2390f21ccd5` y
  `a84ed006-6cbb-451a-843c-b5109044f13a`. Dos intentos, `evasionAttempted: false`.
- `robots.txt` de `web.cslb.ca.gov`: **404**, 1245 B,
  `sha256:dc1d54dab6ec8c00f70137927504e4f222c8395f10760b6beecfcfa94e08249f`. Sin
  política, lo que no es permiso; el permiso venía de que el portal publica esa
  descarga como su vía oficial de datos masivos.

**No se intenta sortear el WAF.** El remedio de un 403 con support ID es
preguntarle a CSLB, no cambiar la huella del cliente. Mientras no haya respuesta
o otra vía oficial, esta fuente no cuenta entre las utilizables.

| Archivo aquí | Qué era |
|---|---|
| `cslb_contractors.manifest.json` | el manifiesto, con la secuencia verificada y el 403 documentado |
| `cslb.attestation.json` | la constancia, con su evidencia tal como quedó |
| `webforms-client.js.retired` | el cliente de WebForms. Era su único consumidor; sale del árbol activo con la extensión cambiada para que no se importe por descuido |

Se eliminaron de `rules.js` `evaluateCslbRow` y `hasClassification`. La sustituye
`city_development_permits` (**CaliClean Commercial Development Permit Scout**),
que no comparte host, ni código de acceso, ni dato con ella.

---

# `cdph_healthcare_facilities` · auditada y BLOQUEADA, no implementada

**Fuente:** "Licensed and Certified Healthcare Facility Listing", CDPH, en el portal
de datos abiertos de CalHHS.
Ficha: `https://data.chhs.ca.gov/dataset/healthcare-facility-locations`
CSV oficial: `…/dataset/3b5b80e8-…/resource/f0ae5731-…/download/health_facility_locations.csv`

**Auditada el 2026-10-04. No se descargó el archivo, no se implementó scout y no
se escribió nada.** Dos bloqueos independientes, cualquiera de los dos bastaba.

## Bloqueo 1 · la descarga redirige a un host no permitido

`HEAD` sobre el CSV oficial devuelve **302** con

    location: https://s3.amazonaws.com/og-production-open-data-chelseama-…/
              resources/f0ae5731-…/health_facility_locations.csv?X-Amz-…

El host exacto es **`s3.amazonaws.com`** (URL prefirmada, `X-Amz-Expires=86400`).
No está permitido en la política de red y **no se añade**. El `.zip` hermano del
mismo conjunto redirige al mismo sitio, así que no hay vía alternativa dentro del
host auditado.

Esto no es un detalle de configuración: el cliente de esta arquitectura **ya
rechaza** ese caso por diseño (`REDIRECT_REJECTED`, "ese recurso no es el
auditado"), porque un recurso servido desde otro host no es el que se hasheó ni
el que la constancia describe. Era la misma trampa que mató a HCAI.

## Bloqueo 2 · la licencia no es Creative Commons Attribution

El encargo daba por hecha una CC-BY. **El portal no la declara en ningún sitio.**
Lo que dice, textual:

- caja de licencia de la ficha: **"License: No License Provided"**;
- metadata de la ficha, campo `License`: **"Terms of Use"**;
- `Limitations`: *"Use of this data is subject to the CHHS Terms of Use and any
  copyright and proprietary notices incorporated in or accompanying the
  individual files."*
- Términos del portal (`/pages/terms`, modificados 2023-01-27): conceden *"a
  non-exclusive, non-transferable, **revocable** license to use and distribute
  the Content"* con **atribución y cita obligatorias**. Es una licencia escrita,
  pero **revocable y sin nombre CC**: no es CC-BY.
- Y en la propia ficha se renderiza un bloque de términos que dice: *"Anyone
  desiring to use or reproduce the data without modification for a
  **noncommercial** purpose may do so without obtaining approval. **All
  commercial uses must be approved and may be subject to a license.**"*

Ese último punto es el que decide. Prospectar para vender limpieza comercial es un
uso comercial, y el publicador dice que requiere aprobación. **No se acepta ese
modal ni se asume la aprobación.** El remedio es pedírsela al CDPH por escrito.

Un detalle que conviene no leer mal: los Términos prohíben *"the promotion of
commercial ventures"*, pero esa cláusula está bajo **"Public Participation"** y
gobierna el módulo de comentarios y subida de contenido, **no** la reutilización
del dato descargado. No es esa la que bloquea.

## Lo que sí quedó verificado

| Qué | Resultado |
|---|---|
| egress a `data.chhs.ca.gov` | confirmado, 200 |
| `robots.txt` | **200**, 3071 B, `sha256:a7f31d58…b279`, byte por byte igual al leído el 2026-10-04 a las 15:26 |
| robots · ruta usada | `/dataset/<id>/resource/<id>/download/<f>.csv` **permitida por omisión** en el bloque `User-agent: *` (79 reglas). Nunca se tocó `/api/`, `/api/3/action`, `/datastore` ni `/datastore/dump`, que **sí** están prohibidas |
| autoridad | **CDPH**, programa *Center for Health Care Quality*; datos del sistema ELMS de licenciamiento. `Source Link` a `cdph.ca.gov/.../CalHealthFind/` |
| actualización | **mensual** (`Frequency: Monthly`). `Last Updated: September 16, 2026, 22:27 UTC` |
| URL exacta del CSV | confirmada desde la ficha oficial, copiada y no deducida |
| esquema | **no verificado**: habría exigido descargar, y la descarga está bloqueada |

## Huellas de la evidencia

| Artefacto | Bytes | sha256 |
|---|---|---|
| `robots.txt` | 3 071 | `a7f31d58b1ed022652917abe6e77208bb44ea1bbe5017517c0c14ece6633b279` |
| búsqueda del portal | 53 790 | `1dc0737cc3ddc6e48831d582e1dd86edb43b104880e59c47491e666eab9ae052` |
| ficha del conjunto de datos | 58 814 | `27621c784923ce2150c116ecd20a52bfe5fdd0ea0cb254465bb32dc0415ffc8a` |
| Terms of Use del portal | 65 776 | `b939eba71e90a322e2965db54db1bc95e2490eab9d69eb2995ca73d8080d5981` |
| cabeceras del `HEAD` al CSV | 1 202 | `da44fdb776a3922d22a0828cbb4a4fea1d3c840e3713f4e341220867288d8ac8` |

**raw: no existe.** No se descargó, así que no hay hash de datos y no se levanta
una constancia que afirme un esquema que nadie ha visto. La cuota de 24 h de esta
fuente sigue sin consumir.

## Para desbloquearla

1. Aprobación escrita del CDPH para uso comercial, o confirmación de que ese
   bloque de términos no aplica a este conjunto de datos; **y**
2. una vía de descarga que no redirija fuera del host auditado, o la decisión
   explícita de permitir `s3.amazonaws.com` — que es un host genérico de terceros,
   no el del publicador, y permitirlo abre mucho más que este archivo.

Mientras falte cualquiera de las dos, esta fuente no se implementa.
