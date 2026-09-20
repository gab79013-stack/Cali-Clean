# Cali Clean · Máquina de leads

Sistema completo de captación y conversión de clientes para
[cali-clean.net](https://cali-clean.net): presupuesto instantáneo, puntuación
automática de leads y secuencias de correo bilingües sobre **Sender** (SMTP o API).

No sustituye a la web actual: se **incrusta** en ella con una línea de código.

---

## Qué hace, en una frase

Un visitante configura su limpieza en 30 segundos, **ve el precio al instante**,
deja su correo para bloquearlo, y a partir de ahí el sistema le escribe solo
—en su idioma— hasta que reserva o pide la baja, mientras el equipo recibe cada
lead ya puntuado y ordenado por el dinero que representa.

---

## Por qué está construido así

| Decisión | Motivo |
|---|---|
| El precio se muestra **antes** de pedir el correo | La causa nº1 de abandono en limpieza es "no sé cuánto cuesta". Dar el número primero convierte al visitante en lead. |
| Widget embebible con Shadow DOM | Funciona sobre WordPress, Wix, Squarespace o HTML plano sin rehacer la web ni pelearse con sus estilos. |
| Lead scoring con razones visibles | Un equipo pequeño no puede llamar a todos. El panel ordena por valor anual estimado y explica el porqué. |
| Secuencias distintas para hogar y negocio | Una oficina decide en semanas y con números; una casa decide en días y con confianza. |
| SQLite en un archivo | Un negocio de servicios no genera el volumen que justifica un Postgres. Un archivo se respalda copiándolo. |
| Bilingüe ES/EN de origen | En California duplica el mercado alcanzable sin duplicar el trabajo. |

---

## Puesta en marcha

```bash
cp .env.example .env     # rellena los datos reales del negocio
npm install
npm start                # http://localhost:3000
```

Con Docker:

```bash
cp .env.example .env
docker compose up -d --build
```

### Lo mínimo que hay que rellenar en `.env`

```ini
APP_URL=https://leads.cali-clean.net     # dominio donde corre esto
BUSINESS_PHONE=+1 (310) 555-0123
BUSINESS_ADDRESS=...                     # obligatorio por CAN-SPAM
BOOKING_URL=https://cali-clean.net/contact
SERVICE_ZIPS=90001,90012,...             # ZIPs donde sí se da servicio

MAIL_DRIVER=smtp
SMTP_USER=...                            # credenciales SMTP de Sender
SMTP_PASS=...
MAIL_FROM_EMAIL=hello@cali-clean.net

ADMIN_PASS=...                           # clave del panel
APP_SECRET=...                           # cadena larga aleatoria
```

Comprueba que el correo sale antes de publicar nada:

```bash
node scripts/test-email.js tu@correo.com es
```

---

## Cómo se conecta a cali-clean.net

Pega esto donde quieras el formulario (una página nueva "Presupuesto", o la home):

```html
<div id="cali-quote"></div>
<script src="https://leads.cali-clean.net/embed.js" data-target="#cali-quote" async></script>
```

Botón flotante en **todas** las páginas del sitio (recomendado además del anterior):

```html
<script src="https://leads.cali-clean.net/embed.js" data-mode="button" async></script>
```

Opciones del `<script>`:

| Atributo | Valores | Para qué |
|---|---|---|
| `data-target` | selector CSS | Dónde incrustar el widget |
| `data-mode` | `inline` · `button` | En la página, o botón flotante con ventana |
| `data-locale` | `es` · `en` | Forzar idioma (por defecto detecta el del navegador) |
| `data-api` | URL | Solo si la API vive en otro dominio |

Añade el dominio de la web a `CORS_ORIGINS` en `.env`, o el navegador bloqueará los envíos.

La landing propia en `/` ya trae el widget montado y sirve para campañas de
Google Ads, Meta o el enlace del perfil de Google Business.

---

## El recorrido de un lead

```
Widget (6 pasos, ~30 s)
   └─> POST /api/leads
         ├─ presupuesto calculado y guardado
         ├─ score 0-100 + temperatura (hot/warm/cold)
         ├─ correo instantáneo al cliente con su precio
         ├─ aviso al equipo con el score y el porqué
         ├─ alta como suscriptor en Sender (si está activado)
         └─ secuencia programada según segmento
```

**Secuencia residencial:** cotización → 2 h → día 1 (prueba social) → día 3
(15 % de descuento, 48 h) → día 7 (contenido útil) → día 14 (cierre) → día 45
(reactivación).

**Secuencia comercial:** cotización → 20 h (propuesta con cifras anuales) →
día 4 (objeción de precio) → día 8 → día 15 → día 45.

La automatización **se detiene sola** cuando el lead reserva, se marca como
ganado o perdido, o pide la baja. Los envíos respetan la franja horaria
configurada (`SEQUENCE_SEND_FROM`/`TO`), salvo la cotización inicial, que sale
siempre al instante.

Previsualiza los 20 correos antes de que los vea nadie:

```bash
node scripts/preview-emails.js && open preview/index.html
```

---

## Panel de control

`https://leads.cali-clean.net/admin` (usuario y clave de `.env`).

- Leads ordenados por score, con el motivo de cada punto
- Pipeline por visita y **valor anual potencial**
- Filtros por estado, temperatura, segmento y búsqueda libre
- Ficha con historial de correos (enviado / abierto / clic) y secuencia programada
- Cambio de estado, notas internas y exportación a CSV
- `/api/admin/health` para verificar SMTP y ver correos fallidos

---

## Configurar precios

Todo el pricing vive en `src/config.js`, en el objeto `pricing`: base, precio
por dormitorio y por baño, tarifa por pie cuadrado, multiplicadores por tipo de
servicio, descuentos por frecuencia y catálogo de extras. **Ajústalos a los
precios reales de Cali Clean antes de publicar**: son estimaciones de mercado,
no los tuyos.

Cambiar un número ahí se refleja a la vez en el widget, en los correos y en el
cálculo del valor anual.

---

## Sender: SMTP o API

| Modo | `MAIL_DRIVER` | Cuándo usarlo |
|---|---|---|
| SMTP | `smtp` | Recomendado. `smtp.sender.net:587`, usuario y clave de Sender. |
| API REST | `api` | Si prefieres la API transaccional. Ajusta `SENDER_TRANSACTIONAL_PATH` a la ruta de tu cuenta. |
| Consola | `log` | Desarrollo: no envía nada, escribe en pantalla. |

Con `SENDER_SYNC_SUBSCRIBERS=true`, cada lead entra además como suscriptor en
Sender con campos personalizados (`quote_price`, `annual_value`, `lead_score`,
`segment`, `frequency`, `zip`…), lo que permite montar campañas segmentadas
desde el panel de Sender sin tocar código. Los IDs de grupo se configuran en
`SENDER_GROUP_*`.

---

## Protección del formulario

- Campo trampa invisible: descarta bots sin molestar a nadie
- Límite de envíos por IP y hora (`RATE_LIMIT_PER_HOUR`)
- Rechazo de correos con formato inválido y de dominios desechables
- CORS restringido a los dominios que configures
- Envíos anormalmente rápidos **se guardan igual** y se marcan en el registro:
  perder un cliente real cuesta más que revisar un registro dudoso

---

## Cumplimiento

Enlace de baja en todos los correos comerciales, cabecera `List-Unsubscribe`
con baja en un clic, dirección física en el pie y parada automática de las
secuencias al darse de baja.

---

## Estructura

```
src/
  config.js             configuración y tarifas
  db.js                 esquema SQLite
  server.js / worker.js  API y procesador de secuencias
  routes/               captura, tracking, panel
  services/             presupuesto, scoring, correo, Sender, secuencias
  templates/            10 plantillas de correo, bilingües
public/
  embed.js              widget embebible
  index.html            landing de campañas
  admin.html            panel de leads
scripts/                pruebas de correo, datos de ejemplo, previsualización
test/                   21 tests
```

```bash
npm test                        # suite completa
node scripts/seed.js 30         # leads de ejemplo para ver el panel
```

---

## Qué falta por decidir

1. **Precios reales** — los de `src/config.js` son estimaciones de mercado.
2. **Datos del negocio** — teléfono, dirección, ZIPs y enlace de reserva.
3. **Credenciales de Sender** — SMTP o token de API.
4. **Testimonios reales** — la landing lleva textos de ejemplo; sustitúyelos por
   reseñas verdaderas de Google, con nombre y foto si es posible.
