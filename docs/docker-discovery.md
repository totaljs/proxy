# Discover Docker apps

A container that joins the Docker network `proxy` can publish itself. It says in its environment which host names it serves, and Proxy writes its site file. When the container stops, Proxy removes the file. Nothing else is needed: no route to write, no reload.

## Declare the site in the app's Compose file

```yaml
services:
  app:
    container_name: totaljs-app
    image: totalplatform/run:npm
    restart: always
    environment:
      PROXY_HOST: "totaljs.com,www.totaljs.com"
      PROXY_PORT: "8000"
      PROXY_LOGS: "TRUE"
    networks: [proxy]

networks:
  proxy:
    external: true
```

| Variable | What it sets |
| --- | --- |
| `PROXY_HOST` | Comma-separated host names. The first one names the site and its file. `https://totaljs.com` serves that name over HTTPS with a Let's Encrypt certificate, a bare name or `http://` serves HTTP. The names go to the file as written. An empty value publishes nothing. |
| `PROXY_PORT` | The port the app listens on inside the container. Default `80`. |
| `PROXY_LOGS` | `TRUE` or `FALSE`: whether the requests go to `logs/<site>.log`. Default: on. |
| `PROXY_CERT` | The `cert` of the site: `auto` (Let's Encrypt for every name that does not say `http://`), `custom` (your certificate from `data/certs`, never Let's Encrypt) or `off`. Any other value is a folder under Proxy's `custom_cert_dir` with `fullchain.pem` and `privkey.pem`. Without it, only the names written as `https://` are served over HTTPS. |

While that container runs, Proxy keeps this file:

`data/sites/totaljs.com.json`

```json
{
  "hosts": ["totaljs.com", "www.totaljs.com"],
  "target": "172.18.0.5:8000",
  "logs": true,
  "docker": "totaljs-app"
}
```

`target` is the address of the container on the network, so it follows the container when Docker gives it another address. `docker` is the name of the container: it marks the file as written by discovery.

The labels `proxy.host`, `proxy.port` and `proxy.cert` do the same for one host name. The environment wins when both are set.

## What happens when containers change

| Event | Result |
| --- | --- |
| A container with `PROXY_HOST` starts on the network | Its file is written and the site is served a moment later. |
| It is recreated with other values or gets another address | The file is written again. |
| It stops, is removed or leaves the network | Its file is removed and the host names answer `404`. |
| Proxy starts | The files are brought in step with the containers that run now. |
| Docker cannot be asked | Nothing is removed. Proxy keeps the files it has and tries again. |

Proxy listens to Docker's events and also checks every 30 seconds.

## Files written by hand stay yours

Discovery only removes and rewrites files that have `"docker"` in them. A site you wrote yourself is never touched, also when a container declares the same first host name: that container is not published and `logs/error.log` says so. The same file reports a container with a wrong value and two containers that declare the same site. A container can never take a host name from another site:

- A name of a site you wrote yourself stays with it, also after Proxy starts again, and so does every name under its wildcard (`*.example.com`).
- Between two containers, the one that is published keeps its name. The first name of a container is never given to another one as one more of its names.
- The container that asked for a taken name is not published at all, and `logs/error.log` says which name and whose it is.

Every container on the `proxy` network may still publish any name that nobody has yet, so put only containers you trust on that network.

Do not edit a file that discovery wrote: the next sync writes it again. Change the environment of the container, or remove `PROXY_HOST` from it and write the file yourself.

## Let Proxy reach Docker

Proxy asks Docker through its socket. Mount it in the Proxy service and add the group that owns the socket on the host:

```yaml
services:
  proxy:
    volumes:
      - ./data:/proxy/data
      - ./logs:/proxy/logs
      - /var/run/docker.sock:/var/run/docker.sock:ro
    group_add:
      - "${DOCKER_GID:-0}"
    networks: [proxy]
```

Find the group with `stat -c %g /var/run/docker.sock` and set `DOCKER_GID`. Without the socket Proxy runs as before, with the sites you write yourself.

The settings in `data/config.json`:

| Key | Default | |
|---|---|---|
| `docker` | `/var/run/docker.sock` | The socket of Docker, or `http://host:port` of a socket proxy. Empty turns discovery off. |
| `docker_network` | `proxy` | The network whose containers publish themselves. Proxy must be attached to it to reach them. |

### Without giving Proxy the socket

Whoever can use the Docker socket controls Docker on that host, and Proxy faces the internet. Two ways to keep the socket away from it:

- **A socket proxy.** Run a Docker socket proxy that allows only reading containers, networks and events, and set `"docker": "http://docker-socket-proxy:2375"`. Proxy only sends `GET /networks/<name>`, `GET /containers/<id>/json` and `GET /events`.
- **The script on the host.** Set `"docker": ""` and run discovery outside the container. It writes the same files into the mounted sites folder:

  ```sh
  node scripts/docker-watch.js /srv/proxy/data/sites proxy
  ```

  The account needs Docker access and write access to the folder. Add `--once` for a single sync.

See the [complete configuration example](examples.md) for the Proxy config, site files and Compose YAML together.
