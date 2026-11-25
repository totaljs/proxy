# Discover Docker apps

This example runs two copies of Flow on one Proxy. The operations copy keeps a hand-written route. The second copy appears automatically while its container is running on the Docker network `proxy`.

| App | Public hostname | Source |
|---|---|---|
| Operations | `ops.example.com` | `routes.json` |
| Demo | `demo.example.com` | Docker container labels |

## Configure Proxy

Use a Proxy build that supports `docker_routes_file`. To build from the source checkout, run `docker build -t proxy-discovery .` and set the Proxy service image to `proxy-discovery`.

In the Proxy config, add these two settings:

```text
routes_file        : routing/routes.json
docker_routes_file : discovered/routes.docker.json
```

Keep the manual file under `./routing` and create a separate directory for the generated file. Add both directory mounts to the Proxy service in Compose:

```yaml
services:
  proxy:
    volumes:
      - ./routing:/proxy/routing:ro
      - ./discovered:/proxy/discovered:ro
```

This example assumes the config is at `/proxy/proxy.conf` and Proxy is already attached to `proxy`. Keep your existing config and data mounts. Mount the directories so that atomic file replacement is visible inside the container. The generated file can be missing at startup. This setup uses file-managed routing. The control API still lists routes and certificate status.

## Declare domains in the app Compose file

Use the same environment variables in a generated Compose file. The working [Total.js example](../examples/totaljs/compose.yaml) shows the standalone setup. The following is a generator template. Substitute the app ID and the host paths for `www` and `npm` before running Compose.

```yaml
services:
  app:
    container_name: "{{ value.id }}"
    image: totalplatform/run:npm
    restart: always
    volumes:
      - "{{ value.www }}:/www"
      - "{{ value.npm }}:/node_modules:ro"
    environment:
      PROXY_HOST: "https://example.com,https://www.example.com"
      PROXY_PORT: "80"
      # Optional directory under Proxy's custom_cert_dir.
      # PROXY_CERT: shared/example
      PROXY_LOGS: "true"
    networks: [proxy]

networks:
  proxy:
    external: true
```

| Variable | What it configures |
| --- | --- |
| `PROXY_HOST` | Comma-separated hostnames or HTTP(S) origins without paths or ports. `https://` selects automatic certificates, and `http://` selects HTTP. A bare hostname uses HTTP unless a custom certificate is configured. Set an empty value to disable discovery for a temporary container. |
| `PROXY_PORT` | The actual HTTP port inside the app container, defaulting to 80. The app must listen on this port. Use 8000 for apps that listen there. |
| `PROXY_CERT` | Optional directory relative to Proxy's `custom_cert_dir`. Proxy uses `fullchain.pem` and `privkey.pem` from that directory for HTTPS or bare host entries. Multiple apps can reference the same wildcard certificate. Mount these files into Proxy. |
| `PROXY_LOGS` | Set to `true` to enable or `false` to disable per-route access logs. Proxy needs a configured access log destination. |

Existing containers can still use the `edge.host`, `edge.port` and `edge.tls` labels. A container with `PROXY_HOST` uses its environment configuration. Hand-written routes keep priority in both cases.

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
      proxy.host: demo.example.com
      proxy.port: "8000"
      proxy.tls: auto
    networks: [proxy]

volumes:
  demo-data:

networks:
  proxy:
    external: true
```

Use a distinct, single-label container name for each app. The watchdog uses that name to reach the upstream on Docker DNS. The `proxy.tls` label defaults to `off` and also accepts `custom` and `auto`. Follow the [Flow setup guide](flow.md) to configure Flow privately before pointing the public DNS records at Proxy.

From the Proxy source checkout on the Docker host, run the watchdog. Replace the example path with the host directory mounted above.

```sh
node scripts/docker-watch.js proxy /srv/proxy/discovered/routes.docker.json
```

The host account running this command needs Docker access and write access to the generated file's directory. Proxy reads that directory through its read-only mount. Use `--once` at the end of the command to generate a single snapshot.

## Check what happens when apps change

1. Run `docker compose up -d flow-demo` in the demo project. The watchdog refreshes its snapshot on Docker network events. Proxy checks the files every five seconds.
2. Check Proxy's route list. It should show the manual operations route and the discovered demo route. Stop the demo with `docker compose stop flow-demo` and check again. Only the operations route remains.
3. If you put `demo.example.com` in the manual file, Proxy uses the manual route, including when the manual route is a matching wildcard. This also applies to manual redirect hostnames and colliding route IDs. If two discovered containers declare the same hostname, the watchdog publishes neither for that hostname.

The watchdog also reconciles at startup, after reconnecting to Docker events, and every 30 seconds. When Docker cannot be inspected, it keeps the previous snapshot. If you disable discovery permanently, remove `docker_routes_file` from the Proxy config or remove the generated file.

See the [complete configuration example](examples.md) for the Proxy config, routes JSON and Compose YAML together.
