# Configure Total.js Proxy

## Config

Proxy runs from one data folder: `node index.js data`. Its settings are the JSON object in `data/config.json`. Every key is optional, and without the file Proxy uses the defaults.

```json
{
  "email": "ops@example.com",
  "workers": 2,
  "logs_maxsize": 100
}
```

Proxy reads the file again every two seconds and applies a change by itself, so there is no command to check or reload the config:

- A file with a mistake (invalid JSON, an unknown key, a wrong value) is not applied. Proxy keeps running as it was and writes the reason to `logs/error.log`.
- Limits, `ratelimit`, `deny`, headers, HSTS, `page`, compression, upload size, error pages, `renew_days`, `stats_days` and `logs_maxsize` apply while Proxy runs, without closing a connection.
- Any other key (ports, `workers`, ACME, DNS, Docker, folders) starts Proxy again with the new config, which closes open connections. If Proxy cannot start with it, for example because a port is taken, the config of before comes back.

Relative paths start at the folder that holds `data`. The sites are separate files: see [Sites](#sites).

| Key | Default | |
|---|---|---|
| `email` | | Contact of the Let's Encrypt account (optional) |
| `acme` | Let's Encrypt | The ACME server. For tests: `https://acme-staging-v02.api.letsencrypt.org/directory` |
| `acme_ca` | | Optional PEM CA file for a private ACME server, relative to the config. |
| `http`, `https` | `80`, `443` | Ports |
| `dns` | `0` | Port of the DNS server for wildcards: `53` to turn it on |
| `dns_zone` | | The zone delegated to Proxy, for example `acme.code.example.com` |
| `dns_ns` | | The name of this server in the NS record, for example `ns.code.example.com` |
| `custom_cert_dir` | `data/tls` | Directory for explicitly configured certificate and key paths. See [per-app TLS](tls.md). |
| `docker` | `/var/run/docker.sock` | The socket of Docker, or `http://host:port` of a socket proxy, for [Docker discovery](docker-discovery.md). Without the socket, or when empty, discovery is off. |
| `docker_network` | `proxy` | The Docker network whose containers publish themselves with `PROXY_HOST`. |
| `renew_days` | `30` | Days before expiry to renew |
| `workers` | `1` | Processes that serve HTTP, HTTPS and WebSockets. `0` starts one for each CPU core. See [Workers](#workers). |
| `upstream_connections` | `128` | Maximum concurrent HTTP connections to one backend host and port. Requests wait for a free socket while the route and global request limits apply. |
| `upstream_idle_connections` | `128` | Maximum idle HTTP connections kept for reuse per backend host and port, capped by `upstream_connections`. |
| `http_active`, `http_active_per_route` | `2048`, `256` | Concurrent HTTP requests globally and per route |
| `ws_active`, `ws_active_per_route` | `1024`, `128` | Concurrent WebSocket upgrades and connections globally and per route |
| `http_active_per_ip`, `ws_active_per_ip` | `64`, `32` | Concurrent HTTP requests and WebSocket connections of one address, on all the sites together. Past it, 429. One address (slow uploads, connections left open) never holds every slot of a site. Raise it when many people reach Proxy through one address, such as an office or another proxy in front. |
| `precheck` | `true` | Checks the DNS record of a wildcard before asking for it |
| `headers` | | Headers for every site: `{ "Name": "value" }` or `"Name: value \| Name: value"`. Added only when the app does not send the same header; `Strict-Transport-Security` only over HTTPS |
| `hsts` | `max-age=31536000` | The value of HSTS for the routes that turn it on |
| `maxupload` | `50` | Largest request body in MB, for routes without their own |
| `compress` | `true` | Brotli or gzip for text the app sends uncompressed (HTML, CSS, JavaScript, JSON, SVG, XML), from 1 KB |
| `errors` | `data/errors` | Own pages: `401.html`, `403.html`, `404.html`, `413.html`, `429.html`, `502.html`, `503.html`, `504.html` (read at start). `503.html` (or `502.html`) is the page of every site whose container does not answer, under the one of the site and of the settings |
| `ratelimit` | `0` | Requests a second that one address may send, to all the sites together: `100`. Four times as many may come at once, so a page with its images, styles and scripts fits. Past it, 429 with `Retry-After`. `0` is no limit. A site opts out with `"limit": false`. |
| `deny` | `[]` | Addresses or networks that reach no site: `["203.0.113.7", "10.0.0.0/8"]` |
| `page` | | The HTML of the page of every site without its own, shown while its app does not answer (512 KB at most) |
| `logs` | `logs` | Folder of the log files, created at start. Empty turns the files off. See [Logging](logging.md). |
| `logs_maxsize` | `100` | Largest size of one log file in MB. A full file becomes `<name>.log.1` and a new one starts. |
| `stats_days` | `400` | Days the [request counters](#request-counters) of the sites are kept |

ACME renewals store the private key and certificate chain in one owner-only file. Back up the entire data volume together.

Running Proxy means accepting the terms of the ACME server in `acme`.

See the [logging guide](logging.md) for the log files and the per-site option.

## Sites

Each site is a JSON file in `data/sites`, named after the site:

`data/sites/totaljs.com.json`

```json
{
  "hosts": ["totaljs.com", "www.totaljs.com"],
  "target": "172.18.0.5:8000",
  "logs": true
}
```

`hosts` are the host names of the site and `target` is the address and port of its app, with or without `http://`. A container name works when Proxy shares a Docker network with the app (`app:8000`). `logs` writes the requests to `logs/totaljs.com.log` and is on unless you set `false`. The other fields (`cert`, `redirects`, `auth`, `headers` and more) are in [Site options](#site-options).

A host name can say how it is served:

```json
{
  "hosts": ["https://totaljs.com", "http://www.totaljs.com", "api.totaljs.com"],
  "target": "172.18.0.5:8000"
}
```

| Written as | Served |
|---|---|
| `https://totaljs.com` | Over HTTPS. Proxy gets a Let's Encrypt certificate for the name and redirects HTTP to HTTPS. With `"cert": "custom"` it uses your certificate instead. |
| `http://www.totaljs.com` | Over HTTP only: no certificate and no redirect, whatever `cert` says. |
| `api.totaljs.com` | As `cert` of the site says. Without `cert` that is HTTP. |

The same works in `redirects`. A port or a path is not part of a host name and is refused.

Proxy looks at the folder every two seconds:

- A file that is added, changed or removed is applied by itself. Other sites and open connections are not touched.
- A file with a mistake is not applied. Its site keeps what it had, the other sites change as written, and `logs/error.log` names the file and the reason.
- A host name belongs to one site. A file that takes a name of another site is refused.
- Containers of the Docker network `proxy` write their own file from `PROXY_HOST`, and it goes when they stop. See [Docker discovery](docker-discovery.md).
- A host name that no site has answers `404` with a page of Proxy that says the server works and nothing is published at that name yet, in English. Put your own `404.html` in `data/errors` to replace it.
- The file name without `.json` is the id of the site: letters, digits, `.`, `_` and `-`. It names the log file and the counters of the site.

## Workers

One Node.js process uses one CPU core. With `workers` above `1`, Proxy starts that many worker processes that share the HTTP and HTTPS ports, so requests and WebSockets use more cores:

```json
{
  "workers": 4
}
```

`0` uses every core the container may use. Proxy starts again by itself when you change the value in `config.json`. `PROXY_WORKERS` on the Proxy service overrides the file.

The main process keeps what exists once: the site files, Let's Encrypt, the DNS server, the request counters and the log files. It tells the workers when routes, certificates or settings change, and starts a new worker when one ends. With `workers : 1` everything runs in one process, as before.

What changes with more than one worker:

- `http_active`, `http_active_per_route`, `http_active_per_ip`, `ws_active`, `ws_active_per_route`, `ws_active_per_ip`, `upstream_connections` and `upstream_idle_connections` stay limits of the whole Proxy: each worker takes an equal part. A route can therefore answer `503` a little before its limit when its requests are not spread evenly.
- The rate limit of the config (`ratelimit`) is counted in each worker. An address that opens several connections can reach up to `workers` times the rate.
- A password of a protected site is checked once in each worker, then remembered there. Wrong passwords are counted in each worker too.
- Each worker needs memory of its own, so count it for every worker. More workers than cores do not help.

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

## Site options

Every field of a site file but `hosts` and `target` is optional:

| Field | Default | |
|---|---|---|
| `hosts` | | Host names; the first one is the main one. `https://name` serves that name over HTTPS with a certificate, `http://name` over HTTP only, and a name alone follows `cert`. |
| `redirects` | `[]` | Host names that redirect to the first host |
| `forwards` | `[]` | Host names that redirect to any address: `[{ "host": "old.example.com", "to": "https://new.example.com/", "path": true, "permanent": true }]`. `path` keeps the path of the request; `permanent` answers 301 (308 for other methods than GET and HEAD), else 302 (307). They get certificates when `cert` is on for the site. A site can have only these, without `hosts` nor `target` |
| `target` | | The app: `name:port` or `http://name:port`. Needed with `hosts` |
| `page` | | The HTML of the page of this site while its container does not answer, or in maintenance (512 KB at most) |
| `maintenance` | `false` | The page for every request, even when the container answers |
| `limit` | `true` | `false`: `ratelimit` of the config does not apply to this site |
| `https` | `true` | With a certificate, Proxy redirects HTTP to HTTPS once a usable one is available. Until then, it serves a temporary 503 and keeps ACME validation available. Set `https: false` to explicitly allow HTTP. |
| `hsts` | `false` | Sends `Strict-Transport-Security` |
| `logs` | `true` | `false`: the requests of the site are not written to `logs/<site>.log`. See [Logging](logging.md). |
| `maxupload` | the config | Largest request body in MB |
| `cert` | `off` | `off` for HTTP, `custom` for your own PEM certificate or `auto` for automatic issuance. See [TLS](tls.md). |
| `cert_file`, `key_file` | | Optional pair of PEM paths relative to `custom_cert_dir`. Requires `cert: custom`. |
| `challenge` | `http` | `dns` to check a normal name by DNS as well |
| `headers` | | Headers of this site, `{ "Name": "value" }`: they win over the ones of the config, never over the app |
| `allow` | | Only these addresses or networks (`10.0.0.0/8`, `2001:db8::/32`); the others get 403 |
| `deny` | | Never these addresses or networks |
| `auth` | | HTTP Basic users with scrypt hashes. See [Restrict access to an app](access.md) to generate a hash and combine IP and password checks. |
| `compress` | the config | `true` or `false` for this site |

The addresses are the ones Proxy sees, never a header of the request. The concurrent HTTP and WebSocket limits also apply to sites that opt out of the per-IP request rate. A right password is remembered for 10 minutes, so scrypt runs once per person and not on every request. An address may send five wrong passwords; after that it waits before each next try, 2 seconds, then 4, 8 and so on up to 5 minutes, and gets 429 meanwhile. A right password, or 15 minutes without a try, clears it.

An upload whose client sends nothing for 30 seconds is ended with 408.

A container that does not answer (stopped, starting, not there) gets the page of its site with **503** and `Retry-After: 60`, so search engines come back later: the `page` of the site, else `page` of the config, else `503.html` (or `502.html`) of the errors folder, else a plain page of Proxy in Spanish or English, as the visitor reads.

## Request counters

Proxy counts the requests of every site. It only counts: no pages, visitors or user agents. Those are in [`logs/<site>.log`](logging.md) for whoever wants to work them out. Counting costs a few additions in memory for a request, so it is always on and has no option.

`data/stats/totaljs.com.json`

```json
{
  "total": { "requests": 1532, "2xx": 1410, "3xx": 80, "4xx": 37, "5xx": 5, "ms": 61280, "failed": 5, "websockets": 12 },
  "days": {
    "2026-11-26": { "requests": 1532, "2xx": 1410, "3xx": 80, "4xx": 37, "5xx": 5, "ms": 61280, "failed": 5, "websockets": 12, "hours": [0, 0, 3] }
  }
}
```

| Field | |
|---|---|
| `requests` | The HTTP requests of the site, also the ones Proxy answered itself (a redirect, 401, 403, 429, 503). A request whose client went away before the answer ended counts as `4xx`. |
| `2xx`, `3xx`, `4xx`, `5xx` | The same requests by the kind of answer. |
| `ms` | The time of all the answers together. `ms / requests` is the average time of an answer. |
| `failed` | The requests that the app did not answer (stopped, too slow, no free connection). |
| `websockets` | The WebSocket connections that were opened. |
| `hours` | The requests of each hour of the day, 24 numbers, in UTC. |

`total` is of all time. `days` keeps `stats_days` days. The file is written once a minute for the sites that had requests, and when Proxy stops; a process that is killed loses at most that minute. With [workers](#workers) each worker counts by itself and sends its counts to the main process every few seconds, in one message for all the sites, so the cost does not grow with the traffic. Requests for a host name that no site has are not counted.

## Certificate status

`data/status.json` has the state of each certificate: `valid`, `requesting`, `waiting-dns` (with the DNS record to create) or `error` (with the reason and the time of the next try). To ask Let's Encrypt for a new certificate before its time, remove its file from `data/certs`: Proxy notices and asks again.

See the [complete configuration example](examples.md) for the Proxy config, site files and Compose YAML together.
