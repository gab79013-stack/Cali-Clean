# Prompt para la sesión de Claude Code del servidor

Copia el bloque de abajo y pégalo en la sesión de Claude Code que corre en el
VPS. Está escrito para que se entienda sin conocer esta conversación.

**Antes de pegarlo, sustituye los tres valores en MAYÚSCULAS.**

---

```
Vas a desplegar una aplicación Node en este servidor. Lee esto entero antes de
ejecutar nada.

## Qué es

Un sistema de generación de clientes para una empresa de limpieza en California.
Tiene dos partes: un CRM propio con paneles web, y unos agentes que buscan
prospectos en registros públicos y les escriben correos en frío. Corre como dos
servicios systemd (API y worker) detrás de nginx, con SQLite en un archivo.

Repositorio: https://github.com/gab79013-stack/Cali-Clean.git
Rama: claude/amazing-davinci-vm73zy

## Datos que necesito

- Dominio para el panel: CRM.MIDOMINIO.COM
- Correo para el certificado SSL: MI@CORREO.COM
- Destino final: /opt/caliclean

## Este servidor NO está vacío

Ya hay otras cosas corriendo aquí (al menos un CRM y un sitio web). Es
producción. Por tanto:

- NO pares, reconfigures ni desinstales ningún servicio que ya exista.
- NO toques la configuración de nginx de otros sitios, ni borres
  /etc/nginx/sites-enabled/default sin comprobar antes que no lo usa nadie.
- NO cambies reglas de cortafuegos más allá de permitir HTTP/HTTPS y SSH.
- Si el puerto 3000 está ocupado, usa otro. El instalador ya lo detecta solo.
- Antes de recargar nginx, valida con `nginx -t`. Si no valida, NO recargues:
  déjalo como estaba y dímelo.

Si algo de lo que vas a hacer puede afectar a un servicio existente, PARA y
pregúntame antes.

## Pasos

1. Comprueba primero qué hay: qué escucha en qué puerto, qué sitios tiene nginx
   habilitados, y si el dominio de arriba ya resuelve a la IP de este servidor.
   Enséñame ese resumen antes de continuar.

2. Clona el repositorio en /opt/caliclean (rama claude/amazing-davinci-vm73zy).

3. Ejecuta:
   bash /opt/caliclean/deploy/install-here.sh CRM.MIDOMINIO.COM MI@CORREO.COM

   Instala Node 22, nginx, certbot, crea un usuario de sistema sin privilegios,
   levanta los servicios `caliclean` y `caliclean-worker`, configura el proxy y
   saca el certificado SSL. Es idempotente y no pisa .env ni base de datos
   existentes. Léelo antes de lanzarlo si quieres saber exactamente qué hace.

4. Si certbot falla porque el DNS aún no ha propagado, NO es un fallo grave: el
   resto queda instalado y el certificado se saca después con
   `certbot --nginx -d CRM.MIDOMINIO.COM`. Avísame y sigue.

5. Cuando termine, enséñame:
   - La clave de administrador que imprime (está en /root/caliclean-admin-password.txt)
   - `systemctl status caliclean caliclean-worker` (ambos deben estar active)
   - Que https://CRM.MIDOMINIO.COM/admin responde 401 sin credenciales

## Después de instalar

6. Averigua qué CRM hay ya instalado en este servidor y dime cuál es:
   cd /opt/caliclean && node scripts/crm.js detect https://URL-DEL-CRM-EXISTENTE

7. NO edites /opt/caliclean/.env con datos inventados. Necesito darte yo el
   teléfono, la dirección física, los códigos postales de servicio y las
   credenciales SMTP. Pídemelos y los rellenas conmigo.

8. IMPORTANTE: deja OUTBOUND_ENABLED=false. No lo cambies aunque el sistema
   parezca listo. Eso enciende el envío de correos en frío automáticos y solo se
   activa cuando yo lo diga, después de revisar los textos y de autenticar el
   dominio con SPF, DKIM y DMARC.

## Cómo quiero que trabajes

Ejecuta los comandos uno a uno y enséñame la salida. No encadenes media
instalación en un solo bloque. Si algo falla, para y dímelo con el error real en
lugar de intentar rodearlo.
```

---

## Para dar de alta otro cliente más adelante

Cuando ya haya una instalación funcionando, cada cliente nuevo es un comando.
Prompt corto para la misma sesión:

```
Da de alta un cliente nuevo en este servidor, aislado del resto:

bash /opt/caliclean/deploy/new-client.sh SLUG "NOMBRE DEL NEGOCIO" CRM.SUDOMINIO.COM MI@CORREO.COM

Crea su propia carpeta, base de datos, .env, usuario de sistema, servicios y
dominio con certificado propio. No comparte nada con los demás clientes.
Antes de lanzarlo, confirma que el DNS de CRM.SUDOMINIO.COM ya apunta aquí.
Enséñame la clave de administrador que imprima al final.
```
