# Desplegar el CRM en Hostinger

El CRM ya está construido: base de datos, panel de leads, panel de prospección,
API y los agentes. Esto es solo ponerlo en tu servidor.

---

## Antes de empezar: qué plan tienes

Hostinger vende cosas muy distintas bajo el mismo panel. Míralo en **hPanel →
arriba a la izquierda** y sigue la sección que te toque.

| Lo que ves en hPanel | Qué es | Sirve para esto |
|---|---|---|
| **VPS** (con IP propia y acceso SSH como root) | Servidor entero | ✅ Sí, es lo ideal |
| **Cloud Hosting** | Compartido con más recursos | ⚠️ Solo si tiene Node.js |
| **Web Hosting / Premium / Business** | Compartido | ⚠️ Ver la nota del final |

---

## Opción A · VPS (recomendado)

### 1. Apunta un subdominio al servidor

En hPanel → **Dominios → Zona DNS** de `cali-clean.net`, añade:

```
Tipo: A     Nombre: crm     Apunta a: <la IP de tu VPS>     TTL: 3600
```

Eso crea `crm.cali-clean.net`. Espera unos minutos a que propague.

> Se usa un subdominio aparte a propósito: el CRM no debe compartir servidor ni
> certificado con la web pública, y así puedes moverlo sin tocar cali-clean.net.

### 2. Entra por SSH

En hPanel → **VPS → Acceso SSH** está la IP y el usuario. Desde tu terminal:

```bash
ssh root@<IP-de-tu-VPS>
```

### 3. Lanza el instalador

```bash
curl -fsSL https://raw.githubusercontent.com/gab79013-stack/Cali-Clean/claude/amazing-davinci-vm73zy/deploy/install-vps.sh -o install.sh
bash install.sh crm.cali-clean.net tu@correo.com
```

Tarda unos 3 minutos. Instala Node 22, clona el repo, crea un usuario sin
privilegios para la app, levanta dos servicios (`caliclean` y
`caliclean-worker`), configura nginx, saca el certificado SSL y cierra el
cortafuegos.

**Al terminar te imprime la clave del panel** y la guarda en
`/root/caliclean-admin-password.txt`. Guárdala donde guardes las demás.

### 4. Rellena los datos reales

```bash
nano /opt/caliclean/.env
```

Lo mínimo:

```ini
BUSINESS_PHONE=+1 (XXX) XXX-XXXX
BUSINESS_ADDRESS=...            # obligatorio por CAN-SPAM en el pie de cada correo
BOOKING_URL=https://cali-clean.net/contact
SERVICE_ZIPS=90001,90012,...    # dónde sí dais servicio
CORS_ORIGINS=https://cali-clean.net,https://www.cali-clean.net

MAIL_DRIVER=smtp
SMTP_USER=...                   # credenciales SMTP de Sender
SMTP_PASS=...
MAIL_FROM_EMAIL=hello@cali-clean.net
```

Y reinicia:

```bash
systemctl restart caliclean caliclean-worker
```

### 5. Comprueba que vive

```bash
systemctl status caliclean caliclean-worker
journalctl -u caliclean-worker -f          # log de los agentes en vivo
```

- Panel de leads: `https://crm.cali-clean.net/admin`
- Panel de prospección: `https://crm.cali-clean.net/prospects`

Prueba el correo antes que nada:

```bash
cd /opt/caliclean && node scripts/test-email.js tu@correo.com
```

### 6. Enciende el outbound (solo cuando estés listo)

1. Lanza un ciclo desde `/prospects` con el outbound **apagado**.
2. Abre varias fichas y lee el correo que habría enviado.
3. Autentica el dominio en la zona DNS: **SPF, DKIM y DMARC** (Sender te da los
   registros exactos). Sin esto, el outbound automático acaba en spam.
4. En `.env`: `OUTBOUND_ENABLED=true` y `OUTBOUND_WARMUP_START_DATE=<hoy>`.
5. `systemctl restart caliclean-worker`.

El cupo empieza en 10 correos al día y sube 5 cada día hasta el tope.

### Actualizar más adelante

```bash
cd /opt/caliclean && git pull && npm install --omit=dev
systemctl restart caliclean caliclean-worker
```

El `.env` y la base de datos (`/opt/caliclean/data/leads.db`) no se tocan.

### Copia de seguridad

Toda la base es un archivo. Para respaldarla a diario:

```bash
echo '0 3 * * * sqlite3 /opt/caliclean/data/leads.db ".backup /root/backup-crm-$(date +\%u).db"' | crontab -
```

---

