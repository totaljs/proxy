# Complete configuration example

This deployment puts three apps behind one Proxy. The shop requests a Let's Encrypt certificate, the preview uses HTTP, and the portal uses a certificate you supply. It also shows a hostname redirect, access logs and visit statistics. Replace the example domains and upstreams with your own.

## Proxy config

Save as `data/config.json`. Every key is optional: this example lists them all with their defaults, apart from `email`, `headers`, `workers` and `ratelimit`. Relative paths start at the folder that holds `data`. Proxy applies a saved change by itself, see [Configure Proxy](configuration.md#config).

```json
{
  "email": "ops@example.com",
  "acme": "https://acme-v02.api.letsencrypt.org/directory",
  "acme_ca": "",
  "renew_days": 30,
  "precheck": true,

  "http": 80,
  "https": 443,
  "dns": 0,
  "dns_zone": "",
  "dns_ns": "",

  "workers": 2,

  "custom_cert_dir": "",
  "docker": "/var/run/docker.sock",
  "docker_network": "proxy",

  "upstream_connections": 128,
  "upstream_idle_connections": 128,
  "http_active": 2048,
  "http_active_per_route": 256,
  "ws_active": 1024,
  "ws_active_per_route": 128,
  "http_active_per_ip": 64,
  "ws_active_per_ip": 32,

  "headers": { "X-Content-Type-Options": "nosniff" },
  "hsts": "max-age=31536000",
  "maxupload": 50,
  "compress": true,
  "errors": "",
  "ratelimit": 100,
  "deny": [],
  "page": "",

  "logs": "logs",
  "logs_maxsize": 100,
  "stats_days": 400
}
```

Containers of the `docker_network` that set `PROXY_HOST` get their site file by themselves, see [Docker discovery](docker-discovery.md). For wildcard certificates, add the [DNS delegation settings](configuration.md#wildcard-certificates) and publish DNS over both TCP and UDP in Compose.

## Site files

Each site is a file in `data/sites`, named after the site. JSON files use strict JSON. The notes below explain the fields that vary by app.

`data/sites/shop.example.com.json`

```json
{
  "hosts": ["shop.example.com"],
  "redirects": ["www.shop.example.com"],
  "forwards": [
    { "host": "old-shop.example.com", "to": "https://shop.example.com/store", "path": true, "permanent": true }
  ],
  "target": "shop:8000",
  "cert": "auto",
  "challenge": "http",
  "https": true,
  "hsts": true,
  "logs": true,
  "maxupload": 25,
  "compress": true,
  "headers": { "Referrer-Policy": "same-origin" }
}
```

`data/sites/preview.example.com.json`

```json
{
  "hosts": ["preview.example.com"],
  "target": "preview:8000",
  "cert": "off",
  "https": false,
  "limit": true,
  "allow": ["192.0.2.0/24"],
  "deny": ["192.0.2.42"],
  "page": "<h1>Preview is temporarily unavailable</h1>",
  "maintenance": false,
  "logs": false
}
```

`data/sites/portal.example.com.json`

```json
{
  "hosts": ["portal.example.com"],
  "target": "portal:8000",
  "cert": "custom",
  "cert_file": "portal/fullchain.pem",
  "key_file": "portal/privkey.pem",
  "https": true
}
```

- **Shop** redirects the `www` alias to the primary hostname and sends the old hostname to `/store`, preserving the requested path. Its requests go to `logs/shop.example.com.log`. HTTP-01 validation needs all three hostnames to resolve to Proxy.
- **Preview** allows only the example network and excludes one address. Replace both addresses with your own. The custom page appears when the upstream is unavailable. Set `maintenance` to `true` to show it immediately.
- **Portal** uses the certificate in `data/tls/portal/fullchain.pem` and its matching `data/tls/portal/privkey.pem`. See [custom TLS](tls.md), the [site options](configuration.md#site-options) and the [access guide](access.md) for HTTP Basic authentication.

## Compose YAML

Build the image with `docker build -t totaljs-proxy:local .` from the repository root. Save the following as `compose.yaml` next to the `data` folder. Copy the [Total.js demo app directory](../examples/totaljs/app) alongside them as `app/`. All three services build the same demo and are reachable by service name on the Compose network. Replace each `build` with your own app image or build context when adapting the example.

```yaml
services:
  proxy:
    # Use an Proxy build that supports the configuration above.
    image: ${PROXY_IMAGE:-totaljs-proxy:local}
    restart: unless-stopped
    ports:
      # Only Proxy publishes the public HTTP and HTTPS ports.
      - "80:80"
      - "443:443"
      # For DNS challenges, publish "53:53/tcp" and "53:53/udp".
    volumes:
      # config.json, sites/ and the certificates of Let's Encrypt. Writable by the container user (UID 1000).
      - ./data:/proxy/data
      - ./logs:/proxy/logs
      # Explicit certificate files for the portal.
      - ./cert:/proxy/data/cert:ro
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
```

Point the public hostnames to Proxy, install the portal certificate and run `docker compose up -d`. For a complete Compose project that also launches its backend, see [Deploy Total.js Flow](flow.md). Verify the shop with `curl -I https://shop.example.com/` and check certificate progress in `docker compose logs proxy`.
