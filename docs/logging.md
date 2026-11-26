# Logging in Total.js Proxy

Proxy creates the `logs` folder by itself, next to the `data` folder, and writes there:

| File | What it records |
| --- | --- |
| `<site>.log` | The requests of one site: time, client IP, host name, method, URL, status, duration in ms and user agent. The status is `499` when the client went away before the answer ended, and `101` for a WebSocket that was opened. The name is the name of the site file, so `data/sites/totaljs.com.json` writes `logs/totaljs.com.log`. All host names of the site share the file. |
| `error.log` | What went wrong: a `config.json` or a site file that was not applied and why, failed certificates, a worker that ended, and each request that an app did not answer (`503` or `504` from Proxy). |

The lines of the requests are written together a few times a second, not one write for each request, so logging costs little: about 8% of the throughput of one process in a local test. A process that is killed loses the lines of its last quarter of a second. `error.log` is written at once.

Startup, reloads and certificate events also go to the output of the process, so `docker compose logs proxy` shows them.

## Limit the size

A file that reaches `logs_maxsize` MB is renamed to `<name>.log.1`, replacing the one before, and a new file starts. Each site and `error.log` therefore take at most twice the limit on disk. Set it in `data/config.json`:

```json
{
  "logs_maxsize": 100
}
```

The change applies while Proxy runs. `"logs": "data/logs"` moves the folder (relative to the folder that holds `data`), and `"logs": ""` turns the files off.

## Turn the log of a site off

Every site is logged unless its file says otherwise:

```json
{
  "hosts": ["totaljs.com", "www.totaljs.com"],
  "target": "172.18.0.5:8000",
  "logs": false
}
```

Requests for a host name that no site has are answered with `404` and are not logged.

## In Docker

The image keeps the logs in `/proxy/logs`. Mount it to read the files on the host:

```yaml
services:
  proxy:
    volumes:
      - ./data:/proxy/data
      - ./logs:/proxy/logs
```

Make the host folder writable by the container user (`node`, UID 1000).

## Diagnose a config or a site that was not applied

Read `logs/error.log`. A rejected file names the file and the reason, and Proxy keeps running with what it had:

```text
2026-11-25T10:12:03.511Z  Sites: /proxy/data/sites/totaljs.com.json was not applied: Not valid JSON: Unexpected end of JSON input
2026-11-25T10:14:40.902Z  Config: /proxy/data/config.json was not applied: Unknown key in config.json: maxuploda
```

## Diagnose a custom certificate

Check `error.log` for the affected hostname and reason, or read `data/status.json`. Proxy checks the [paths configured for that app](tls.md#configure-certificates-in-compose) or discovers a PEM-encoded `.crt` or `.pem` and matching `.key` in `data/custom/`. A missing, expired or invalid custom certificate affects the corresponding hostname. Other sites continue serving.

See the [complete configuration example](examples.md) for the Proxy config, site files and Compose YAML together.
