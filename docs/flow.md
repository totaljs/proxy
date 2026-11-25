# Deploy Total.js Flow with Proxy

The [Flow example](../examples/flow) uses the official [Total.js Flow 11 image](https://github.com/totaljs/flow#flow-in-docker) and an Proxy image with support for `tls: auto`. Compose creates a network where Proxy can reach Flow at `http://flow:8000`. Only Proxy publishes public ports. With the current source, build it from the repository root with `docker build -t totaljs-proxy:local .`.

1. **Set up Flow privately.** On the server, create a directory and copy [compose.yaml](../examples/flow/compose.yaml), [edge.conf](../examples/flow/edge.conf) and [routes.json](../examples/flow/routes.json) into it. From that directory, start a temporary Flow container bound to the server's loopback address:

   ```sh
   docker compose run --rm -p 127.0.0.1:18000:8000 flow
   ```

   From your computer, open an SSH tunnel using your server's SSH host or alias:

   ```sh
   ssh -N -L 18000:127.0.0.1:18000 user@server
   ```

   Open `http://localhost:18000`, sign in with the initial credentials displayed by Flow, and change them in Flow's settings. Stop the temporary container with Ctrl+C in the server terminal. The named volumes keep your settings and flows.

2. **Publish the domain.** Point your domain at the server and allow inbound TCP ports 80 and 443. Replace `flow.example.com` in `routes.json` with your domain. Then start both services:

   ```sh
   docker compose up -d
   ```

3. **Check HTTPS.** Open `https://flow.example.com` with your real domain and check that Flow loads. If the certificate is still pending, check `docker compose logs edge`. Keep the named volumes for Flow's data and Proxy's certificates.

If Code already manages ports 80 and 443 on the server, deploy Flow as a Code project and set its domain in Code. The existing Proxy will handle HTTPS.

See the [complete configuration example](examples.md) for the Proxy config, routes JSON and Compose YAML together.
