# Test Total.js Proxy

Run the full suite from the repository root:

```bash
npm test
```

For example, after editing the control API, run its tests directly:

```bash
node --test test/control.test.js
```

This covers route creation and removal, live reload from `routes.json` and two scoped clients using the same route ID.

See the [Pebble README](../test/pebble/README.md) for the isolated ACME integration test and local debugging instructions.

See the [complete configuration example](examples.md) for the Proxy config, routes JSON and Compose YAML together.
