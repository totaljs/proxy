# Configure Total.js Proxy

## Config

The `config` file, in the same `key : value` format as Total.js:

| Key | Default | |
|---|---|---|
| `email` | | Contact of the Let's Encrypt account (optional) |
| `acme` | Let's Encrypt | The ACME server. For tests: `https://acme-staging-v02.api.letsencrypt.org/directory` |
| `acme_ca` | | Optional PEM CA file for a private ACME server, relative to the config. |
| `http`, `https` | `80`, `443` | Ports |
| `dns` | `0` | Port of the DNS server for wildcards: `53` to turn it on |
| `dns_zone` | | The zone delegated to Proxy, for example `acme.code.example.com` |
| `dns_ns` | | The name of this server in the NS record, for example `ns.code.example.com` |
| `data` | `data` | Routes, certificates and the account |
| `custom_cert_dir` | `data/tls` | Directory for explicitly configured certificate and key paths. See [per-app TLS](tls.md). |
| `routes_file` | | Read-only JSON array of routes, relative to the config file. Proxy checks for changes every five seconds. An invalid update leaves the last valid routes active. |
| `docker_routes_file` | | Optional watchdog snapshot, relative to the config. Requires `routes_file`, whose routes take precedence. See [Docker discovery](docker-discovery.md). |
| `control` | `control/proxy.sock` | The control API: a Unix socket (in a folder that Code shares with Proxy, apart from its keys), or `host:port` with a `token` |
| `token` | | Administrator token. Network control requires this token or scoped clients. |
| `control_clients_file` | | JSON file of scoped tokens and allowed domains, relative to the config. See [Shared apps](shared-apps.md). |
| `renew_days` | `30` | Days before expiry to renew |
| `upstream_connections` | `128` | Maximum concurrent HTTP connections to one backend host and port. Requests wait for a free socket while the route and global request limits apply. |
| `upstream_idle_connections` | `128` | Maximum idle HTTP connections kept for reuse per backend host and port, capped by `upstream_connections`. |
| `http_active`, `http_active_per_route` | `2048`, `256` | Concurrent HTTP requests globally and per route |
| `ws_active`, `ws_active_per_route` | `1024`, `128` | Concurrent WebSocket upgrades and connections globally and per route |
| `precheck` | `true` | Checks the DNS record of a wildcard before asking for it |
| `headers` | | Headers for every site: `Name: value \| Name: value`. Added only when the app does not send the same header; `Strict-Transport-Security` only over HTTPS |
| `hsts` | `max-age=31536000` | The value of HSTS for the routes that turn it on |
| `maxupload` | `50` | Largest request body in MB, for routes without their own |
| `compress` | `true` | Brotli or gzip for text the app sends uncompressed (HTML, CSS, JavaScript, JSON, SVG, XML), from 1 KB |
| `errors` | `data/errors` | Own pages: `401.html`, `403.html`, `404.html`, `413.html`, `429.html`, `502.html`, `503.html`, `504.html` (read at start). `503.html` (or `502.html`) is the page of every site whose container does not answer, under the one of the site and of the settings |
| `eventlog` | `stdout` | Operational messages. Use `stdout`, `off`, or a directory for daily `proxy-YYYY-MM-DD.log` files. File logs keep up to 50 MB per day and 14 days. |
| `accesslog` | | Off when empty; `stdout`; or a directory with one file per route and day (`access-<route-id>-YYYY-MM-DD.log`) |
| `accesslog_default` | `true` | Whether routes inherit logging when a destination is configured. Set to `false` to log only routes with `"accesslog": true`. |
| `accesslog_days` | `14` | Days the files of the access log are kept |
| `accesslog_maxsize` | `500` | Maximum MB per route file and day |
| `stats_days` | `400` | Days the visits of the sites with `stats` are kept |

ACME renewals store the private key and certificate chain in one owner-only file. Existing ACME certificate pairs still load. Back up the entire data volume together.

Running Proxy means accepting the terms of the ACME server in `acme`.

See the [logging guide](logging.md) for deployment examples and per-route options.

## Wildcard certificates

Let's Encrypt gives wildcards only through a DNS check. Proxy answers that check itself, so there is no need for your DNS provider's API.

First, once for the whole server, delegate a small zone to Proxy in your DNS:

```text
acme.code.example.com.   NS   ns.code.example.com.
ns.code.example.com.     A    <IP of the server>
```

Then set `dns : 53`, `dns_zone : acme.code.example.com` and `dns_ns : ns.code.example.com` in the config, and open port 53.

Then, once for each wildcard, create the CNAME record that `GET /dns/{host}` returns, for example:

```text
_acme-challenge.clientes.example.com.   CNAME   3f9a2c41d07be81e5a6c.acme.code.example.com.
```

Proxy renews the certificate from then on with nothing more to do.

## Visits

For a Flow app, add `"stats": true` to its entry in `routes.json`:

```json
{
  "id": "flow",
  "hosts": ["flow.example.com"],
  "target": "http://flow:8000",
  "stats": true
}
```

Read its daily totals with `GET /stats/flow` on the [control API](control-api.md).

A route with `stats: true` counts its visits, in `data/stats/<route>/<YYYY-MM-DD>.json` (written every 5 minutes, kept
`stats_days` days). Without cookies and without personal data: a visitor is a hash of the address and the browser with a
salt that changes every day and is never written, so the addresses cannot be read back, and a visitor of one day cannot
be followed to the next.

The unique-visitor count is capped at 50,000 per route and 500,000 across Proxy per UTC day. When the limit is reached, `visitors_capped` is set and page views continue to count.

Each day records page views and visitors (people only), by hour too; each page with its views and its time to answer; the
other sites the visits come from (host only); the status codes; the pages that answered 404 and 5xx; and the search
engines (Googlebot, Bingbot…), AI agents (GPTBot, ClaudeBot, PerplexityBot…) and other bots, with the pages each one read
and when it came last. The files of a page (scripts, styles, images, fonts) and redirects are not page views.

See the [complete configuration example](examples.md) for the Proxy config, routes JSON and Compose YAML together.
