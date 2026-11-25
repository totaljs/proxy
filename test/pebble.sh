#!/bin/sh
# Starts Pebble, the test ACME server of Let's Encrypt, for test/pebble.test.js.
# Pebble runs in Docker and checks the edge running on this machine:
# HTTP on port 5002 and DNS through the test resolver on port 8053.
set -e

DIR=$(cd "$(dirname "$0")" && pwd)
IMAGE=ghcr.io/letsencrypt/pebble:2.10.1
NAME=code-edge-pebble

# The address of this machine as containers see it
HOST=$(docker run --rm alpine:3.20 getent hosts host.docker.internal 2>/dev/null | awk '{ print $1 }')
ADDHOST=""
if [ -z "$HOST" ]; then
	ADDHOST="--add-host=host.docker.internal:host-gateway"
	HOST=$(docker run --rm $ADDHOST alpine:3.20 getent hosts host.docker.internal | awk '{ print $1 }')
fi

docker rm -f $NAME >/dev/null 2>&1 || true
docker run -d --name $NAME $ADDHOST -p 14000:14000 -p 15000:15000 \
	-e PEBBLE_VA_NOSLEEP=1 -e PEBBLE_WFE_NONCEREJECT=0 \
	$IMAGE -config /test/config/pebble-config.json -dnsserver "$HOST:8053" >/dev/null

mkdir -p "$DIR/pebble"
docker cp $NAME:/test/certs/pebble.minica.pem "$DIR/pebble/minica.pem" >/dev/null
echo "$HOST" > "$DIR/pebble/host"

echo "Pebble is running; it reaches this machine at $HOST. Stop it with: docker rm -f $NAME"
