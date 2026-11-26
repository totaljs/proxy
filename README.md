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

Total.js Proxy is a self-hosted reverse proxy for Total.js apps and other HTTP services. Point a domain at your server and tell Proxy which container to reach. Proxy routes requests by hostname, forwards WebSockets, and issues and renews Let's Encrypt certificates, including wildcards. Everything is set with files that Proxy watches: one JSON file for each site, or none at all when the containers publish themselves.

## Run it on a server

You need a Linux server with Docker and the ports 80 and 443 open. Proxy and your apps meet on one Docker network, named `proxy`.

### With the install script

Go to the folder where Proxy should live and run:

```sh
curl -fsSL https://raw.githubusercontent.com/totaljs/proxy/main/install.sh -o install.sh
bash install.sh
```

The script makes the Docker network `proxy` and a folder `proxy` in the current folder with `compose.yaml`, `.env`, `data` and `logs`, then starts Proxy. It asks for `sudo` once, to give `data` and `logs` to the user of the container. Run it again to update to the newest image: a `compose.yaml` that is already there is kept. `PROXY_DIR`, `PROXY_IMAGE` and `PROXY_NETWORK` change the folder, the image and the network.

Then go to [Publish an app](#publish-an-app).

### By hand

**1. Create the network and a folder for Proxy**

```sh
docker network create proxy
mkdir -p /srv/proxy/data /srv/proxy/logs
cd /srv/proxy
```

**2. Save this as `/srv/proxy/compose.yaml`**

```yaml
services:
  proxy:
    image: totalplatform/proxy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./data:/proxy/data
      - ./logs:/proxy/logs
      - /var/run/docker.sock:/var/run/docker.sock:ro
    group_add:
      - "${DOCKER_GID}"
    networks: [proxy]

networks:
  proxy:
    external: true
```

**3. Let the container write its folders and read the Docker socket, then start it**

Proxy runs as the user `node` (UID 1000), not as root.

```sh
sudo chown 1000:1000 data logs
echo "DOCKER_GID=$(stat -c %g /var/run/docker.sock)" > .env
docker compose up -d
```

Proxy now answers on the server. A domain that has no site yet gets a page that says so.

### Publish an app

Point the DNS of your domain to the server. In the Compose file of the app, say which domain it serves and on which port it listens, and put it on the `proxy` network:

```yaml
services:
  app:
    image: totalplatform/run:npm
    restart: unless-stopped
    volumes:
      - ./app:/www
    environment:
      PROXY_HOST: "https://example.com,https://www.example.com"
      PROXY_PORT: "8000"
    networks: [proxy]

networks:
  proxy:
    external: true
```

Start the app with `docker compose up -d`. Proxy sees the container, writes `data/sites/example.com.json`, gets a Let's Encrypt certificate for the names written with `https://` and serves the app. When the container stops, the site goes with it. The app publishes no ports.

For an app that is not a container on this network, write the file yourself. Proxy applies it within a few seconds, without a restart:

`/srv/proxy/data/sites/example.com.json`

```json
{
  "hosts": ["https://example.com", "https://www.example.com"],
  "target": "10.0.0.5:8000"
}
```

### Check that it works

```sh
docker compose logs proxy
cat logs/error.log
```

`logs/error.log` names anything that was not applied and why: a site file with a mistake, a certificate that could not be issued, an app that does not answer. Each site has its own `logs/<site>.log`.

### What is where

| Path | What it holds |
|---|---|
| `compose.yaml`, `.env` | How the container of Proxy is started. |
| `data/config.json` | The settings of Proxy. Optional: without it the defaults apply. |
| `data/sites/` | One JSON file for each site. |
| `data/certs/` | The certificates of Let's Encrypt, and your own as `<name>.crt` + `<name>.key`. |
| `data/stats/` | The request counters of each site. |
| `logs/` | One log for each site and `error.log`. |

Back up `data`: it has the private keys. Every file is watched, so there is no command to check or reload anything.

Mounting the Docker socket lets Proxy see which containers publish themselves, and whoever has the socket controls Docker on that server. [Docker discovery](docs/docker-discovery.md) describes how to run without it.

## Build from source

```sh
docker build -t totalplatform/proxy .
```

## Documentation

- [Install Proxy](docs/installation.md) with the Compose files of this repository.
- [Deploy Total.js Flow with Proxy](docs/flow.md) for a complete example with a domain and automatic HTTPS.
- [Configure Proxy](docs/configuration.md): `config.json`, site options, workers, wildcard domains and request counters.
- [Restrict app access](docs/access.md) with IP lists, passwords and per-route headers.
- [Choose TLS per app](docs/tls.md) for HTTP, automatic certificates or your own.
- [Discover Docker apps](docs/docker-discovery.md): a container sets `PROXY_HOST` and its site appears, and goes when it stops.
- [Read the logs](docs/logging.md) of each site and `error.log`, with a size limit.
- [Operate and recover Proxy](docs/operations.md) for health checks, backups and recovery.
- [Run the tests](docs/testing.md), including [certificate issuance and renewal with Pebble](test/pebble/README.md).
- [Complete configuration example](docs/examples.md) with a full `config.json`, site files and Compose YAML.
