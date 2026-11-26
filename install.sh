#!/usr/bin/env bash
#
# Installs Total.js Proxy into ./proxy of the folder where it runs, and starts it.
#
#   bash install.sh
#
# It makes the Docker network "proxy", the folders proxy/data and proxy/logs, proxy/compose.yaml and proxy/.env, and
# starts the container. Run it again to update: it pulls the image and starts the container again. A compose.yaml
# that is already there is kept as it is.
#
#   PROXY_IMAGE     the image (default: totalplatform/proxy)
#   PROXY_NETWORK   the Docker network of Proxy and the apps (default: proxy)
#   PROXY_DIR       where to install (default: ./proxy)

set -euo pipefail

IMAGE="${PROXY_IMAGE:-totalplatform/proxy}"
NETWORK="${PROXY_NETWORK:-proxy}"
TARGET="${PROXY_DIR:-$PWD/proxy}"
SOCKET="/var/run/docker.sock"
# The user of the container (node)
OWNER=1000

say() { printf '%s\n' "$*"; }
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail "Docker is not installed. See https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || fail "Docker Compose is not installed (the \"docker compose\" command)."
docker info >/dev/null 2>&1 || fail "Docker does not answer. Is it running, and may this user use it? Try: sudo bash install.sh"

# As root, or through sudo when this user is not the owner of what has to change
asroot() {
	if [ "$(id -u)" -eq 0 ]; then
		"$@"
	elif command -v sudo >/dev/null 2>&1; then
		sudo "$@"
	else
		return 1
	fi
}

say "Installing Total.js Proxy into $TARGET"

# 1. The network that Proxy and the apps share
if docker network inspect "$NETWORK" >/dev/null 2>&1; then
	say "- the Docker network \"$NETWORK\" is there"
else
	docker network create "$NETWORK" >/dev/null
	say "- made the Docker network \"$NETWORK\""
fi

# 2. The folders: the container writes them as its own user, not as root
mkdir -p "$TARGET/data/sites" "$TARGET/logs" 2>/dev/null || asroot mkdir -p "$TARGET/data/sites" "$TARGET/logs" || fail "Cannot make $TARGET"
if [ "$(id -u)" -ne "$OWNER" ] || [ ! -w "$TARGET/data" ]; then
	asroot chown -R "$OWNER:$OWNER" "$TARGET/data" "$TARGET/logs" || fail "Cannot give $TARGET/data and $TARGET/logs to the user $OWNER. Run: sudo chown -R $OWNER:$OWNER \"$TARGET/data\" \"$TARGET/logs\""
fi
say "- the folders data and logs belong to the user of the container ($OWNER)"

# The files below are written by this user when it may, else as root
put() {
	if [ -w "$TARGET" ]; then
		cat > "$1"
	else
		asroot tee "$1" >/dev/null || fail "Cannot write $1"
	fi
}

# 3. The group of the Docker socket: with it Proxy sees which containers publish themselves
if [ -S "$SOCKET" ]; then
	DOCKER_GROUP="$(stat -c %g "$SOCKET" 2>/dev/null || stat -f %g "$SOCKET")"
else
	DOCKER_GROUP=0
	say "- $SOCKET is not there: Proxy will serve the sites you write in data/sites, without Docker discovery"
fi
printf 'PROXY_IMAGE=%s\nPROXY_NETWORK=%s\nDOCKER_GID=%s\n' "$IMAGE" "$NETWORK" "$DOCKER_GROUP" | put "$TARGET/.env"

# 4. The Compose file: kept when it is there, so what you changed in it stays
if [ -f "$TARGET/compose.yaml" ]; then
	say "- kept the compose.yaml that is there"
else
	put "$TARGET/compose.yaml" <<'YAML'
# Total.js Proxy. The values come from .env next to this file.
services:
  proxy:
    image: ${PROXY_IMAGE:-totalplatform/proxy}
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      # config.json, sites/*.json and the certificates: Proxy applies what you change here by itself
      - ./data:/proxy/data
      - ./logs:/proxy/logs
      # Docker discovery: the containers of the network that set PROXY_HOST publish themselves
      - /var/run/docker.sock:/var/run/docker.sock:ro
    group_add:
      - "${DOCKER_GID:-0}"
    networks: [proxy]

networks:
  proxy:
    name: ${PROXY_NETWORK:-proxy}
    external: true
YAML
	say "- wrote compose.yaml"
fi

# 5. Start (again: with the newest image)
cd "$TARGET"
docker compose pull
docker compose up -d
say ""
say "Total.js Proxy runs. It answers on the ports 80 and 443 of this server."
say ""
say "  Sites:     $TARGET/data/sites/<name>.json"
say "  Settings:  $TARGET/data/config.json (optional)"
say "  Logs:      $TARGET/logs/<site>.log and $TARGET/logs/error.log"
say "  Counters:  $TARGET/data/stats/<site>.json"
say "  Certs:     $TARGET/data/certs/"
say ""
say "To publish an app, put its container on the network \"$NETWORK\" and set in its environment:"
say "  PROXY_HOST=https://example.com,https://www.example.com"
say "  PROXY_PORT=8000"
say ""
say "Request counters: every site is counted, nothing to turn on. data/stats/<site>.json has the requests, the"
say "answers by kind (2xx, 3xx, 4xx, 5xx), the time of the answers and the apps that did not answer, in total and"
say "for each day. It is written once a minute."
say ""
say "Your own certificate: put two PEM files in $TARGET/data/certs/"
say "  example.com.crt   the certificate with its chain (or example.com.pem)"
say "  example.com.key   its private key"
say "and set PROXY_CERT=custom in the environment of the app (\"cert\": \"custom\" in a site file). Proxy picks the"
say "files up within a few seconds, also when you replace them. Without that, the names written with https:// get a"
say "certificate of Let's Encrypt by themselves."
say ""
say "Proxy output:  cd \"$TARGET\" && docker compose logs -f proxy"
say "Update:        run this script again"
