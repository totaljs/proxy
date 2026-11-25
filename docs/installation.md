# Install Total.js Edge

## Install the Docker image

Total.js Edge is available for Linux x86-64 and ARM64 from GitHub Container Registry. With Docker Compose v2 installed, download the deployment files into a new directory:

```sh
base="https://raw.githubusercontent.com/totaljs-es/edge/v0.1.1/deploy"
for file in compose.yaml edge.conf routes.json; do
  curl -fSLO "$base/$file" || break
done
```

Use deployment files from the same release as your image. The current source uses `tls: auto` for automatic certificates. The v0.1.1 example comes from its release tag.

Edit `routes.json` to set your domain and the app's address inside Docker. The default target, `http://app:8000`, assumes the app is reachable as `app` on the `proxy` network. Connect both services to the same Docker network. Set `EDGE_NETWORK` if your network uses a different name.

Point the domain's DNS at the server and allow inbound TCP ports 80 and 443. Start Edge on the server that will own those ports:

```sh
docker compose up -d
```

Keep the `edge-data` volume between upgrades. The Compose file defaults to `latest`, which tracks the newest stable image. Set `EDGE_VERSION` in a local `.env` file to install a specific version. To upgrade, run `docker compose pull edge` and `docker compose up -d edge`. The current source checks for route changes every five seconds. With the published 0.1.1 image, run `docker compose up -d --force-recreate edge` after changing routes.

## Build from source with a Total.js example

From the repository root, run:

```sh
docker compose -f examples/totaljs/compose.yaml up --build -d
curl --resolve hello.localhost:80:127.0.0.1 http://hello.localhost/
```

The example includes a Total.js app on port 8000 and builds a local image tagged `totaljs-edge:0.1.1`. Only Edge publishes host ports. The first request may return 503 while the example app starts. Retry once it is ready.

To go public, point your domain at the server, allow inbound TCP ports 80 and 443, and replace `hello.localhost` in [the example routes](../examples/totaljs/routes.json) with your domain. Set `"tls": "auto"` to enable Let's Encrypt. Check certificate status after Edge picks up the updated route:

```sh
docker compose -f examples/totaljs/compose.yaml exec edge node -e 'require("node:http").get({socketPath:"/edge/control/edge.sock",path:"/status"},res=>res.pipe(process.stdout))'
```

The status lists certificates and any issuance errors. Keep the `edge-data` volume across deploys to preserve your certificates and ACME account. To serve your own app, change the `app` service and set `target` to its HTTP address on the Compose network.

### Choose how to manage routes

Set `routes_file` to manage routes with a JSON file such as the example. Mount its containing directory read-only so Edge can see both in-place edits and files replaced by an editor. If an existing setup mounts only the file, switch to a directory mount and recreate Edge once. Route inspection and certificate operations remain available through the control socket. Leave `routes_file` empty when Code or another API client manages routes. Use a separate Edge instance for standalone apps when Code manages the shared settings of its own instance.

## Run with API-managed routes

```yaml
services:
  edge:
    image: ghcr.io/totaljs-es/edge:latest
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

The image runs as the `node` user and can bind the low ports. For Code, mount the same `edge-control` volume at `/edge/control` in both services and configure Code to use `/edge/control/edge.sock`. The socket is owner-only, so the client needs the owning UID or root access. Keep `edge-data` mounted only in Edge. For a bind mount instead of a named volume, make the host directory writable by the container’s `node` user.

See the [complete configuration example](examples.md) for the Edge config, routes JSON and Compose YAML together.
