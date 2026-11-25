# Shared apps

Share one Proxy between apps or deployment tools that manage their own routes. Give each client its own control token and a list of hostnames it can publish. Proxy keeps routes, statistics and certificate status separate even when two clients use the same route ID. The Proxy administrator manages global settings.

## Configure Proxy

Use an Proxy build that includes scoped control clients. Leave `routes_file` empty so clients can write routes through the API. In the Proxy config, set:

```text
control              : /proxy/control/proxy.sock
control_clients_file : clients.json
```

Proxy resolves `clients.json` relative to its config file. Store one entry per client:

```json
{
  "alpha": {
    "token": "<alpha-token>",
    "domains": ["code.alpha.example.com", "*.apps.alpha.example.com"]
  },
  "beta": {
    "token": "<beta-token>",
    "domains": ["code.beta.example.com", "*.apps.beta.example.com"]
  }
}
```

Generate each token separately with `openssl rand -hex 32`. Keep the file readable only by the Proxy operator and runtime. On startup Proxy rejects overlapping assignments between clients. A wildcard covers one label, so `*.apps.alpha.example.com` covers `shop.apps.alpha.example.com`. Add any additional app hostname, redirect alias or bare domain explicitly if it falls outside the wildcard. Restart Proxy to apply changes to the client file. Existing routes remain published until edited or deleted. When removing a client or taking away a domain, remove any routes that should stop serving traffic.

Set a separate `token` in Proxy's config if you need administrator access to the API. With a client file configured, all requests require a token, including over the Unix socket.

## Run two copies of the same app

Both deployments below use the same Total.js Flow image and listen on port 8000 inside their containers. Connect them to the existing `proxy` network where Proxy runs. Each deployment gets its own service name and data volume.

```yaml
services:
  flow-alpha:
    image: totalplatform/flow:11
    volumes:
      - flow-alpha-data:/www/.src/databases
    networks: [proxy]
  flow-beta:
    image: totalplatform/flow:11
    volumes:
      - flow-beta-data:/www/.src/databases
    networks: [proxy]

volumes:
  flow-alpha-data:
  flow-beta-data:

networks:
  proxy:
    external: true
```

| Deployment | Public hostname | Upstream seen by Proxy | Route ID used by the client |
|---|---|---|---|
| Alpha | `flow.apps.alpha.example.com` | `http://flow-alpha:8000` | `flow` |
| Beta | `flow.apps.beta.example.com` | `http://flow-beta:8000` | `flow` |

Point both public DNS records to Proxy. Start the services with `docker compose up -d`, then publish each route from a shell that can reach Proxy's control socket. Use each deployment's token from `clients.json`. These [control API](control-api.md) requests assume the tokens are available in `PROXY_TOKEN_ALPHA` and `PROXY_TOKEN_BETA`.

```bash
curl --fail-with-body --unix-socket /proxy/control/proxy.sock \
  -H "Authorization: Bearer ${PROXY_TOKEN_ALPHA}" \
  -H 'Content-Type: application/json' \
  -X PUT http://proxy/routes/flow \
  -d '{"hosts":["flow.apps.alpha.example.com"],"target":"http://flow-alpha:8000","tls":"auto"}'

curl --fail-with-body --unix-socket /proxy/control/proxy.sock \
  -H "Authorization: Bearer ${PROXY_TOKEN_BETA}" \
  -H 'Content-Type: application/json' \
  -X PUT http://proxy/routes/flow \
  -d '{"hosts":["flow.apps.beta.example.com"],"target":"http://flow-beta:8000","tls":"auto"}'
```

Both clients use `/routes/flow`. Proxy stores the routes as `alpha--flow` and `beta--flow`. For a third copy, add its own service and volume to Compose and a new client with its own token and allowed hostname to `clients.json`. Restart Proxy to load the new client, then publish its route with the same `flow` ID.

If clients connect over TCP, keep the control listener on a private network and protect the transport because the listener uses HTTP. Use scoped access for deployments run by trusted operators. A client can point routes to backends reachable from Proxy.

## Example with Total.js Code

Use a Code version that supports bearer tokens over the Unix socket and scoped route management. Include the Code instance's own hostname in its allowed domains.

Mount the control socket directory into each Code container. Give each instance only its own token and make its upstream address unique and reachable from Proxy. For example, for Alpha:

```text
edge           : /proxy/control/proxy.sock
edge_token     : <alpha-token>
host           : code.alpha.example.com
self_target    : http://code-alpha:8000
uid            : alpha
code_container : code-alpha
edge_container : proxy
```

For Beta use its token, `code.beta.example.com`, `http://code-beta:8000`, `uid : beta` and `code_container : code-beta`. The distinct `uid` values keep generated app container and network names separate. Use distinct names for manually named Docker containers as well. Both instances should name the same running Proxy in `edge_container`.

Docker socket access carries host-level privileges.

## Move existing routes

Back up Proxy's data before switching an existing client to a scoped token. Proxy stores scoped IDs as `alpha--code` or `alpha--project-…` and exposes them to Alpha under their original IDs. During a maintenance window with Proxy stopped, prefix the existing routes owned by that client in `data/routes.json` before enabling the token so the client can continue managing them. If you keep visit statistics, move the corresponding route directories under `data/stats/` to their prefixed names too. Leave administrator-managed routes under their original IDs.

See the [complete configuration example](examples.md) for the Proxy config, routes JSON and Compose YAML together.
