# Logging in Total.js Proxy

| Log | What it records | Default |
| --- | --- | --- |
| Access | Completed HTTP requests, with the client IP, domain, method, URL, response status, duration and user agent | Off |
| Operational | Startup, route changes and certificate events, including failures | Container output |

To try these settings, follow the [Docker Compose installation](installation.md#install-with-docker-compose).

## Configure a deployment

Add these settings to the Proxy service in your Compose file. This sends operational events to daily files and enables access logging only on routes that opt in.

```yaml
services:
  proxy:
    environment:
      PROXY_EVENTLOG: /proxy/data/events
      PROXY_ACCESSLOG: /proxy/data/access
      PROXY_ACCESSLOG_DEFAULT: "false"
```

These variables override the corresponding keys in `proxy.conf`. Omit them to use these settings from the file.

```text
eventlog          : /proxy/data/events
accesslog         : /proxy/data/access
accesslog_default : false
accesslog_maxsize : 50
accesslog_days    : 14
```

An empty `PROXY_ACCESSLOG` disables access logging. Use `PROXY_EVENTLOG: stdout` to read events with `docker compose logs proxy`, or `off` to disable them. Fatal startup errors still go to stderr.

## Configure each app

In `routes.json`, enable access logging and optionally choose a directory relative to the deployment’s access log directory.

```json
{
  "id": "flow",
  "hosts": ["flow.example.com"],
  "target": "http://flow:8000",
  "accesslog": true,
  "accesslog_dir": "flow"
}
```

This writes `/proxy/data/access/flow/access-flow-YYYY-MM-DD.log`. All hostnames on the same route share the file. Omit `accesslog_dir` to write directly into the deployment log directory. Set `"accesslog": false` to exclude a route when access logging is enabled by default.

Each route file has its own daily size limit. Unmatched requests go into `access-YYYY-MM-DD.log` when logging is enabled by default. Operational files are named `proxy-YYYY-MM-DD.log` and have a separate daily limit of 50 MB and a retention window of 14 days. If you send access logs to `stdout`, configure rotation in Docker.

## Keep a log alongside the app

Add a bind mount to the Proxy service alongside its existing data volume.

```yaml
volumes:
  - proxy-data:/proxy/data
  - ./apps/flow/logs:/proxy/data/access/flow
```

Create the host directory and make it writable by Proxy’s container user. In this example the log appears under `./apps/flow/logs` on the host.

## Diagnose a custom certificate

Check the operational log for the affected hostname and reason, or read `GET /status` through the [control socket](control-api.md). Proxy checks the [paths configured for that app](tls.md#configure-certificates-in-compose) or discovers a PEM-encoded `.crt` or `.pem` and matching `.key` in `data/custom/`. A missing, expired or invalid custom certificate affects the corresponding hostname. Other routes continue serving.

See the [complete configuration example](examples.md) for the Proxy config, routes JSON and Compose YAML together.