## Opción B · Cloud Hosting con Node.js

En hPanel → **Avanzado → Node.js**. Si aparece, se puede:

1. Crear una aplicación Node: versión **22**, carpeta `caliclean`, archivo de
   arranque `src/server.js`.
2. Subir el repo por Git o FTP a esa carpeta.
3. Poner las variables de `.env.example` en el panel de variables de entorno.
4. `npm install --omit=dev` desde el terminal del panel.

**La pega:** en hosting compartido no hay servicios systemd, así que el worker
de agentes no corre en segundo plano de forma fiable. Alternativa: deja
`WORKER_DISABLED` sin poner (la API ejecuta la cola de correo por su cuenta) y
añade un cron en hPanel → **Avanzado → Trabajos cron** que dispare el pipeline
cada hora:

```
0 * * * * curl -s -u admin:TU_CLAVE -X POST https://crm.cali-clean.net/api/prospecting/run
```

---

## Opción C · Web Hosting compartido sin Node.js

No sirve para esto. El CRM es una aplicación Node con un proceso de fondo, y el
hosting compartido básico de Hostinger solo sirve PHP.

Dos salidas:

- **Subir a VPS** (el KVM 1 de Hostinger sobra: ~4-5 €/mes). Es lo que
  recomiendo, y el instalador de la opción A lo deja funcionando en 3 minutos.
- **Dejar el CRM en otro sitio** (Railway, Render, Fly.io tienen capa gratuita o
  barata) y apuntar `crm.cali-clean.net` ahí con un CNAME. La web de Cali Clean
  se queda en Hostinger sin tocarla.

---

## Ya tienes un CRM instalado: identifícalo sin abrir nada

No hace falta sustituirlo. Este sistema puede **alimentarlo**.

Si no sabes cuál es, el detector lo averigua solo. Desde tu ordenador o desde el
VPS, con el repo clonado:

```bash
node scripts/crm.js detect https://tu-crm.com
```

Prueba las huellas de cada producto y te dice cuál es, con qué confianza y qué
poner en el `.env`. Funciona también si el CRM está en un subdirectorio
(`tudominio.com/crm`), que es lo habitual cuando se instala desde hPanel.

Reconoce **EspoCRM, SuiteCRM, Perfex, Vtiger y Odoo** — los que instala el
auto-instalador de Hostinger — además de HubSpot y Go High Level.

Luego comprueba la conexión de verdad:

```bash
node scripts/crm.js status     # ¿está completo lo que hace falta?
node scripts/crm.js test       # crea un lead de prueba y te da su id
```

El lead de prueba aparece como **"PRUEBA · Cali Clean Lead Machine"**: búscalo en
tu CRM, confirma que llegó con todos los campos, y bórralo.

### Qué recibe el CRM

Además de nombre, correo y teléfono, cada lead llega con una nota que explica
**por qué** está ahí: el servicio estimado y su precio, el valor anual del
contrato, la puntuación con sus motivos punto por punto, y —si vino de
prospección— la señal que lo activó (la obra que se cerró, el negocio que abrió)
y de dónde salió su correo.

Es lo que lee el comercial antes de llamar.

### Si tu CRM no está en la lista

El adaptador genérico funciona con cualquiera que acepte un POST:

```ini
CRM_DRIVER=webhook
CRM_WEBHOOK_URL=https://tu-crm/api/leads
CRM_WEBHOOK_SECRET=una-cadena-larga     # firma HMAC-SHA256 en X-CaliClean-Signature
```

El JSON exacto se puede ver en la ficha de cualquier prospecto, en `/prospects`.
Dime cuál es tu CRM y escribo el adaptador nativo.

---

## Varios clientes en el mismo servidor

Un CRM por cliente, aislados. Después de instalar el primero:

```bash
bash /opt/caliclean/deploy/new-client.sh acme "Acme Cleaning" crm.acme.com tu@correo.com
```

Cada cliente tiene su carpeta, su base de datos, su `.env`, su usuario de
sistema, sus dos servicios y su dominio con su propio certificado. No comparten
nada: ni datos, ni remitente, ni reputación de dominio. Si uno se cae, el resto
sigue.

Para verlos y manejarlos:

```bash
ls /opt/clients                                  # clientes instalados
systemctl status caliclean-acme                  # estado de uno
journalctl -u caliclean-worker-acme -f           # sus agentes en vivo
nano /opt/clients/acme/.env                      # su configuración
```

Un VPS pequeño aguanta varios clientes sin problema: cada instalación consume
poco, y SQLite no necesita servidor de base de datos.
