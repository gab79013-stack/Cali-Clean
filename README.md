# Cali Clean · Máquina de leads

Sistema de generación de clientes para [cali-clean.net](https://cali-clean.net).

Tiene dos motores que alimentan el mismo CRM:

1. **Prospección outbound** — agentes que salen a buscar negocios en registros
   públicos de California, averiguan a quién escribir, cualifican, redactan y
   contactan. Es el motor principal.
2. **Captación inbound** — un widget de presupuesto instantáneo que se incrusta
   en la web y convierte visitas en leads. Es también el destino al que apuntan
   los correos en frío: el prospecto calcula su propio precio sin hablar con nadie.

---

## El motor outbound en una frase

Cinco agentes en cadena: uno **descubre** negocios en registros públicos, otro
**enriquece** visitando su web para encontrar el contacto real, otro **cualifica**
según el perfil de cliente ideal, otro **redacta** el correo con el dato concreto
que justifica escribir, y otro **contacta** y lo empuja todo al CRM.

```
registros públicos ──▶ descubrir ──▶ enriquecer ──▶ cualificar ──▶ contactar ──▶ CRM
  permisos de obra      clasifica     visita su web    puntúa ICP     redacta       webhook /
  licencias nuevas      y deduplica   busca el email   y valora       y encola      HubSpot / GHL
```

Cada etapa deja su resultado en la base, así que una corrida interrumpida se
retoma sola: los prospectos siguen donde se quedaron.

---

## Por qué está construido así

| Decisión | Motivo |
|---|---|
| Señales de intención, no listas compradas | Una obra que acaba de cerrarse necesita limpieza **esta semana**. Un negocio que acaba de abrir aún no tiene proveedor. Eso convierte; una lista fría no. |
| Solo correos que el negocio publica en su web | Los patrones adivinados (`info@`, `contacto@`) rebotan, y los rebotes queman el dominio. Si no publica correo, se descarta. |
| Se respeta `robots.txt` sin excepción | Un prospector que machaca la web de su futuro cliente no es un prospector. Si el sitio prohíbe el rastreo, el prospecto se descarta con ese motivo. |
| El CRM local es la fuente de verdad | Si el CRM externo se cae o cambia, la prospección no se detiene ni se pierde un contacto. Lo que no se sincroniza se reintenta. |
| Salvaguardas antes de **cada** correo, no al programar | Entre programar y enviar pasan días. Alguien pudo darse de baja en ese hueco. |
| Cuatro toques y se acaba | Insistir más a quien nunca pidió nada es lo que convierte una campaña en una denuncia de spam. |
| El texto lo escribe Claude, la estructura la fija la plantilla | El modelo personaliza; la plantilla garantiza el aviso de procedencia y la baja. Si el texto sale mal, se usa el determinista. |

---

## Puesta en marcha

```bash
cp .env.example .env     # rellena los datos reales del negocio
npm install
npm start                # API + paneles
npm run worker           # agentes y cola de correo (proceso aparte)
```

Con Docker: `docker compose up -d --build`.

### Arranque seguro, en este orden

1. **Deja `OUTBOUND_ENABLED=false`.** Los agentes prospectan y llenan el CRM,
   pero no sale ni un correo.
2. Lanza un ciclo desde `/prospects` y revisa a quién encontró y qué correo le
   habría escrito (la ficha de cada prospecto muestra el texto completo).
3. Ajusta el ICP en `src/prospecting/icp.js` y los precios en `src/config.js`.
4. Autentica el dominio: **SPF, DKIM y DMARC**. Sin esto, el outbound automático
   acaba en spam en una semana.
5. Pon `OUTBOUND_WARMUP_START_DATE` a la fecha de hoy y enciende
   `OUTBOUND_ENABLED=true`. El cupo empieza en 10 correos y sube 5 por día.

Comprueba el correo antes de nada: `node scripts/test-email.js tu@correo.com`.

---

## Las salvaguardas

En modo automático nadie revisa antes de que salga el correo, así que estas
comprobaciones corren **inmediatamente antes de cada envío**:

| Salvaguarda | Qué evita |
|---|---|
| Lista de supresión (correo y dominio) | Volver a escribir a quien se quejó |
| Comprobación de bajas, insensible a mayúsculas | Que una mayúscula suelta reabra la puerta a quien se dio de baja |
| Enfriamiento por dominio (90 días) | Dos correos a la misma empresa |
| Cupo diario con calentamiento progresivo | Quemar el dominio el primer día |
| Registro MX del destinatario | Rebotes que dañan la reputación |
| Franja horaria de envío | Correos a las 3 de la mañana |
| Umbral mínimo de ICP | Escribir a quien nunca va a comprar |
| Interruptor general (`OUTBOUND_ENABLED`) | Todo, de golpe, desde el panel |

Dos de ellas **aplazan** en vez de descartar: el cupo agotado y el interruptor
general. Apagar el sistema no destruye la cola.

Cada correo lleva enlace de baja, cabecera `List-Unsubscribe` de un clic,
dirección física y una línea que explica por qué lo recibe. Darse de baja
cancela la secuencia en el acto.

---

## Panel de prospección

`/prospects` (usuario y clave de `.env`):

- Embudo por etapa y **por qué se descarta** cada prospecto, en castellano
- Ficha con la evidencia: qué páginas se leyeron, qué coincidió para verificar
  que la web es de ese negocio, qué correos se encontraron
- El desglose del ICP, punto por punto
- **El correo redactado, antes de enviarse**
- El JSON exacto que recibe el CRM
- Botón de ciclo completo o etapa suelta, e interruptor general en caliente

`/admin` es el panel de leads: pipeline, conversión, aperturas y clics, notas,
export CSV. Inbound y outbound conviven ahí.

---

## Fuentes de datos

Portales de datos abiertos de California (Socrata), consultables por API sin
credenciales:

| Clave | Qué trae | Señal |
|---|---|---|
| `la_building_permits` | Permisos de obra cerrados en Los Ángeles | Obra terminada: limpieza inminente |
| `la_active_businesses` | Licencias de negocio nuevas en Los Ángeles | Acaba de abrir: sin proveedor fijo |
| `sf_building_permits` | Permisos completados en San Francisco | Obra terminada |
| `sf_registered_businesses` | Negocios registrados en San Francisco | Acaba de abrir |

Añadir una ciudad es añadir una entrada en `src/prospecting/sources/index.js`
con su dataset y el mapeo de campos. El resto del pipeline no cambia.

**Límite honesto:** los registros públicos dan nombre y dirección, nunca web ni
correo. El agente enriquecedor deduce el dominio del nombre del negocio, lo
verifica contra la página (nombre + teléfono, ZIP o dirección) y solo entonces
lee el correo publicado. Funciona bien con negocios cuyo dominio se parece a su
nombre, y falla con los que no. En las pruebas, de 5 prospectos descubiertos se
enriquecieron 2 — esa proporción es la realidad del método, no un error.
Si en algún momento quieres más cobertura, la Google Places API cubre
exactamente ese hueco y el conector encaja donde están los demás.

---

## El perfil de cliente ideal

`src/prospecting/icp.js` define los cinco segmentos que persiguen los agentes,
con su peso, cómo se reconocen (palabras clave y códigos NAICS), cuánto vale un
cliente de ese tipo y con qué argumento se le abre la conversación:

administradores de propiedades · consultorios y oficinas · restaurantes y
locales · anfitriones de rentas cortas · contratistas al cerrar obra

Es el archivo que se toca para cambiar a quién se persigue.

---

## Conectar el CRM real

El sistema trae su propio CRM (base de datos + panel), y además puede alimentar
el que ya tengas. **Si no sabes cuál tienes instalado, lo detecta solo:**

```bash
node scripts/crm.js detect https://tu-crm.com   # dice cuál es y qué configurar
node scripts/crm.js status                      # ¿falta algún dato?
node scripts/crm.js test                        # crea un lead de prueba real
```

Adaptadores nativos: **EspoCRM, SuiteCRM, Perfex, Vtiger** (los que instala
Hostinger con un clic), **HubSpot** y **Go High Level**. Para cualquier otro, el
genérico:

```ini
CRM_DRIVER=webhook          # POST firmado con HMAC-SHA256 a tu URL
CRM_WEBHOOK_URL=https://...
CRM_WEBHOOK_SECRET=...
```

Cada lead llega al CRM con una nota que explica **por qué** está ahí: precio
estimado, valor anual del contrato, la puntuación desglosada punto por punto y
—si vino de prospección— la señal que lo activó y de dónde salió su correo. El
payload completo está en `src/services/crm.js` (`toPayload`) y se puede ver en
la ficha de cualquier prospecto.

Los leads del widget también se sincronizan (`CRM_SYNC_INBOUND=true`), para que
el equipo no trabaje en dos sitios.

## Despliegue

`deploy/HOSTINGER.md` tiene los pasos exactos. En un VPS:

```bash
bash deploy/install-vps.sh crm.cali-clean.net tu@correo.com
```

Deja funcionando la API, los dos paneles y el worker de agentes, detrás de nginx
con SSL renovado solo, cada uno con su usuario sin privilegios.

**Un cliente por instalación, aislados:**

```bash
bash deploy/new-client.sh acme "Acme Cleaning" crm.acme.com tu@correo.com
```

Carpeta, base de datos, `.env`, usuario, servicios y dominio propios. No
comparten datos ni reputación de remitente.

---

## Captación inbound

Se incrusta en la web actual con una línea:

```html
<div id="cali-quote"></div>
<script src="https://leads.cali-clean.net/embed.js" data-target="#cali-quote" async></script>
```

O como botón flotante en todas las páginas: `data-mode="button"`. Va en Shadow
DOM, así que los estilos del sitio no pueden romperlo. Recuerda añadir el
dominio a `CORS_ORIGINS`.

La landing de `/` trae el widget montado y sirve como destino de los correos en
frío y de campañas de pago.

---

## Configurar precios

Todo el pricing está en `src/config.js`, objeto `pricing`. **Son estimaciones de
mercado, no los precios de Cali Clean**: ajústalos antes de publicar. Cambiar un
número ahí se refleja a la vez en el widget, en los correos y en el cálculo del
valor de cada prospecto.

---

## Estructura

```
src/
  config.js               configuración, tarifas y ajustes de outbound
  db.js                   esquema SQLite y migraciones
  server.js / worker.js   API y proceso de agentes
  prospecting/
    icp.js                perfil de cliente ideal
    guards.js             salvaguardas de envío
    http.js               cliente HTTP con robots.txt y ritmo
    pipeline.js           orquestador de las cinco etapas
    sources/              registros públicos
    agents/               discover · enrich · qualify · write · outreach
  services/               presupuesto, scoring, correo, Sender, CRM, secuencias
  templates/              14 plantillas de correo, bilingües
public/
  prospects.html          panel de prospección
  admin.html              panel de leads
  embed.js                widget embebible
  index.html              landing
test/                     75 tests
```

```bash
npm test                              # suite completa
node scripts/preview-emails.js        # ver los correos antes de enviarlos
node scripts/seed.js 30               # datos de ejemplo
```

---

## Qué falta por decidir

1. **Qué CRM hay en Hostinger** — `node scripts/crm.js detect <url>` lo dice.
   Si es uno de los siete soportados, solo hay que rellenar el `.env`.
2. **Precios reales** en `src/config.js`.
3. **Datos del negocio**: teléfono, dirección física, ZIPs y enlace de reserva.
4. **Credenciales de Sender** (SMTP o API) y autenticación del dominio.
5. **Revisar el ICP y los primeros correos** antes de encender el outbound.
