# Install Total.js Proxy

## Install with Docker Compose

From a checkout of this repository, build the image and start the deployment:

```sh
docker build -t totaljs-proxy:local .
docker compose -f deploy/compose.yaml up -d
```

Before starting, rename `deploy/data/sites/app.example.com.json` after your domain and edit its `hosts` and `target`. The example sends `app.example.com` to `app:8000` on the existing `proxy` Docker network. Connect your app to that network, or set `PROXY_NETWORK` to the network you already use. Point public DNS at the server and allow inbound TCP ports 80 and 443 for automatic HTTPS.

The deployment mounts two folders next to the Compose file. Make both writable by the container user (UID 1000):

| Folder | What it holds |
|---|---|
| `deploy/data` | `config.json`, `sites/*.json`, and the certificates and account that Proxy keeps. Back it up and keep it between upgrades. |
| `deploy/logs` | One log per site and `error.log`, see [Logging](logging.md). |

Proxy applies a change of `config.json` or of a site file by itself within a few seconds. A file with a mistake is not applied and `logs/error.log` says why. The deployment uses the local build by default. Set `PROXY_IMAGE` to use a different image.

## Run a Total.js app from its Compose file

The [Total.js example](../examples/totaljs) uses `totalplatform/run:npm` and declares its domain, internal port and logging in the app's Compose environment. Start the shared Proxy once from the repository root:

```sh
docker network inspect proxy >/dev/null 2>&1 || docker network create proxy
docker compose -p proxy-demo -f examples/totaljs/proxy.compose.yaml up --build -d
```

Then start the app and check it over HTTP:

```sh
docker compose -p proxy-demo-app -f examples/totaljs/compose.yaml up -d
curl --resolve hello.localhost:80:127.0.0.1 http://hello.localhost/
```

Allow time for `npm install`. Proxy sees the container join the `proxy` network and writes `examples/totaljs/data/sites/hello.localhost.json`; `docker compose stop` removes it again. Only Proxy publishes host ports. To add another app, attach its service to `proxy` and set its own `PROXY_HOST`. For public HTTPS, use a real domain with the `https://` prefix and point its DNS at Proxy. See [Docker discovery](docker-discovery.md) for the variables, the Docker socket and the alternatives to mounting it.

## Run with named volumes

```yaml
services:
  proxy:
    image: totaljs-proxy:local
    restart: always
    ports:
      - 80:80
      - 443:443
      # Only for wildcard certificates:
      # - 53:53/udp
      # - 53:53/tcp
    volumes:
      - proxy-data:/proxy/data
      - proxy-logs:/proxy/logs

networks:
  default:
    name: proxy
    external: true

volumes:
  proxy-data:
  proxy-logs:
```

Proxy and the project containers share the `proxy` network, so a site can point to a container by its name. With named volumes, write `config.json` and the site files inside the `proxy-data` volume, or let [Docker discovery](docker-discovery.md) write the sites.

The image runs as the `node` user and can bind the low ports. Keep `proxy-data` mounted only in Proxy: it has the private keys. For a bind mount instead of a named volume, make the host directory writable by the container's `node` user.

See the [complete configuration example](examples.md) for the Proxy config, site files and Compose YAML together.
