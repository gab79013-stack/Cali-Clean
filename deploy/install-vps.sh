#!/usr/bin/env bash
#
# Instalación en un VPS de Hostinger (Ubuntu 22.04 / 24.04).
#
#   ssh root@TU_IP
#   curl -fsSL https://raw.githubusercontent.com/gab79013-stack/Cali-Clean/claude/amazing-davinci-vm73zy/deploy/install-vps.sh -o install.sh
#   bash install.sh crm.cali-clean.net tu@correo.com
#
# Deja corriendo: la API, el panel y el worker de agentes, detrás de nginx con
# certificado SSL renovado solo. Es idempotente: se puede repetir sin romper nada.

set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
REPO="${REPO:-https://github.com/gab79013-stack/Cali-Clean.git}"
BRANCH="${BRANCH:-claude/amazing-davinci-vm73zy}"
APP_DIR="/opt/caliclean"
APP_USER="caliclean"

die() { echo "✗ $*" >&2; exit 1; }
step() { echo -e "\n\033[1;36m▸ $*\033[0m"; }

[ -n "$DOMAIN" ] || die "Uso: bash install.sh <dominio> <correo-para-ssl>"
[ -n "$EMAIL" ]  || die "Uso: bash install.sh <dominio> <correo-para-ssl>"
[ "$(id -u)" -eq 0 ] || die "Ejecútalo como root."

step "Paquetes base"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git nginx certbot python3-certbot-nginx build-essential python3 ufw

step "Node.js 22"
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
node -v

step "Usuario de servicio"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"

step "Código"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch origin "$BRANCH" --depth 1
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
else
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund
mkdir -p "$APP_DIR/data"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

step "Configuración"
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  # Secretos fuertes generados aquí: nadie los teclea, nadie los reutiliza.
  SECRET=$(openssl rand -hex 32)
  ADMIN_PASS=$(openssl rand -base64 18 | tr -d '/+=' | head -c 20)
  sed -i "s|^APP_SECRET=.*|APP_SECRET=$SECRET|" "$APP_DIR/.env"
  sed -i "s|^ADMIN_PASS=.*|ADMIN_PASS=$ADMIN_PASS|" "$APP_DIR/.env"
  sed -i "s|^APP_URL=.*|APP_URL=https://$DOMAIN|" "$APP_DIR/.env"
  sed -i "s|^NODE_ENV=.*|NODE_ENV=production|" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
  echo "$ADMIN_PASS" > /root/caliclean-admin-password.txt
  chmod 600 /root/caliclean-admin-password.txt
  NEW_ENV=1
else
  echo "  .env ya existe, no se toca."
  NEW_ENV=0
fi

step "Servicios systemd"
cp "$APP_DIR/deploy/caliclean.service" /etc/systemd/system/
cp "$APP_DIR/deploy/caliclean-worker.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now caliclean caliclean-worker
sleep 2
systemctl is-active --quiet caliclean || { journalctl -u caliclean -n 30 --no-pager; die "La API no arrancó."; }

step "nginx"
sed "s/__DOMAIN__/$DOMAIN/g" "$APP_DIR/deploy/nginx.conf" > "/etc/nginx/sites-available/caliclean"
ln -sf /etc/nginx/sites-available/caliclean /etc/nginx/sites-enabled/caliclean
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

step "Certificado SSL"
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect || \
  echo "  ⚠ Certbot falló. Comprueba que el DNS de $DOMAIN apunta a este servidor y repite:  certbot --nginx -d $DOMAIN"

step "Cortafuegos"
ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
ufw --force enable >/dev/null

echo -e "\n\033[1;32m✓ Listo\033[0m"
echo "  Panel de leads:       https://$DOMAIN/admin"
echo "  Panel de prospección: https://$DOMAIN/prospects"
echo "  Widget:               https://$DOMAIN/embed.js"
if [ "$NEW_ENV" = "1" ]; then
  echo -e "\n  Usuario: admin"
  echo "  Clave:   $(cat /root/caliclean-admin-password.txt)   (guardada en /root/caliclean-admin-password.txt)"
fi
echo -e "\n  Ahora edita \033[1m$APP_DIR/.env\033[0m con los datos reales (teléfono, dirección,"
echo "  SMTP de Sender, ZIPs) y reinicia:  systemctl restart caliclean caliclean-worker"
echo -e "\n  \033[1;33mOUTBOUND_ENABLED sigue en false.\033[0m Revisa los primeros correos en"
echo "  /prospects antes de encenderlo, y autentica el dominio (SPF, DKIM, DMARC)."
