# Discover Docker apps

This example runs two copies of Flow on one Proxy. The operations copy keeps a hand-written route. The second copy appears automatically while its container is running on the Docker network `proxy`.

| App | Public hostname | Source |
|---|---|---|
| Operations | `ops.example.com` | `routes.json` |
| Demo | `demo.example.com` | Docker container labels |

## Configure Proxy

Use an Proxy build that supports `docker_routes_file`. To build from the source checkout, run `docker build -t edge-discovery .` and set the Proxy service image to `edge-discovery`.

In the Proxy config, add these two settings:

```text
routes_file        : routing/routes.json
docker_routes_file : discovered/routes.docker.json
```

Keep the manual file under `./routing` and create a separate directory for the generated file. Add both directory mounts to the Proxy service in Compose:

```yaml
services:
  edge:
    volumes:
      - ./routing:/edge/routing:ro
      - ./discovered:/edge/discovered:ro
```

This example assumes the config is at `/edge/edge.conf` and Proxy is already attached to `proxy`. Keep your existing config and data mounts. Mount the directories so that atomic file replacement is visible inside the container. The generated file can be missing at startup. This setup uses file-managed routing. The control API still lists routes and certificate status.

## Add one route by hand

Keep this entry in `./routing/routes.json`. Connect its upstream `flow-ops` to `proxy`.

```json
[
  {
    "id": "flow-ops",
    "hosts": ["ops.example.com"],
    "target": "http://flow-ops:8000",
    "tls": "auto"
  }
]
```

## Discover the second app

In the demo app's Compose project, label the service with its public hostname and internal HTTP port, then attach it to the same network:

```yaml
services:
  flow-demo:
    image: totalplatform/flow:11
    volumes:
      - demo-data:/www/.src/databases
    labels:
      edge.host: demo.example.com
      edge.port: "8000"
      edge.tls: auto
    networks: [proxy]

volumes:
  demo-data:

networks:
  proxy:
    external: true
```

Use a distinct, single-label container name for each app. The watchdog uses that name to reach the upstream on Docker DNS. The `edge.tls` label defaults to `off` and also accepts `custom` and `auto`. Follow the [Flow setup guide](flow.md) to configure Flow privately before pointing the public DNS records at Proxy.

From the Proxy source checkout on the Docker host, run the watchdog. Replace the example path with the host directory mounted above.

```sh
node scripts/docker-watch.js proxy /srv/edge/discovered/routes.docker.json
```

The host account running this command needs Docker access and write access to the generated file's directory. Proxy reads that directory through its read-only mount. Use `--once` at the end of the command to generate a single snapshot.

## Check what happens when apps change

1. Run `docker compose up -d flow-demo` in the demo project. The watchdog refreshes its snapshot on Docker network events. Proxy checks the files every five seconds.
2. Check Proxy's route list. It should show the manual operations route and the discovered demo route. Stop the demo with `docker compose stop flow-demo` and check again. Only the operations route remains.
3. If you put `demo.example.com` in the manual file, Proxy uses the manual route, including when the manual route is a matching wildcard. This also applies to manual redirect hostnames and colliding route IDs. If two discovered containers declare the same hostname, the watchdog publishes neither for that hostname.

The watchdog also reconciles at startup, after reconnecting to Docker events, and every 30 seconds. When Docker cannot be inspected, it keeps the previous snapshot. If you disable discovery permanently, remove `docker_routes_file` from the Proxy config or remove the generated file.

See the [complete configuration example](examples.md) for the Proxy config, routes JSON and Compose YAML together.
