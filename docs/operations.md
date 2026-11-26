# Operate and recover Total.js Proxy

## Check availability and certificates

Check each public domain from another machine. Use a URL with an expected status and response rather than testing the host alone.

```sh
curl --fail --silent --show-error --max-time 10 https://app.example.com/
```

Run this check from an external monitor if you need alerts when the server or its connection is down. On the server, check certificate issuance and expiry in `data/status.json`, and what went wrong in `logs/error.log`.

```sh
cat data/status.json
tail -n 100 logs/error.log
docker compose logs --tail 100 proxy
```

Track repeated failures, certificates close to expiry, and changes in the rate of HTTP 429 and 503 responses. The [request counters](configuration.md#request-counters) in `data/stats` have the 429 and 503 answers of each site by day, and the [logging guide](logging.md) describes the log files.

## Back up and restore

Back up the entire `proxy-data` volume using your storage snapshot system. For a consistent file-level backup, stop the Proxy service during the copy and start it again once the copy completes. Store the backup with restricted access because it contains the ACME account key and site private keys.

Keep a separate copy of the Compose file. `config.json` and the site files live in the data folder, so its backup has them.

To check a restore, use a fresh volume and a disposable container on a separate Docker network with no external connectivity or published ports. Mount the restored volume at `/proxy/data` and the backed-up configuration at the same path as in production. Use the same Proxy image version.

1. Verify that the restored instance serves the expected sites: its output lists how many it loaded, and `logs/error.log` names any file it refused.
2. Connect to the restored HTTPS listener from within the test network using a configured hostname as SNI. Compare the certificate fingerprint with the original.
3. Verify that the ACME account files were restored with their original ownership and permissions. Keep the test instance offline to prevent real issuance requests.

See the [complete configuration example](examples.md) for the Proxy config, routes JSON and Compose YAML together.
