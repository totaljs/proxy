# Deploy Total.js Flow with Proxy

The [Flow example](../examples/flow/compose.yaml) uses the official [Total.js Flow 11 image](https://github.com/totaljs/flow#flow-in-docker). Configure the domain in the app’s Compose file. Flow listens on port 8000 inside its container and shares the `proxy` Docker network with Proxy.

1. **Set up shared Proxy once.** Use an existing Proxy and watchdog if you already run them on this server. For a fresh setup, create the Docker network if needed and follow the [installation guide](installation.md#install-with-docker-compose). Set `deploy/routes.json` to an empty array if you only want discovered apps.

   ```sh
   docker network inspect proxy >/dev/null 2>&1 || docker network create proxy
   docker build -t totaljs-proxy:local .
   docker compose -f deploy/compose.yaml up -d
   node scripts/docker-watch.js proxy deploy/routes.docker.json
   ```

   Leave the watchdog running and continue in another terminal.

2. **Set up Flow privately.** From the repository root on the server, start a temporary Flow container bound to the server’s loopback address. The empty `PROXY_HOST` keeps the temporary container out of discovery.

   ```sh
   docker compose -f examples/flow/compose.yaml run --rm \
     -e PROXY_HOST= -p 127.0.0.1:18000:8000 flow
   ```

   From your computer, open an SSH tunnel:

   ```sh
   ssh -N -L 18000:127.0.0.1:18000 user@server
   ```

   Open `http://localhost:18000`, sign in with Flow’s initial credentials and change them in its settings. Stop the temporary container with Ctrl+C. The named volumes keep the settings and flows for the next start. Run both Compose commands from the same checkout so they use the same volumes.

3. **Publish Flow.** Replace `https://flow.example.com` in [compose.yaml](../examples/flow/compose.yaml) with your hostname. Point its DNS record at Proxy and allow inbound TCP 80 and 443 on the Proxy server. Start Flow:

   ```sh
   docker compose -f examples/flow/compose.yaml up -d
   ```

   The watchdog reads `PROXY_HOST` and `PROXY_PORT` from the Flow container and updates its route. Open your HTTPS URL once Proxy has issued the certificate. Check the logs of the shared Proxy if the certificate is still pending. Changing `PROXY_LOGS` controls access logging for this app when Proxy has a log destination configured.

If Code already manages the server’s public ports, you can deploy Flow as a Code project and set its domain there.

See the [complete configuration example](examples.md) for the Proxy config, routes JSON and Compose YAML together.
