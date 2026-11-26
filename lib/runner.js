'use strict';

// Runs the proxy from a data folder and keeps it in step with <data>/config.json: the file is read every few
// seconds, and a change is applied by itself, as "nginx -t && nginx -s reload" without anyone typing it.
//
//   - a config with a mistake is not applied: the proxy goes on as it was and logs/error.log says why
//   - a change of limits, headers, compression or log size (Config.LIVE) is applied while the proxy runs
//   - a change of anything else (ports, workers, ACME, DNS, folders) starts the proxy again with the new
//     config; if it cannot start with it, the config of before comes back
//
// The sites (data/sites/*.json) are watched by the proxy itself (lib/routes.js).

const Config = require('./config');
const ProxyServer = require('./server');

class Runner {

	// options: { overrides (config values that win over the file), interval (ms), log, fatal(err) }
	constructor(data, options) {
		this.data = data;
		this.options = options || {};
		this.interval = this.options.interval || 2000;
		this.config = null;
		this.proxy = null;
		this.source = null;
		this.rejected = null;
		this.timer = null;
		this.busy = null;
	}

	create(config) {
		return new ProxyServer(config, { log: this.options.log, watch: this.interval }).start();
	}

	async start() {
		this.source = Config.read(this.data);
		this.config = Config.load(this.data, this.options.overrides);
		this.proxy = await this.create(this.config);
		this.timer = setInterval(() => this.check(), this.interval);
		return this;
	}

	// Resolves when a change that was found is applied
	check() {
		if (this.busy)
			return this.busy;
		let text;
		try {
			text = Config.read(this.data);
		} catch {
			return Promise.resolve();
		}
		// The same text as the one that runs, or as the one that was refused a moment ago
		if (text === this.source || text === this.rejected)
			return Promise.resolve();
		this.busy = this.apply(text).catch(err => {
			// Neither the new config nor the one of before starts
			if (this.options.fatal)
				this.options.fatal(err);
			else
				throw err;
		}).finally(() => this.busy = null);
		return this.busy;
	}

	async apply(text) {
		const file = Config.filename(this.data);
		let config;
		try {
			config = Config.load(this.data, this.options.overrides);
		} catch (err) {
			this.rejected = text;
			this.proxy.error('Config: ' + file + ' was not applied: ' + err.message);
			return;
		}

		this.source = text;
		this.rejected = null;
		const keys = Config.changed(this.config, config);
		if (!keys.length)
			return;

		if (keys.every(key => Config.LIVE.has(key))) {
			this.proxy.reconfigure(config);
			this.config = config;
			this.proxy.log('Config: applied ' + keys.join(', '));
			return;
		}

		const before = this.config;
		this.proxy.log('Config: starting again for ' + keys.join(', '));
		await this.proxy.stop();
		try {
			this.proxy = await this.create(config);
			this.config = config;
		} catch (err) {
			this.proxy = await this.create(before);
			this.rejected = text;
			this.source = null;
			this.proxy.error('Config: ' + file + ' was not applied, the config of before runs: ' + err.message);
		}
	}

	async stop() {
		clearInterval(this.timer);
		this.timer = null;
		if (this.busy)
			await this.busy.catch(() => {});
		if (this.proxy)
			await this.proxy.stop();
	}
}

module.exports = Runner;
