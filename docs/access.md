# Restrict access to an app

Proxy applies these rules to each route, including when you run Proxy standalone. In this example, the public site stays open while the admin app requires a connection from the office or VPN and a user name and password.

## Set the rules in routes.json

```json
[
  {
    "id": "website",
    "hosts": ["www.example.com"],
    "target": "http://website:8000",
    "tls": "auto"
  },
  {
    "id": "admin",
    "hosts": ["admin.example.com"],
    "target": "http://admin:8000",
    "tls": "auto",
    "allow": ["10.42.0.0/16", "2001:db8:42::/48"],
    "deny": ["10.42.0.18"],
    "auth": [
      { "user": "ana", "hash": "REPLACE_WITH_GENERATED_HASH" }
    ],
    "headers": {
      "X-Frame-Options": "SAMEORIGIN"
    }
  }
]
```

Replace the example networks with the source addresses Proxy sees. Both lists accept individual IPv4 and IPv6 addresses and CIDR ranges. An empty or omitted `allow` lets any address through the list check. `deny` takes priority when an address matches both lists. Proxy uses the address of the connecting peer, so behind another proxy the rules see that proxy's address.

For Compose, mount the directory containing `routes.json` and set `routes_file` in Proxy's config as shown in the [complete example](examples.md). With API-managed routes, send these same fields in the route's [PUT request](control-api.md).

## Generate a password hash

From an Proxy source checkout, run this in Bash. The password is entered without echo and passed to Node through stdin.

```bash
IFS= read -rs -p 'App password: ' EDGE_PASSWORD
printf '\n'
printf '%s' "$EDGE_PASSWORD" | node -e 'const fs = require("node:fs"); console.log(require("./lib/guard").hash(fs.readFileSync(0, "utf8")))'
unset EDGE_PASSWORD
```

Paste the resulting hash into the route in place of `REPLACE_WITH_GENERATED_HASH`. Add one entry per user. Omit `auth` to use only the IP rules. Serve routes with passwords over HTTPS. Proxy verifies the password and removes the Basic credentials before forwarding to the app.

## Check the result

From an address outside the allowed ranges, the admin route returns `403`. From an allowed address without credentials, it returns `401` and prompts the browser for a login. With the correct credentials, it serves the app and adds `X-Frame-Options` when the app has not set that header. IP and password checks also apply to WebSocket upgrades to the app.

Allow public HTTP for the ACME HTTP challenge when using `tls: auto`. Proxy answers that challenge itself. To serve a site only on internal DNS with a certificate, use a [custom certificate](tls.md) that covers the internal name.
