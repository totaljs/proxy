# Install Total.js Proxy

## Install with Docker Compose

From a checkout of this repository, build the image and start the deployment:

```sh
docker build -t totaljs-proxy:local .
docker compose -f deploy/compose.yaml up -d
```

Before starting, edit `deploy/routes.json` with your domains and upstream addresses. The example uses `http://app:8000` on the existing `proxy` Docker network. Connect your app to that network, or set `PROXY_NETWORK` to the network you already use. Point public DNS at the server and allow inbound TCP ports 80 and 443 for automatic HTTPS.

Keep the `proxy-data` volume between upgrades. The deployment uses the local build by default. Set `PROXY_IMAGE` to use a different image. Proxy checks file-managed routes for changes every five seconds.

When upgrading an older Compose deployment, stop the old proxy and mark `proxy-data` as an external volume in your Compose file and set `PROXY_DATA_VOLUME` to the existing Docker volume name before starting the new service. Existing custom bind mounts must target `/proxy`. Point control clients at the socket indicated by `control` in the new config. Code still calls its connection settings `edge` and `edge_token`.

## Run a Total.js app from its Compose file

The [Total.js example](../examples/totaljs) uses `totalplatform/run:npm` and declares its domain, internal port and access logging in the app's Compose environment. Set up the shared Proxy and Docker discovery once from the repository root:

```sh
docker network inspect proxy >/dev/null 2>&1 || docker network create proxy
docker compose -p proxy-demo -f examples/totaljs/proxy.compose.yaml up --build -d
node scripts/docker-watch.js proxy examples/totaljs/routes.docker.json
```

Leave the watchdog running. In a second terminal, start the app and check it over HTTP:

```sh
docker compose -p proxy-demo-app -f examples/totaljs/compose.yaml up -d
curl --resolve hello.localhost:80:127.0.0.1 http://hello.localhost/
```

Allow time for `npm install` and the route to appear. Only Proxy publishes host ports. To add another app, give its service a distinct container name, attach it to `proxy` and set its own `PROXY_HOST`. For public HTTPS, use a real domain with the `https://` prefix and point its DNS at Proxy. See [Docker discovery](docker-discovery.md) for multiple hostnames, custom certificates and access logs.

### Choose how to manage routes

Set `routes_file` to manage routes with a JSON file such as the example. Mount its containing directory read-only so Proxy can see both in-place edits and files replaced by an editor. If an existing setup mounts only the file, switch to a directory mount and recreate Proxy once. Route inspection and certificate operations remain available through the control socket. Leave `routes_file` empty when Code or another API client manages routes. Use a separate Proxy instance for standalone apps when Code manages the shared settings of its own instance.

## Run with API-managed routes

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
      - proxy-control:/proxy/control

networks:
  default:
    name: proxy
    external: true

volumes:
  proxy-data:
  proxy-control:
```

Proxy and the project containers share the `proxy` network, so a route can point to a container by its name.

The image runs as the `node` user and can bind the low ports. For Code, mount the same `proxy-control` volume at `/proxy/control` in both services and configure Code to use `/proxy/control/proxy.sock`. The socket is owner-only, so the client needs the owning UID or root access. Keep `proxy-data` mounted only in Proxy. For a bind mount instead of a named volume, make the host directory writable by the container’s `node` user.

See the [complete configuration example](examples.md) for the Proxy config, routes JSON and Compose YAML together.
