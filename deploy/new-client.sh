#!/usr/bin/env bash
#
# Alta de un cliente nuevo en el mismo VPS, aislado del resto.
#
#   bash new-client.sh acme "Acme Cleaning" crm.acme.com tu@correo.com
#
# Cada cliente tiene su carpeta, su base de datos, su .env, su usuario de
# sistema, sus servicios y su dominio. No comparten nada: un cliente no puede
# ver los datos de otro ni tumbarle el servicio.

set -euo pipefail

SLUG="${1:-}"
NAME="${2:-}"
DOMAIN="${3:-}"
EMAIL="${4:-}"
REPO="${REPO:-https://github.com/gab79013-stack/Cali-Clean.git}"
BRANCH="${BRANCH:-claude/amazing-davinci-vm73zy}"

die() { echo "✗ $*" >&2; exit 1; }
step() { echo -e "\n\033[1;36m▸ $*\033[0m"; }

[ -n "$SLUG" ] && [ -n "$NAME" ] && [ -n "$DOMAIN" ] && [ -n "$EMAIL" ] \
  || die 'Uso: bash new-client.sh <slug> "<Nombre del negocio>" <dominio> <correo-ssl>'
[[ "$SLUG" =~ ^[a-z0-9-]+$ ]] || die "El slug solo admite minúsculas, números y guiones."
[ "$(id -u)" -eq 0 ] || die "Ejecútalo como root."

APP_DIR="/opt/clients/$SLUG"
APP_USER="cc-$SLUG"
[ -e "$APP_DIR" ] && die "$APP_DIR ya existe. Elige otro slug o bórralo antes."

# Cada cliente escucha en su propio puerto local; nginx enruta por dominio.
PORT=$((3100 + $(ls -1 /opt/clients 2>/dev/null | wc -l)))
while ss -ltn 2>/dev/null | grep -q ":$PORT "; do PORT=$((PORT + 1)); done

step "Cliente: $NAME ($SLUG) · $DOMAIN · puerto $PORT"

step "Usuario y código"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
mkdir -p /opt/clients
git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR"
cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund
mkdir -p "$APP_DIR/data"

step "Configuración"
cp "$APP_DIR/.env.example" "$APP_DIR/.env"
SECRET=$(openssl rand -hex 32)
ADMIN_PASS=$(openssl rand -base64 18 | tr -d '/+=' | head -c 20)
sed -i "s|^APP_SECRET=.*|APP_SECRET=$SECRET|"        "$APP_DIR/.env"
sed -i "s|^ADMIN_PASS=.*|ADMIN_PASS=$ADMIN_PASS|"    "$APP_DIR/.env"
sed -i "s|^APP_URL=.*|APP_URL=https://$DOMAIN|"      "$APP_DIR/.env"
sed -i "s|^PORT=.*|PORT=$PORT|"                      "$APP_DIR/.env"
sed -i "s|^NODE_ENV=.*|NODE_ENV=production|"         "$APP_DIR/.env"
sed -i "s|^BUSINESS_NAME=.*|BUSINESS_NAME=$NAME|"    "$APP_DIR/.env"
sed -i "s|^MAIL_FROM_NAME=.*|MAIL_FROM_NAME=$NAME|"  "$APP_DIR/.env"
echo "DB_PATH=$APP_DIR/data/leads.db" >> "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

step "Servicios"
for unit in caliclean caliclean-worker; do
  sed -e "s|/opt/caliclean|$APP_DIR|g" \
      -e "s|^User=caliclean$|User=$APP_USER|" \
      -e "s|^Description=Cali Clean|Description=$NAME|" \
      "$APP_DIR/deploy/$unit.service" > "/etc/systemd/system/$unit-$SLUG.service"
done
# El worker depende de la API del mismo cliente, no de la de otro.
sed -i "s|After=network.target caliclean.service|After=network.target caliclean-$SLUG.service|" \
  "/etc/systemd/system/caliclean-worker-$SLUG.service"
systemctl daemon-reload
systemctl enable --now "caliclean-$SLUG" "caliclean-worker-$SLUG"
sleep 2
systemctl is-active --quiet "caliclean-$SLUG" \
  || { journalctl -u "caliclean-$SLUG" -n 30 --no-pager; die "El servicio no arrancó."; }

step "nginx y SSL"
sed -e "s/__DOMAIN__/$DOMAIN/g" -e "s|127.0.0.1:3000|127.0.0.1:$PORT|g" \
  "$APP_DIR/deploy/nginx.conf" > "/etc/nginx/sites-available/cc-$SLUG"
ln -sf "/etc/nginx/sites-available/cc-$SLUG" "/etc/nginx/sites-enabled/cc-$SLUG"
nginx -t && systemctl reload nginx
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect \
  || echo "  ⚠ Certbot falló. Comprueba el DNS de $DOMAIN y repite: certbot --nginx -d $DOMAIN"

echo "$ADMIN_PASS" > "/root/cc-$SLUG-admin-password.txt"
chmod 600 "/root/cc-$SLUG-admin-password.txt"

echo -e "\n\033[1;32m✓ $NAME listo\033[0m"
echo "  Panel leads:       https://$DOMAIN/admin"
echo "  Panel prospección: https://$DOMAIN/prospects"
echo "  Usuario: admin · Clave: $ADMIN_PASS"
echo "  Guardada en /root/cc-$SLUG-admin-password.txt"
echo -e "\n  Configura sus datos:  nano $APP_DIR/.env"
echo "  Y reinicia:           systemctl restart caliclean-$SLUG caliclean-worker-$SLUG"
echo -e "\n  Clientes instalados:"
ls -1 /opt/clients | sed 's/^/    /'
