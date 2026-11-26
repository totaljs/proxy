# Choose TLS for each app

Set `cert` in the file of each site. These three apps can run behind the same Proxy instance. Each object below is one site file in `data/sites`, named after its `id` (for example `data/sites/preview.json`) and saved without the `id` field. Proxy applies a saved file by itself.

```json
[
  {
    "id": "preview",
    "hosts": ["preview.example.com"],
    "target": "http://preview:8000",
    "cert": "off"
  },
  {
    "id": "shop",
    "hosts": ["shop.example.com"],
    "target": "http://shop:8000",
    "cert": "auto"
  },
  {
    "id": "portal",
    "hosts": ["portal.example.com"],
    "target": "http://portal:8000",
    "cert": "custom",
    "cert_file": "portal/fullchain.pem",
    "key_file": "portal/private-key.pem"
  }
]
```

- **`off`** is the default and serves the app over HTTP. Proxy skips certificate issuance for the route.
- **`auto`** enables automatic certificates. Point DNS at Proxy and allow public TCP ports 80 and 443. Proxy requests and renews the certificate using Let’s Encrypt by default. While the site waits for a certificate, Proxy keeps ACME validation available and returns a temporary 503 for normal HTTP requests. See [wildcard certificates](configuration.md#wildcard-certificates) for DNS validation. A matching custom certificate discovered by Proxy takes precedence.
- **`custom`** uses the PEM chain and key you provide. In the example, Proxy reads both paths under `custom_cert_dir`, which defaults to `data/tls`. Put the leaf certificate first in the chain, followed by any intermediates.

When a certificate is ready, HTTP redirects to HTTPS by default. The separate `https: false` option allows HTTP alongside TLS.

## Add your own certificate

Put two PEM files in `data/certs`, next to the certificates of Let's Encrypt:

| File | What it is |
|---|---|
| `totaljs.com.crt` or `totaljs.com.pem` | The certificate, followed by its intermediates (the "full chain"). `.crt` and `.pem` mean the same. |
| `totaljs.com.key` | The private key of that certificate, with the same name. |

Then serve the name over HTTPS in its site file:

```json
{
  "hosts": ["https://totaljs.com", "https://www.totaljs.com"],
  "target": "172.18.0.5:8000",
  "cert": "custom"
}
```

- Proxy picks the pair up within a few seconds, also when you replace it with a renewed one or remove it. No restart is needed.
- Which names a certificate serves is read from the certificate itself (its DNS names), not from the file name. One file can serve `totaljs.com` and `www.totaljs.com`, and a wildcard certificate serves every name under it.
- Your certificate wins over one of Let's Encrypt for the same name and is never renewed by Proxy: replace the files before it expires.
- `"cert": "custom"` tells Proxy to never ask Let's Encrypt for these names. Without it, a name written as `https://` uses your certificate when one is there and asks Let's Encrypt when it is not.
- A pair that cannot be used (a missing `.key`, a key of another certificate, an expired certificate) is reported in `logs/error.log` and in `data/status.json`.

The folder `data/custom` takes the same pairs.

## Configure certificates in Compose

Keep `"cert": "custom"` on each route. If you prefer to configure its files in Compose, omit `cert_file` and `key_file` from that site file. Set `PROXY_CUSTOM_CERTS` on the **Proxy service**, keyed by route ID:

```yaml
services:
  proxy:
    environment:
      PROXY_CUSTOM_CERTS: >-
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
      - ./cert:/proxy/data/cert:ro
```

Set `shop` to `cert: custom` and add a `docs` route for `docs.example.com` with the same mode to try this configuration. Here `portal` uses its own certificate, and `shop` and `docs` reuse the pair in `./tls/shared/`. A certificate for `*.example.com` covers both `shop.example.com` and `docs.example.com`. Include the root domain separately in the certificate if a route also serves `example.com`. A wildcard covers one label and does not cover `dev.shop.example.com`.

If a route has explicit paths in both places, the pair in the site file takes precedence. With neither pair configured, Proxy discovers certificates from `data/custom/`, where the `.pem` or `.crt` and `.key` share a basename. To use another directory for explicit paths, set `custom_cert_dir` in `config.json` and mount the files there. The files must be readable by the Proxy user, and symlinks must resolve within that directory. Restart Proxy after replacing the certificate or private key files. Recreate the container after changing its Compose environment.

An invalid explicit pair affects only the routes that use it. Proxy reports the problem and keeps those routes on the configured TLS mode.

## Check a certificate problem

Read `logs/error.log` or `data/status.json`. For custom certificates, Proxy reports problems by hostname, such as a missing key, a certificate outside its validity dates or a file whose DNS names do not cover the route. A route that requires HTTPS stays unavailable until it has a usable certificate. Other hosts continue to work.

See the [logging guide](logging.md#diagnose-a-custom-certificate) for operational log settings.

See the [complete configuration example](examples.md) for the Proxy config, routes JSON and Compose YAML together.
