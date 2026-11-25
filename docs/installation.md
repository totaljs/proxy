# Install Total.js Proxy

## Install with Docker Compose

From a checkout of this repository, build the image and start the deployment:

```sh
docker build -t totaljs-proxy:local .
docker compose -f deploy/compose.yaml up -d
```

Before starting, edit `deploy/routes.json` with your domains and upstream addresses. The example uses `http://app:8000` on the existing `proxy` Docker network. Connect your app to that network, or set `EDGE_NETWORK` to the network you already use. Point public DNS at the server and allow inbound TCP ports 80 and 443 for automatic HTTPS.

Keep the `edge-data` volume between upgrades. The deployment uses the local build by default. Set `PROXY_IMAGE` to use a different image. Proxy checks file-managed routes for changes every five seconds.

## Build from source with a Total.js example

From the repository root, run:

```sh
docker compose -f examples/totaljs/compose.yaml up --build -d
curl --resolve hello.localhost:80:127.0.0.1 http://hello.localhost/
```

The example includes a Total.js app on port 8000 and builds a local image tagged `totaljs-proxy:local`. Only Proxy publishes host ports. The first request may return 503 while the example app starts. Retry once it is ready.

To go public, point your domain at the server, allow inbound TCP ports 80 and 443, and replace `hello.localhost` in [the example routes](../examples/totaljs/routes.json) with your domain. Set `"tls": "auto"` to enable Let's Encrypt. Check certificate status after Proxy picks up the updated route:

```sh
docker compose -f examples/totaljs/compose.yaml exec edge node -e 'require("node:http").get({socketPath:"/edge/control/edge.sock",path:"/status"},res=>res.pipe(process.stdout))'
```

The status lists certificates and any issuance errors. Keep the `edge-data` volume across deploys to preserve your certificates and ACME account. To serve your own app, change the `app` service and set `target` to its HTTP address on the Compose network.

### Choose how to manage routes

Set `routes_file` to manage routes with a JSON file such as the example. Mount its containing directory read-only so Proxy can see both in-place edits and files replaced by an editor. If an existing setup mounts only the file, switch to a directory mount and recreate Proxy once. Route inspection and certificate operations remain available through the control socket. Leave `routes_file` empty when Code or another API client manages routes. Use a separate Proxy instance for standalone apps when Code manages the shared settings of its own instance.

## Run with API-managed routes

```yaml
services:
  edge:
    image: totaljs-proxy:local
    restart: always
    ports:
      - 80:80
      - 443:443
      # Only for wildcard certificates:
      # - 53:53/udp
      # - 53:53/tcp
    volumes:
      - edge-data:/edge/data
      - edge-control:/edge/control

networks:
  default:
    name: proxy
    external: true

volumes:
  edge-data:
  edge-control:
```

The edge and the project containers share the `proxy` network, so a route can point to a container by its name.

The image runs as the `node` user and can bind the low ports. For Code, mount the same `edge-control` volume at `/edge/control` in both services and configure Code to use `/edge/control/edge.sock`. The socket is owner-only, so the client needs the owning UID or root access. Keep `edge-data` mounted only in Proxy. For a bind mount instead of a named volume, make the host directory writable by the container’s `node` user.

See the [complete configuration example](examples.md) for the Proxy config, routes JSON and Compose YAML together.
