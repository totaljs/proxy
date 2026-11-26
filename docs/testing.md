# Test Total.js Proxy

Run the full suite from the repository root:

```bash
npm test
```

For example, after editing how the files are watched, run its tests directly:

```bash
node --test test/reload.test.js
```

This covers `config.json`, the site files of `data/sites` and certificates that change while Proxy runs.

See the [Pebble README](../test/pebble/README.md) for the isolated ACME integration test and local debugging instructions.

See the [complete configuration example](examples.md) for the Proxy config, site files and Compose YAML together.
