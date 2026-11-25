'use strict';

// Requests and renews the Let's Encrypt certificates of the routes, one at a time.
// Failures wait longer each time, so a host that is not ready never uses up the authority's limits.

const Fs = require('node:fs');
const Path = require('node:path');
const Crypto = require('node:crypto');
const Resolver = require('node:dns').promises;
const Hosts = require('./hosts');

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const BACKOFF = [5 * MINUTE, 30 * MINUTE, 2 * HOUR, 6 * HOUR, DAY];
const WAITING = 15 * MINUTE;

class Manager {

	constructor(edge) {
		this.edge = edge;
		this.status = new Map();
		this.forced = new Set();
		this.running = null;
		this.again = false;
		this.timer = null;
		this.interval = null;
		this.file = Path.join(edge.config.data, 'status.json');
	}

	start() {
		this.load();
		this.interval = setInterval(() => this.schedule(0), 6 * HOUR);
		this.schedule(0);
	}

	stop() {
		clearInterval(this.interval);
		clearTimeout(this.timer);
		this.interval = this.timer = null;
	}

	schedule(delay) {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.sync(), delay == null ? 1000 : delay);
	}

	// The stable label of the CNAME a host needs for the DNS check
	label(host) {
		return Crypto.createHash('sha256').update('code-edge:' + Hosts.base(host)).digest('hex').substring(0, 20);
	}

	record(host) {
		const zone = this.edge.config.dns_zone;
		return zone ? { name: '_acme-challenge.' + Hosts.base(host), type: 'CNAME', value: this.label(host) + '.' + zone } : null;
	}

	usesdns(host, route) {
		return host.startsWith('*.') || route.challenge === 'dns';
	}

	// Resolves when the pass is over; a call during a pass runs another one after it
	sync() {
		if (this.running) {
			this.again = true;
			return this.running;
		}
		this.running = this.pass().finally(() => {
			this.running = null;
			if (this.again) {
				this.again = false;
				this.schedule(0);
			} else if (this.interval)
				this.wake();
		});
		return this.running;
	}

	async pass() {
		const now = Date.now();
		const limit = this.edge.config.renew_days * DAY;
		const seen = new Set();

		for (const { host, route } of this.edge.routes.tlshosts('custom')) {
			seen.add(host);
			const { item: cert, error } = this.edge.certs.customFor(route, host, now);
			if (cert) {
				this.status.set(host, { state: 'valid', source: 'custom', expires: cert.notAfter.toISOString() });
			} else {
				if (this.status.get(host)?.error !== error)
					this.edge.log('Certificates: ' + host + ' custom certificate unavailable: ' + error);
				this.status.set(host, { state: 'error', source: 'custom', error });
			}
		}

		for (const { host, route } of this.edge.routes.tlshosts()) {

			seen.add(host);

			// A custom wildcard certificate covers its names: no certificate of Let's Encrypt for them
			const wild = this.edge.certs.items.get(Hosts.wildcard(host));
			const item = this.edge.certs.items.get(host) || (wild && wild.source === 'custom' ? wild : null);
			// A staging certificate while Proxy asks the real server (the switch from --staging to --production)
			const forced = this.forced.has(host);
			const replaceStaging = item && item.staging && !(/staging/i).test(this.edge.config.acme || '');

			if (item && item.source === 'custom') {
				this.status.set(host, { state: 'valid', source: 'custom', expires: item.notAfter.toISOString() });
				continue;
			}

			if (item && !forced && !replaceStaging && item.notAfter.getTime() - now > limit) {
				this.status.set(host, { state: 'valid', source: 'acme', expires: item.notAfter.toISOString() });
				continue;
			}

			const status = this.status.get(host);
			if (!forced && status && status.next && status.next > now)
				continue;

			this.forced.delete(host);
			await this.issue(host, route);
		}

		for (const host of [...this.status.keys()]) {
			if (!seen.has(host))
				this.status.delete(host);
		}

		this.save();
	}

	// Wakes up for the next retry that is due before the regular pass
	wake() {
		let next = Infinity;
		for (const status of this.status.values()) {
			if (status.next && status.next < next)
				next = status.next;
		}
		if (next !== Infinity)
			this.schedule(Math.max(next - Date.now(), 1000));
	}

	async issue(host, route) {

		const edge = this.edge;
		const before = this.status.get(host) || {};
		const usedns = this.usesdns(host, route);

		if (usedns && !edge.dns) {
			this.fail(host, before, 'error', 'The DNS check needs dns and dns_zone in Proxy config', false);
			return;
		}

		if (usedns && edge.config.precheck) {
			const record = this.record(host);
			let ready = false;
			try {
				const values = await Resolver.resolveCname(record.name);
				ready = values.some(value => Hosts.normalize(value) === record.value);
			} catch {}
			if (!ready) {
				this.fail(host, before, 'waiting-dns', 'Create the DNS record ' + record.name + ' CNAME ' + record.value, false);
				return;
			}
		}

		const current = edge.certs.items.get(host);
		this.status.set(host, { state: 'requesting', expires: current ? current.notAfter.toISOString() : null });
		edge.log('Certificates: requesting ' + host);

		try {
			const result = await edge.acme.issue([host], this.handlers(usedns));
			const item = edge.certs.save(host, result.key, result.cert);
			this.status.set(host, { state: 'valid', source: 'acme', expires: item.notAfter.toISOString() });
			edge.log('Certificates: ' + host + ' is valid until ' + item.notAfter.toISOString());
		} catch (e) {
			this.fail(host, before, 'error', e.message, true);
			edge.log('Certificates: ' + host + ' failed: ' + e.message);
		}
	}

	fail(host, before, state, message, counts) {
		const failures = (before.failures || 0) + (counts ? 1 : 0);
		const delay = counts ? BACKOFF[Math.min(failures - 1, BACKOFF.length - 1)] : WAITING;
		const current = this.edge.certs.items.get(host);
		const status = { state, error: message, failures, next: Date.now() + delay, expires: current ? current.notAfter.toISOString() : null };
		if (state === 'waiting-dns')
			status.record = this.record(host);
		this.status.set(host, status);
		this.save();
	}

	handlers(usedns) {
		const edge = this.edge;
		const zone = edge.config.dns_zone;
		return {
			type: () => usedns ? 'dns-01' : 'http-01',
			http: {
				set: (token, value) => edge.challenges.set(token, value),
				remove: token => edge.challenges.delete(token)
			},
			dns: {
				set: (name, value) => edge.dns.add(this.label(name) + '.' + zone, value),
				remove: (name, value) => edge.dns.remove(this.label(name) + '.' + zone, value)
			}
		};
	}

	// Asks for a new certificate now, even if the current one is still valid
	renew(host) {
		this.forced.add(host);
		this.schedule(0);
	}

	list() {
		const output = {};
		for (const [host, status] of this.status) {
			const item = Object.assign({}, status);
			if (item.next)
				item.next = new Date(item.next).toISOString();
			output[host] = item;
		}
		return output;
	}

	load() {
		let saved;
		try {
			saved = JSON.parse(Fs.readFileSync(this.file, 'utf8'));
		} catch (err) {
			if (err.code !== 'ENOENT')
				this.edge.log('Certificates: could not load the retry state: ' + err.message);
			return;
		}
		if (!saved || typeof saved !== 'object')
			return;
		for (const { host } of this.edge.routes.tlshosts()) {
			const item = saved[host];
			if (!item || (item.state !== 'error' && item.state !== 'waiting-dns'))
				continue;
			const next = Date.parse(item.next);
			if (!Number.isFinite(next) || !Number.isSafeInteger(item.failures) || item.failures < 0)
				continue;
			const status = { state: item.state, error: item.error, failures: item.failures, next, expires: item.expires };
			if (item.state === 'waiting-dns')
				status.record = this.record(host);
			this.status.set(host, status);
		}
	}

	save() {
		try {
			const tmp = this.file + '.tmp';
			Fs.writeFileSync(tmp, JSON.stringify(this.list(), null, '\t'), { mode: 0o600 });
			Fs.renameSync(tmp, this.file);
		} catch (e) {
			this.edge.log('Certificates: could not save the status: ' + e.message);
		}
	}
}

module.exports = Manager;
