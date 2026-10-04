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
