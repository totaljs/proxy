# Run Total.js Flow behind Proxy

The [Flow Compose file](../examples/flow/compose.yaml) starts Total.js Proxy and the [official Flow 11 image](https://github.com/totaljs/flow#flow-in-docker) together. Compose creates a private network. Proxy receives requests and forwards them to `http://flow:8000`. The Proxy config and Flow route are inline in the YAML and require [Docker Compose 2.23.1 or later](https://docs.docker.com/reference/compose-file/configs/).

## Try it locally

From the repository root:

```sh
docker compose -f examples/flow/compose.yaml up --build -d
curl --resolve flow.localhost:80:127.0.0.1 http://flow.localhost/
```

Open `http://flow.localhost/` in your browser. The default binds Proxy to loopback and uses HTTP. Only Proxy publishes ports. The volumes keep Flow’s settings and streams and Proxy’s certificates.

## Publish Flow over HTTPS

First sign in locally and change Flow’s initial credentials in its settings. For a remote host, reach the loopback listener through SSH:

```sh
ssh -N -L 18080:127.0.0.1:80 user@server
```

Open `http://flow.localhost:18080/` on your computer through the tunnel. Keep the same Compose project when switching to HTTPS so Flow retains its settings.

Point your public hostname at the server, allow inbound TCP ports 80 and 443, then run:

```sh
FLOW_HOST=flow.example.com FLOW_TLS=auto FLOW_BIND=0.0.0.0 \
  docker compose -f examples/flow/compose.yaml up -d
```

Use your real domain. Open its HTTPS URL once Proxy has issued a certificate. Check progress with `docker compose -f examples/flow/compose.yaml logs proxy`. Put the same variables in `examples/flow/.env` if you want Compose to reuse them for later runs from that directory.
