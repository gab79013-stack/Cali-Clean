#!/usr/bin/env bash
#
# Instalación en un VPS de Hostinger (Ubuntu 22.04 / 24.04) clonando el repo.
#
#   bash install.sh crm.cali-clean.net tu@correo.com
#
# Si el repositorio todavía no es accesible, usa el paquete .tar.gz y
# `deploy/install-here.sh`, que hace exactamente lo mismo sin descargar nada.

set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
REPO="${REPO:-https://github.com/gab79013-stack/Cali-Clean.git}"
BRANCH="${BRANCH:-claude/amazing-davinci-vm73zy}"
APP_DIR="${APP_DIR:-/opt/caliclean}"

die() { echo "✗ $*" >&2; exit 1; }

[ -n "$DOMAIN" ] && [ -n "$EMAIL" ] || die "Uso: bash install.sh <dominio> <correo-para-ssl>"
[ "$(id -u)" -eq 0 ] || die "Ejecútalo como root."

echo -e "\n\033[1;36m▸ Descargando el código\033[0m"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq git

if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch origin "$BRANCH" --depth 1
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
else
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR"
fi

# El resto del trabajo es idéntico se haya obtenido el código como se haya obtenido.
exec bash "$APP_DIR/deploy/install-here.sh" "$DOMAIN" "$EMAIL"
