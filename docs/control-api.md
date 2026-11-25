# Total.js Proxy control API

JSON over HTTP, on the Unix socket in `control/proxy.sock` (only its owner can open it):

| | |
|---|---|
| `GET /routes` | Every route |
| `GET /routes/{id}` | One route |
| `PUT /routes/{id}` | Adds or replaces a route |
| `DELETE /routes/{id}` | Removes a route |
| `GET /status` | Ports, DNS zone and the state of each certificate |
| `GET /stats/{id}` | The visits of a route, one entry a day (`?from=YYYY-MM-DD&to=YYYY-MM-DD`, the last 7 days by default) |
| `DELETE /stats/{id}` | Removes the visits of a route |
| `POST /renew/{host}` | Asks for a new certificate now |
| `GET /dns/{host}` | The CNAME record a host needs for the DNS check |
| `GET /settings` | The settings of every site |
| `PUT /settings` | Replaces them (see below) |

```bash
curl --unix-socket control/proxy.sock -X PUT http://proxy/routes/eshop \
  -d '{ "hosts": ["eshop.example.com", "*.clientes.example.com"], "redirects": ["www.eshop.example.com"], "target": "http://eshop:8000", "maxupload": 50, "tls": "auto" }'
```

With [scoped clients](shared-apps.md), send the instance token as `Authorization: Bearer <token>`. Routes, certificate status and statistics are scoped to the client. DNS records are available for its allowed domains. Global settings require the administrator token.

After publishing the example route, list it, check its certificate status and remove it with the same socket:

```bash
curl --unix-socket control/proxy.sock http://proxy/routes/eshop
curl --unix-socket control/proxy.sock http://proxy/status
curl --unix-socket control/proxy.sock -X DELETE http://proxy/routes/eshop
```

A route:

| Field | Default | |
|---|---|---|
| `hosts` | | Host names; the first one is the main one |
| `redirects` | `[]` | Host names that redirect to the first host |
| `forwards` | `[]` | Host names that redirect to any address: `[{ "host": "old.example.com", "to": "https://new.example.com/", "path": true, "permanent": true }]`. `path` keeps the path of the request; `permanent` answers 301 (308 for other methods than GET and HEAD), else 302 (307). They get certificates when TLS is enabled for the route. A route can have only these, without `hosts` nor `target` |
| `target` | | The container: `http://name:port`. Needed with `hosts` |
| `page` | | The HTML of the page of this site while its container does not answer, or in maintenance (512 KB at most) |
| `maintenance` | `false` | The page for every request, even when the container answers |
| `limit` | `true` | `false`: the limit of requests of the settings does not apply |
| `https` | `true` | With TLS enabled, Proxy redirects HTTP to HTTPS once a usable certificate is available. Until then, it serves a temporary 503 and keeps ACME validation available. Set `https: false` to explicitly allow HTTP or `tls: off` to disable TLS. |
| `hsts` | `false` | Sends `Strict-Transport-Security` |
| `accesslog` | the config | Enable or disable HTTP access logging for this route when a deployment destination is configured. |
| `accesslog_dir` | | Relative subdirectory for this route's daily file, inside the deployment access log directory. Ignored when logging to stdout. |
| `stats` | `false` | Counts the visits of the site (see below) |
| `maxupload` | the config | Largest request body in MB |
| `tls` | `off` | `off` for HTTP, `custom` for your own PEM certificate or `auto` for automatic issuance. |
| `cert_file`, `key_file` | | Optional pair of PEM paths relative to `custom_cert_dir`. Requires `tls: custom` and administrator access. |
| `challenge` | `http` | `dns` to check a normal name by DNS as well |
| `headers` | | Headers of this site, `{ "Name": "value" }`: they win over the ones of the config, never over the app |
| `allow` | | Only these addresses or networks (`10.0.0.0/8`, `2001:db8::/32`); the others get 403 |
| `deny` | | Never these addresses or networks |
| `auth` | | HTTP Basic users with scrypt hashes. See [Restrict access to an app](access.md) to generate a hash and combine IP and password checks. |
| `compress` | the config | `true` or `false` for this site |

The addresses are the ones Proxy sees, never a header of the request. The concurrent HTTP and WebSocket limits also apply to routes that opt out of the per-IP request rate. A right password is remembered for 10 minutes, so scrypt runs once per person and not on every request.

A container that does not answer (stopped, starting, not there) gets the page of its site with **503** and `Retry-After: 60`, so search engines come back later: the `page` of the route, else the one of the settings, else `503.html` (or `502.html`) of the errors folder, else a plain page of Proxy in Spanish or English, as the visitor reads.

The settings of every site, kept in `data/settings.json`:

| Field | |
|---|---|
| `ratelimit` | `{ "rate": 100, "burst": 400 }`: requests a second of each address, and how many at once. Past it, 429 with `Retry-After`. Off without it |
| `deny` | Addresses or networks that reach no site, before any route |
| `headers` | Headers of every site, `{ "Name": "value" }`: they win over `headers` of the config |
| `hsts` | The value of HSTS: it wins over `hsts` of the config |
| `page` | The page of every site without its own (512 KB at most) |

The state of each certificate is also kept in `data/status.json`: `valid`, `requesting`, `waiting-dns` (with the record to create) or `error` (with the reason and the time of the next try).

See the [complete configuration example](examples.md) for the Proxy config, routes JSON and Compose YAML together.
