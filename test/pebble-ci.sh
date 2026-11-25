#!/bin/sh
# Run the ACME integration test with a private network namespace and no host ports.
set -eu

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
scratch=$(mktemp -d)
runner=
pebble=
cleanup() {
	if [ -n "$pebble" ]; then docker rm -f "$pebble" >/dev/null 2>&1 || true; fi
	if [ -n "$runner" ]; then docker rm -f "$runner" >/dev/null 2>&1 || true; fi
	rm -rf "$scratch"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cp -R "$root/lib" "$root/test" "$root/package.json" "$scratch"
runner=$(docker run -d --network none --mount "type=bind,src=$scratch,dst=/test-proxy,readonly" -w /test-proxy node:24-alpine sleep 300)
pebble=$(docker run -d --network "container:$runner" -e PEBBLE_VA_NOSLEEP=1 -e PEBBLE_WFE_NONCEREJECT=0 ghcr.io/letsencrypt/pebble:2.10.1 \
	-config /test/config/pebble-config.json -dnsserver 127.0.0.1:8053)
docker cp "$pebble:/test/certs/pebble.minica.pem" "$scratch/test/pebble/minica.pem"
printf '127.0.0.1\n' > "$scratch/test/pebble/host"

attempt=0
until docker exec "$runner" node -e '
	const ca = require("node:fs").readFileSync("test/pebble/minica.pem");
	const req = require("node:https").get("https://localhost:14000/dir", { ca, agent: false, headers: { "user-agent": "totaljs-proxy-test" } }, res => {
		res.resume();
		if (res.statusCode !== 200) process.exitCode = 1;
	});
	req.setTimeout(2000, () => req.destroy());
	req.on("error", () => process.exitCode = 1);
'; do
	attempt=$((attempt + 1))
	if [ "$attempt" -ge 15 ]; then
		docker logs "$pebble" >&2
		exit 1
	fi
	sleep 1
done

docker exec -e PEBBLE_REQUIRED=1 "$runner" node --test test/pebble.test.js
