# Operate and recover Total.js Edge

## Check availability and certificates

Check each public domain from another machine. Use a URL with an expected status and response rather than testing the host alone.

```sh
curl --fail --silent --show-error --max-time 10 https://app.example.com/
```

Run this check from an external monitor if you need alerts when the server or its connection is down. On the server, check certificate issuance and expiry over the local control socket.

```sh
docker compose exec -T edge node -e 'require("node:http").get({socketPath:"/edge/control/edge.sock",path:"/status"},res=>res.pipe(process.stdout)).on("error",err=>{console.error(err.message);process.exitCode=1})'
docker compose logs --tail 100 edge
```

Track repeated failures, certificates close to expiry, and changes in the rate of HTTP 429 and 503 responses. See the [control API](control-api.md) and [logging guide](logging.md) for the available data. Keep the control socket private. A local client can collect status over SSH.

## Back up and restore

Back up the entire `edge-data` volume using your storage snapshot system. For a consistent file-level backup, stop the Edge service during the copy and start it again once the copy completes. Store the backup with restricted access because it contains the ACME account key and site private keys.

Keep a separate copy of the Compose file and Edge config. If you use `routes_file`, back up that file too. It lives outside the data volume in the published Compose examples.

To check a restore, use a fresh volume and a disposable container on a separate Docker network with no external connectivity or published ports. Mount the restored volume at `/edge/data` and the backed-up configuration at the same path as in production. Use the same Edge image version.

1. Verify that the control API lists the expected routes.
2. Connect to the restored HTTPS listener from within the test network using a configured hostname as SNI. Compare the certificate fingerprint with the original.
3. Verify that the ACME account files were restored with their original ownership and permissions. Keep the test instance offline to prevent real issuance requests.

See the [complete configuration example](examples.md) for the Edge config, routes JSON and Compose YAML together.
