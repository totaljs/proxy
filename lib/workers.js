'use strict';

// The workers of the proxy ("workers" in the config, more than one): this process, the primary, keeps what exists
// once (the ACME account and its checks, the DNS server, the counters, the files of the logs and of the sites) and starts
// processes that share the HTTP and HTTPS ports and serve the requests (lib/worker.js). What changes here is read
// again by every worker; a worker that ends is started again.

const Cluster = require('node:cluster');
const Path = require('node:path');
const Crypto = require('node:crypto');

class Workers {

	constructor(proxy) {
		this.proxy = proxy;
		this.items = new Set();
		this.stopping = false;
		this.timers = new Set();
		// TLS session tickets of one worker are read by the others
		this.tickets = Crypto.randomBytes(48).toString('base64');
	}

	// Resolves with the ports when every worker listens
	async start() {
		const ports = await Promise.all(Array.from({ length: this.proxy.config.workers }, () => this.fork()));
		return ports[0];
	}

	fork() {
		const proxy = this.proxy;
		// Without the flags of this process (node -e, --test): Node options for the workers go in NODE_OPTIONS
		Cluster.setupPrimary({ exec: Path.join(__dirname, 'worker.js'), args: [], execArgv: [] });
		const worker = Cluster.fork();
		this.items.add(worker);
		return new Promise((resolve, reject) => {
			let ready = false;
			let failure = '';
			worker.on('error', () => {});
			worker.on('message', message => {
				switch (message && message.type) {
					case 'ready':
						ready = true;
						resolve(message.ports);
						break;
					case 'failed':
						failure = message.message;
						break;
					case 'log':
						proxy.log(message.message);
						break;
					case 'logs':
						proxy.logs.take(message.lines);
						break;
					case 'stats':
						proxy.stats.take(message.counted);
						break;
					case 'challenge':
						worker.isConnected() && worker.send({ type: 'challenge', id: message.id, value: proxy.challenges.get(message.token) });
						break;
				}
			});
			worker.once('exit', (code, signal) => {
				this.items.delete(worker);
				if (!ready) {
					reject(new Error(failure || 'A worker ended while it started'));
					return;
				}
				if (this.stopping)
					return;
				proxy.error('Workers: a worker ended (' + (signal || 'code ' + code) + '), starting another');
				this.again(1000);
			});
			worker.send(Object.assign({ type: 'init', routes: proxy.routes.list(), tickets: this.tickets, fold: proxy.options.fold }, this.config()));
		});
	}

	// Another worker for one that ended; one that cannot start is tried again, a little later each time
	again(delay) {
		const timer = setTimeout(() => {
			this.timers.delete(timer);
			if (this.stopping)
				return;
			this.fork().catch(err => {
				if (this.stopping)
					return;
				this.proxy.error('Workers: a worker did not start: ' + err.message);
				this.again(Math.min(delay * 2, 30000));
			});
		}, delay);
		this.timers.add(timer);
	}

	// The config as it crosses to a worker (JSON: the Map of the certificate files goes as a list)
	config() {
		return { config: Object.assign({}, this.proxy.config, { custom_certs: null }), custom_certs: [...this.proxy.config.custom_certs] };
	}

	send(message) {
		for (const worker of this.items)
			worker.isConnected() && worker.send(message);
	}

	// what: 'routes' (data: the sites) or 'certs'
	reload(what, data) {
		this.send({ type: 'reload', what, data });
	}

	// The config changed without a restart
	configure() {
		this.send(Object.assign({ type: 'config' }, this.config()));
	}

	stop() {
		this.stopping = true;
		for (const timer of this.timers)
			clearTimeout(timer);
		this.timers.clear();
		return Promise.all([...this.items].map(worker => new Promise(resolve => {
			if (worker.isDead()) {
				resolve();
				return;
			}
			// A worker that does not end by itself (it closes its connections first) is ended
			const timer = setTimeout(() => worker.process.kill('SIGKILL'), 8000);
			worker.once('exit', () => {
				clearTimeout(timer);
				resolve();
			});
			if (worker.isConnected())
				worker.send({ type: 'stop' });
			else
				worker.process.kill('SIGKILL');
		})));
	}
}

module.exports = Workers;
