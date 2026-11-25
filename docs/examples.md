# Complete configuration example

This deployment puts three apps behind one Edge. The shop requests a Let's Encrypt certificate, the preview uses HTTP, and the portal uses a certificate you supply. It also shows a hostname redirect, access logs and visit statistics. Replace the example domains and upstreams with your own.

## Edge config

Save as `edge.conf`. Blank optional values leave their features disabled. Relative paths are resolved from the config location.

```text
// ACME account, directory and optional CA for a private ACME server
email                : ops@example.com
acme                 : https://acme-v02.api.letsencrypt.org/directory
acme_ca              :
renew_days           : 30
precheck             : true

// Public HTTP/HTTPS and the optional DNS challenge server
http                 : 80
https                : 443
dns                  : 0
dns_zone             :
dns_ns               :

// State, route file and local control access
data                 : data
custom_cert_dir      :
routes_file          : routing/routes.json
docker_routes_file   :
control              : control/edge.sock
token                :
control_clients_file :

// Upstream connection pool and global and per-route concurrency limits
upstream_connections      : 128
upstream_idle_connections : 128
http_active           : 2048
http_active_per_route : 256
ws_active             : 1024
ws_active_per_route   : 128

// Default response headers, upload limit in MB, compression and error pages
headers              : X-Content-Type-Options: nosniff
hsts                 : max-age=31536000
maxupload            : 50
compress             : true
errors               : data/errors

// Send operational events to stdout and retain selected access logs on disk
eventlog             : stdout
accesslog            : data/access
accesslog_default    : false
accesslog_days       : 14
accesslog_maxsize     : 500
stats_days           : 400
```

To use the [shared control API](shared-apps.md) for writing routes, leave `routes_file` empty and configure `control_clients_file`. This example reads its routes from disk. Set `docker_routes_file` to add [Docker discovery](docker-discovery.md) alongside manual routes. For wildcard certificates, add the [DNS delegation settings](configuration.md#wildcard-certificates) and publish DNS over both TCP and UDP in Compose.

## Route JSON

Save as `routes.json`. JSON files use strict JSON. The notes below explain the fields that vary by app.

```json
[
  {
    "id": "shop",
    "hosts": ["shop.example.com"],
    "redirects": ["www.shop.example.com"],
    "forwards": [
      { "host": "old-shop.example.com", "to": "https://shop.example.com/store", "path": true, "permanent": true }
    ],
    "target": "http://shop:8000",
    "tls": "auto",
    "challenge": "http",
    "https": true,
    "hsts": true,
    "accesslog": true,
    "accesslog_dir": "shop",
    "stats": true,
    "maxupload": 25,
    "compress": true,
    "headers": { "Referrer-Policy": "same-origin" }
  },
  {
    "id": "preview",
    "hosts": ["preview.example.com"],
    "target": "http://preview:8000",
    "tls": "off",
    "https": false,
    "limit": true,
    "allow": ["192.0.2.0/24"],
    "deny": ["192.0.2.42"],
    "page": "<h1>Preview is temporarily unavailable</h1>",
    "maintenance": false,
    "accesslog": false
  },
  {
    "id": "portal",
    "hosts": ["portal.example.com"],
    "target": "http://portal:8000",
    "tls": "custom",
    "cert_file": "portal/fullchain.pem",
    "key_file": "portal/privkey.pem",
    "https": true
  }
]
```

- **Shop** redirects the `www` alias to the primary hostname and sends the old hostname to `/store`, preserving the requested path. Logs go under `data/access/shop/`. HTTP-01 validation needs all three hostnames to resolve to Edge.
- **Preview** allows only the example network and excludes one address. Replace both addresses with your own. The custom page appears when the upstream is unavailable. Set `maintenance` to `true` to show it immediately.
- **Portal** uses the certificate in `data/tls/portal/fullchain.pem` and its matching `data/tls/portal/privkey.pem`. See [custom TLS](tls.md) and the [route fields](control-api.md) and the [access guide](access.md) for HTTP Basic authentication.

## Compose YAML

Save as `compose.yaml` alongside the other files. Copy the [Total.js demo app directory](../examples/totaljs/app) alongside them as `app/`. All three services build the same demo and are reachable by service name on the Compose network. Replace each `build` with your own app image or build context when adapting the example.

```yaml
services:
  edge:
    # Use an Edge build that supports the configuration above.
    image: ghcr.io/totaljs-es/edge:${EDGE_VERSION:-latest}
    restart: unless-stopped
    command: ["node", "index.js", "edge.conf"]
    ports:
      # Only Edge publishes the public HTTP and HTTPS ports.
      - "80:80"
      - "443:443"
      # For DNS challenges, publish "53:53/tcp" and "53:53/udp".
    volumes:
      - ./edge.conf:/edge/edge.conf:ro
      # Mount the directory so atomic replacement of routes.json is visible.
      - ./:/edge/routing:ro
      - edge-data:/edge/data
      # Explicit certificate files for the portal.
      - ./tls:/edge/data/tls:ro
    networks: [proxy]

  # Each service uses the same demo and has its own address inside Docker.
  shop:
    build: ./app
    networks: [proxy]
  preview:
    build: ./app
    networks: [proxy]
  portal:
    build: ./app
    networks: [proxy]

networks:
  proxy:

volumes:
  # Keeps certificates, logs and statistics across container replacements.
  edge-data:
```

Point the public hostnames to Edge, install the portal certificate and run `docker compose up -d`. For a complete Compose project that also launches its backend, see [Deploy Total.js Flow](flow.md). Verify the shop with `curl -I https://shop.example.com/` and check certificate progress in `docker compose logs edge`.
