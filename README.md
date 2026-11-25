<p align="center">
  <img src="assets/proxy-mark.svg" alt="Total.js Proxy logo" width="96" height="96">
</p>

<h1 align="center">Total.js Proxy</h1>

<p align="center">
  <a href="https://www.totaljs.com/"><img src="https://img.shields.io/badge/Total.js-Platform-147D64" alt="Total.js Platform"></a>
  <a href="docs/configuration.md"><img src="https://img.shields.io/badge/HTTPS-Let%27s%20Encrypt-147D64?logo=letsencrypt&amp;logoColor=white" alt="Automatic HTTPS with Let's Encrypt"></a>
  <a href="docs/installation.md"><img src="https://img.shields.io/badge/Linux-amd64%20%2F%20arm64-334155?logo=linux&amp;logoColor=white" alt="Linux amd64 and arm64"></a>
  <img src="https://img.shields.io/badge/Node.js-24-43853D?logo=nodedotjs&amp;logoColor=white" alt="Node.js 24">
</p>

<p align="center">Publish your Docker apps with a domain and automatic HTTPS.</p>

Total.js Proxy is a self-hosted reverse proxy for Total.js apps and other HTTP services. Point a domain at your server and tell Proxy which container to reach. Proxy routes requests by hostname, forwards WebSockets, and issues and renews Let's Encrypt certificates, including wildcards. Run it with Docker Compose or manage domains through Total.js Code.

## Get started

```sh
docker build -t totaljs-proxy:local .
```

- [Install Proxy](docs/installation.md) with Docker Compose or build it from source.
- [Deploy Total.js Flow with Proxy](docs/flow.md) for a complete example with a domain and automatic HTTPS.
- [Configure Proxy](docs/configuration.md) for wildcard domains, headers and visit statistics.
- [Restrict app access](docs/access.md) with IP lists, passwords and per-route headers.
- [Choose TLS per app](docs/tls.md) for HTTP, automatic certificates or your own.
- [Discover Docker apps](docs/docker-discovery.md) while keeping hand-written routes in control.
- [Shared apps](docs/shared-apps.md) with a token and hostname allowlist for each app or deployment tool.
- [Use the control API](docs/control-api.md) to manage routes or connect Total.js Code.
- [Configure access and operational logs](docs/logging.md) for each deployment and app.
- [Operate and recover Proxy](docs/operations.md) for health checks, backups and recovery.
- [Run the tests](docs/testing.md), including [certificate issuance and renewal with Pebble](test/pebble/README.md).
- [Complete configuration example](docs/examples.md) with an annotated config, routes JSON and Compose YAML.
