#!/usr/bin/env bash
#
# Instala desde el código que YA está en esta carpeta. No descarga nada del
# repositorio, así que sirve igual si subiste el proyecto por scp.
#
#   cd /opt/caliclean
#   bash deploy/install-here.sh crm.cali-clean.net tu@correo.com
#
# Es idempotente: se puede repetir sin romper nada, y nunca pisa un .env ni una
# base de datos que ya existan.

set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_USER="${APP_USER:-caliclean}"
SERVICE="${SERVICE:-caliclean}"
PORT="${PORT:-3000}"
# Con varios clientes en el servidor, `systemctl status` debe decir de quién es
# cada servicio sin tener que mirar la ruta.
DISPLAY_NAME="${DISPLAY_NAME:-Cali Clean}"

die() { echo "✗ $*" >&2; exit 1; }
step() { echo -e "\n\033[1;36m▸ $*\033[0m"; }

[ -n "$DOMAIN" ] || die "Uso: bash deploy/install-here.sh <dominio> <correo-para-ssl>"
[ -n "$EMAIL" ]  || die "Uso: bash deploy/install-here.sh <dominio> <correo-para-ssl>"
[ "$(id -u)" -eq 0 ] || die "Ejecútalo como root (o con sudo)."
[ -f "$APP_DIR/package.json" ] || die "No encuentro package.json en $APP_DIR."

echo "  Código:  $APP_DIR"
echo "  Dominio: $DOMAIN"

step "Dependencias del sistema"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl nginx certbot python3-certbot-nginx build-essential python3 ufw sqlite3

step "Node.js 22"
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
echo "  $(node -v)"

step "Usuario de servicio"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"

step "Dependencias de la aplicación"
cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund
mkdir -p "$APP_DIR/data"

step "Configuración"
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  # Secretos generados aquí: nadie los teclea, nadie los reutiliza entre clientes.
  SECRET=$(openssl rand -hex 32)
  ADMIN_PASS=$(openssl rand -base64 18 | tr -d '/+=' | head -c 20)
  sed -i "s|^APP_SECRET=.*|APP_SECRET=$SECRET|"      "$APP_DIR/.env"
  sed -i "s|^ADMIN_PASS=.*|ADMIN_PASS=$ADMIN_PASS|"  "$APP_DIR/.env"
  sed -i "s|^APP_URL=.*|APP_URL=https://$DOMAIN|"    "$APP_DIR/.env"
  sed -i "s|^PORT=.*|PORT=$PORT|"                    "$APP_DIR/.env"
  sed -i "s|^NODE_ENV=.*|NODE_ENV=production|"       "$APP_DIR/.env"
  echo "DB_PATH=$APP_DIR/data/leads.db" >> "$APP_DIR/.env"
  echo "$ADMIN_PASS" > "/root/$SERVICE-admin-password.txt"
  chmod 600 "/root/$SERVICE-admin-password.txt"
  NEW_ENV=1
else
  echo "  .env ya existe: no se toca."
  NEW_ENV=0
fi
chmod 600 "$APP_DIR/.env"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

step "Servicios systemd"
for unit in caliclean caliclean-worker; do
  target="${unit/caliclean/$SERVICE}"
  sed -e "s|/opt/caliclean|$APP_DIR|g" \
      -e "s|^User=caliclean$|User=$APP_USER|" \
      -e "s|After=network.target caliclean.service|After=network.target $SERVICE.service|" \
      -e "s|^Description=Cali Clean |Description=$DISPLAY_NAME |" \
      "$APP_DIR/deploy/$unit.service" > "/etc/systemd/system/$target.service"
done
systemctl daemon-reload
systemctl enable --now "$SERVICE" "$SERVICE-worker"
sleep 2
systemctl is-active --quiet "$SERVICE" \
  || { journalctl -u "$SERVICE" -n 40 --no-pager; die "La API no arrancó."; }
echo "  $SERVICE y $SERVICE-worker activos"

step "nginx"
sed -e "s/__DOMAIN__/$DOMAIN/g" -e "s|127.0.0.1:3000|127.0.0.1:$PORT|g" \
  "$APP_DIR/deploy/nginx.conf" > "/etc/nginx/sites-available/$SERVICE"
ln -sf "/etc/nginx/sites-available/$SERVICE" "/etc/nginx/sites-enabled/$SERVICE"
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

step "Certificado SSL"
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect \
  || echo "  ⚠ Certbot falló. Comprueba que el DNS de $DOMAIN apunte a este servidor y repite:
     certbot --nginx -d $DOMAIN"

step "Cortafuegos"
ufw allow OpenSSH >/dev/null 2>&1 || true
ufw allow 'Nginx Full' >/dev/null 2>&1 || true
ufw --force enable >/dev/null 2>&1 || true

echo -e "\n\033[1;32m✓ Listo\033[0m"
echo "  Panel de leads:       https://$DOMAIN/admin"
echo "  Panel de prospección: https://$DOMAIN/prospects"
echo "  Widget para la web:   https://$DOMAIN/embed.js"
if [ "$NEW_ENV" = "1" ]; then
  echo -e "\n  Usuario: admin"
  echo "  Clave:   $(cat "/root/$SERVICE-admin-password.txt")"
  echo "  (guardada en /root/$SERVICE-admin-password.txt)"
fi
echo -e "\n  Siguiente paso:  nano $APP_DIR/.env"
echo "  Rellena teléfono, dirección, ZIPs y el SMTP de Sender, y reinicia:"
echo "    systemctl restart $SERVICE $SERVICE-worker"
echo -e "\n  \033[1;33mOUTBOUND_ENABLED sigue en false\033[0m — revisa los primeros correos"
echo "  en /prospects y autentica el dominio (SPF, DKIM, DMARC) antes de encenderlo."
