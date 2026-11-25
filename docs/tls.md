# Choose TLS for each app

Set `tls` for each entry in `routes.json`. These three apps can run behind the same Edge instance.

```json
[
  {
    "id": "preview",
    "hosts": ["preview.example.com"],
    "target": "http://preview:8000",
    "tls": "off"
  },
  {
    "id": "shop",
    "hosts": ["shop.example.com"],
    "target": "http://shop:8000",
    "tls": "auto"
  },
  {
    "id": "portal",
    "hosts": ["portal.example.com"],
    "target": "http://portal:8000",
    "tls": "custom",
    "cert_file": "portal/fullchain.pem",
    "key_file": "portal/private-key.pem"
  }
]
```

- **`off`** is the default and serves the app over HTTP. Edge skips certificate issuance for the route.
- **`auto`** enables automatic certificates. Point DNS at Edge and allow public TCP ports 80 and 443. Edge requests and renews the certificate using Let’s Encrypt by default. While the site waits for a certificate, Edge keeps ACME validation available and returns a temporary 503 for normal HTTP requests. See [wildcard certificates](configuration.md#wildcard-certificates) for DNS validation. Existing deployments can still provide an applicable custom certificate that takes precedence.
- **`custom`** uses the PEM chain and key you provide. In the example, Edge reads both paths under `custom_cert_dir`, which defaults to `data/tls`. Put the leaf certificate first in the chain, followed by any intermediates.

When a certificate is ready, HTTP redirects to HTTPS by default. The separate `https: false` option allows HTTP alongside TLS.

## Configure certificates in Compose

Keep `"tls": "custom"` on each route. If you prefer to configure its files in Compose, omit `cert_file` and `key_file` from that route in `routes.json`. Set `EDGE_CUSTOM_CERTS` on the **Edge service**, keyed by route ID:

```yaml
services:
  edge:
    environment:
      EDGE_CUSTOM_CERTS: >-
        {
          "portal": {
            "cert_file": "portal/fullchain.pem",
            "key_file": "portal/private-key.pem"
          },
          "shop": {
            "cert_file": "shared/fullchain.pem",
            "key_file": "shared/privkey.pem"
          },
          "docs": {
            "cert_file": "shared/fullchain.pem",
            "key_file": "shared/privkey.pem"
          }
        }
    volumes:
      # Add this to the existing config and data mounts.
      - ./tls:/edge/data/tls:ro
```

Set `shop` to `tls: custom` and add a `docs` route for `docs.example.com` with the same mode to try this configuration. Here `portal` uses its own certificate, and `shop` and `docs` reuse the pair in `./tls/shared/`. A certificate for `*.example.com` covers both `shop.example.com` and `docs.example.com`. Include the root domain separately in the certificate if a route also serves `example.com`. A wildcard covers one label and does not cover `dev.shop.example.com`.

If a route has explicit paths in both places, the pair in `routes.json` takes precedence. With neither pair configured, Edge keeps its existing certificate discovery from `data/custom/`, where the `.pem` or `.crt` and `.key` share a basename. To use another directory for explicit paths, set `custom_cert_dir` in `edge.conf` and mount the files there. The files must be readable by the Edge user, and symlinks must resolve within that directory. Restart Edge after replacing the certificate or private key files. Recreate the container after changing its Compose environment.

An invalid explicit pair affects only the routes that use it. Edge reports the problem and keeps those routes on the configured TLS mode. Scoped control clients can use the operator's configured certificates, while file selection belongs to the Edge administrator.

## Check a certificate problem

Read the operational logs or inspect `GET /status` through the [control API](control-api.md). For custom certificates, Edge reports problems by hostname, such as a missing key, a certificate outside its validity dates or a file whose DNS names do not cover the route. A route that requires HTTPS stays unavailable until it has a usable certificate. Other hosts continue to work.

See the [logging guide](logging.md#diagnose-a-custom-certificate) for operational log settings.

See the [complete configuration example](examples.md) for the Edge config, routes JSON and Compose YAML together.
