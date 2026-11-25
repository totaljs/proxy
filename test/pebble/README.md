# Pebble for Proxy

[Pebble](https://github.com/letsencrypt/pebble) is Let’s Encrypt’s local ACME test server. Proxy uses it to check HTTP and DNS validation, certificate issuance, serving HTTPS, renewal and restoration with a test account.

From the repository root, run:

```sh
sh test/pebble-ci.sh
```

The script requires Docker. It runs in disposable containers without publishing host ports and removes them afterwards. GitHub Actions runs the same test before publishing a new Proxy image.

For interactive debugging, start Pebble with `sh test/pebble.sh`, then run `node --test test/pebble.test.js`. The `minica.pem` and `host` files in this directory are test fixtures used by the integration test.
