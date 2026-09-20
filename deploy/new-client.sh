#!/usr/bin/env bash
#
# Alta de un cliente nuevo en el mismo VPS, aislado del resto.
#
#   bash new-client.sh acme "Acme Cleaning" crm.acme.com tu@correo.com
#
# Cada cliente tiene su carpeta, su base de datos, su .env, su usuario de
# sistema, sus servicios y su dominio. No comparten nada: un cliente no puede
# ver los datos de otro, ni quemarle la reputación del remitente.
#
# El código se copia de una instalación existente (/opt/caliclean por defecto),
# así que funciona sin acceso al repositorio.

set -euo pipefail

SLUG="${1:-}"
NAME="${2:-}"
DOMAIN="${3:-}"
EMAIL="${4:-}"
SOURCE_DIR="${SOURCE_DIR:-/opt/caliclean}"

die() { echo "✗ $*" >&2; exit 1; }
step() { echo -e "\n\033[1;36m▸ $*\033[0m"; }

[ -n "$SLUG" ] && [ -n "$NAME" ] && [ -n "$DOMAIN" ] && [ -n "$EMAIL" ] \
  || die 'Uso: bash new-client.sh <slug> "<Nombre del negocio>" <dominio> <correo-ssl>'
[[ "$SLUG" =~ ^[a-z0-9-]+$ ]] || die "El slug solo admite minúsculas, números y guiones."
[ "$(id -u)" -eq 0 ] || die "Ejecútalo como root."
[ -f "$SOURCE_DIR/package.json" ] || die "No encuentro el código en $SOURCE_DIR (SOURCE_DIR=...)."

APP_DIR="/opt/clients/$SLUG"
APP_USER="cc-$SLUG"
SERVICE="caliclean-$SLUG"
[ -e "$APP_DIR" ] && die "$APP_DIR ya existe. Elige otro slug o bórralo antes."

# Cada cliente escucha en su propio puerto local; nginx enruta por dominio.
PORT=3100
while ss -ltn 2>/dev/null | grep -q ":$PORT "; do PORT=$((PORT + 1)); done

step "Cliente: $NAME ($SLUG) · $DOMAIN · puerto $PORT"

step "Copiando el código desde $SOURCE_DIR"
mkdir -p /opt/clients
# Ni datos, ni configuración, ni dependencias del otro cliente.
rsync -a --exclude node_modules --exclude data --exclude .env --exclude .git \
  "$SOURCE_DIR/" "$APP_DIR/" 2>/dev/null \
  || { mkdir -p "$APP_DIR"; (cd "$SOURCE_DIR" && tar --exclude=node_modules --exclude=data \
        --exclude=.env --exclude=.git -cf - .) | tar -xf - -C "$APP_DIR"; }

step "Instalando"
APP_USER="$APP_USER" SERVICE="$SERVICE" PORT="$PORT" DISPLAY_NAME="$NAME" \
  bash "$APP_DIR/deploy/install-here.sh" "$DOMAIN" "$EMAIL"

step "Datos del negocio"
sed -i "s|^BUSINESS_NAME=.*|BUSINESS_NAME=$NAME|"   "$APP_DIR/.env"
sed -i "s|^MAIL_FROM_NAME=.*|MAIL_FROM_NAME=$NAME|" "$APP_DIR/.env"
systemctl restart "$SERVICE" "$SERVICE-worker"

echo -e "\n\033[1;32m✓ $NAME listo\033[0m"
echo "  https://$DOMAIN/admin  ·  https://$DOMAIN/prospects"
echo "  Configuración:  nano $APP_DIR/.env"
echo "  Reiniciar:      systemctl restart $SERVICE $SERVICE-worker"
echo -e "\n  Clientes instalados:"
ls -1 /opt/clients 2>/dev/null | sed 's/^/    /'
