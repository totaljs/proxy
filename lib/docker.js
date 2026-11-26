'use strict';

// Docker discovery: the containers of one Docker network (by default "proxy") publish themselves. A container says
// what it serves in its environment (the "environment" of its Compose file):
//
//   PROXY_HOST=totaljs.com,www.totaljs.com    the host names; "https://totaljs.com" asks for a certificate
//   PROXY_PORT=8000                           the port of the app inside the container (default 80)
//   PROXY_LOGS=TRUE|FALSE                     the log of the site (default: on)
//   PROXY_CERT=off|auto|custom                "cert" of the site; or a folder with fullchain.pem and privkey.pem
//
// For each such container that runs, a site file is written to data/sites, named after its first host name
// (totaljs.com.json) and pointing to the address of the container on the network. When the container stops, its file
// is removed; when it comes back with another address or other values, the file is written again. The proxy applies
// the files as any other site. Files written by hand are never touched: only the ones with "docker" in them.
//
// Docker is asked through its Engine API: a Unix socket (/var/run/docker.sock) or http://host:port (a socket proxy).

const Fs = require('node:fs');
const Path = require('node:path');
const Http = require('node:http');
const Hosts = require('./hosts');
const Routes = require('./routes');

const NAME = /^[a-z0-9][a-z0-9_.-]*$/i;

function values(container) {
	const output = new Map();
	for (const item of (container.Config && container.Config.Env) || []) {
		const index = item.indexOf('=');
		if (index !== -1 && /^PROXY_(HOST|PORT|CERT|LOGS)$/.test(item.substring(0, index)))
			output.set(item.substring(0, index), item.substring(index + 1).trim());
	}
	return output;
}

// The site of a container: { id, container, data } or null when it publishes nothing. Throws what is wrong with it.
// network: { Name, Id } of the network of the proxy
function site(container, network) {

	const env = values(container);
	const labels = (container.Config && container.Config.Labels) || {};
	// The environment first; the labels proxy.host, proxy.port and proxy.cert say the same for one host
	const declared = env.has('PROXY_HOST') ? env.get('PROXY_HOST') : (labels['proxy.host'] || '');
	if (!declared)
		return null;

	const name = String(container.Name || '').replace(/^\//, '');
	if (!NAME.test(name))
		throw new Error('Invalid container name');

	// The names as the container wrote them: "https://totaljs.com" asks for a certificate, "http://" or a name
	// alone is HTTP (lib/routes.js). The file is named after the first one.
	const hosts = [];
	const names = [];
	for (const item of declared.split(',')) {
		const value = item.trim();
		if (!value)
			continue;
		const scheme = (/^https?:\/\//i.exec(value) || [''])[0].toLowerCase();
		const host = Hosts.normalize(value.substring(scheme.length));
		if (!Hosts.valid(host, false))
			throw new Error('PROXY_HOST needs host names, or origins without a port or a path: ' + JSON.stringify(value.substring(0, 80)));
		if (names.includes(host))
			continue;
		names.push(host);
		hosts.push(scheme + host);
	}

	if (!hosts.length)
		return null;
	if (hosts.length > 50)
		throw new Error('PROXY_HOST takes up to 50 host names');

	const port = env.has('PROXY_HOST') ? (env.get('PROXY_PORT') || '80') : (labels['proxy.port'] || '80');
	if (!/^[0-9]{1,5}$/.test(port) || +port < 1 || +port > 65535)
		throw new Error('PROXY_PORT needs a port number');

	// The address of the container on the network of the proxy
	const networks = (container.NetworkSettings && container.NetworkSettings.Networks) || {};
	const attached = Object.keys(networks).map(key => networks[key]).find(item => item && item.NetworkID === network.Id) || networks[network.Name];
	const address = attached && attached.IPAddress;
	if (!address)
		throw new Error('It has no address on the network ' + network.Name + ' yet');

	const data = { hosts, target: address + ':' + port };

	// PROXY_CERT is "cert" of the site: off, auto or custom. Anything else is a folder (custom_cert_dir) with
	// fullchain.pem and privkey.pem, for a certificate of your own that is not in data/certs.
	const certificate = env.has('PROXY_HOST') ? (env.get('PROXY_CERT') || '') : (labels['proxy.cert'] || '');
	const mode = certificate.toLowerCase();
	if (mode === 'off' || mode === 'auto' || mode === 'custom')
		data.cert = mode;
	else if (certificate) {
		data.cert = 'custom';
		data.cert_file = certificate + '/fullchain.pem';
		data.key_file = certificate + '/privkey.pem';
	}

	const logs = (env.get('PROXY_LOGS') || '').toLowerCase();
	if (logs) {
		if (logs !== 'true' && logs !== 'false')
			throw new Error('PROXY_LOGS must be TRUE or FALSE');
		data.logs = logs === 'true';
	}

	// Which container the file belongs to: what tells it from a file written by hand
	data.docker = name;

	// The same checks as for every site, before the file is written
	Routes.validate(Object.assign({ id: names[0] }, data));
	return { id: names[0], container: name, data };
}

class Docker {

	// options: { socket, network, folder, log(message), error(message), onChange(), interval }
	constructor(options) {
		this.socket = options.socket;
		this.network = options.network || 'proxy';
		this.folder = options.folder;
		this.log = options.log || (() => {});
		this.error = options.error || (() => {});
		this.onChange = options.onChange || (() => {});
		this.interval = options.interval || 30000;
		this.problems = new Set();
		this.failure = '';
		this.running = null;
		this.pending = false;
		this.stopped = true;
		this.timer = null;
		this.retry = null;
		this.stream = null;
	}

	target(path) {
		if (/^https?:\/\//i.test(this.socket)) {
			const url = new URL(this.socket);
			return { hostname: url.hostname, port: url.port || 80, path };
		}
		return { socketPath: this.socket, path };
	}

	// A JSON answer of the Engine API. null for 404 when "optional".
	get(path, optional) {
		return new Promise((resolve, reject) => {
			const req = Http.get(Object.assign(this.target(path), { agent: false, timeout: 10000 }), res => {
				const chunks = [];
				res.on('data', chunk => chunks.push(chunk));
				res.on('error', reject);
				res.on('end', () => {
					const text = Buffer.concat(chunks).toString('utf8');
					if (res.statusCode === 404 && optional)
						return resolve(null);
					try {
						const body = JSON.parse(text);
						if (res.statusCode !== 200)
							throw Object.assign(new Error(body.message || ('Docker answered ' + res.statusCode)), { status: res.statusCode });
						resolve(body);
					} catch (err) {
						reject(err.status ? err : new Error(res.statusCode === 200 ? 'Docker sent an answer that is not JSON' : 'Docker answered ' + res.statusCode));
					}
				});
			});
			req.on('timeout', () => req.destroy(new Error('Docker did not answer in time')));
			req.on('error', reject);
		});
	}

	// The sites that the containers of the network publish now: Map file name → { id, container, data, text }
	// written: the files of now (the container that has a file keeps it when another one says the same name)
	async snapshot(problems, written) {
		const network = await this.get('/networks/' + encodeURIComponent(this.network));
		const ids = Object.keys(network.Containers || {});
		// A container that went away between the two questions is not there
		const containers = (await Promise.all(ids.map(id => this.get('/containers/' + encodeURIComponent(id) + '/json', true)))).filter(Boolean);
		containers.sort((a, b) => String(a.Name).localeCompare(String(b.Name)));

		const sites = new Map();
		for (const container of containers) {
			if (!container.State || !container.State.Running)
				continue;
			const name = String(container.Name || '').replace(/^\//, '');
			let item;
			try {
				item = site(container, { Name: this.network, Id: network.Id });
			} catch (err) {
				problems.add('Docker: the container ' + name + ' is not published: ' + err.message);
				continue;
			}
			if (!item)
				continue;
			const file = item.id + '.json';
			item.text = JSON.stringify(item.data, null, '\t') + '\n';
			const other = sites.get(file);
			if (other) {
				// The one that is published now stays; between two new ones, the first by name
				const keep = written && written.has(file) && written.get(file).container === item.container ? item : other;
				const drop = keep === item ? other : item;
				problems.add('Docker: the containers ' + other.container + ' and ' + item.container + ' both publish ' + item.id + ': ' + drop.container + ' is not published');
				sites.set(file, keep);
				continue;
			}
			sites.set(file, item);
		}
		return sites;
	}

	// The site files that discovery wrote: Map file name → { text, container }
	written() {
		const output = new Map();
		let names = [];
		try {
			names = Fs.readdirSync(this.folder).filter(name => name.endsWith('.json') && name[0] !== '.');
		} catch {}
		for (const name of names) {
			try {
				const text = Fs.readFileSync(Path.join(this.folder, name), 'utf8');
				const data = JSON.parse(text);
				if (data && typeof data.docker === 'string' && data.docker)
					output.set(name, { text, container: data.docker });
			} catch {}
		}
		return output;
	}

	// Makes the folder say what Docker says. Throws when Docker cannot be asked: then nothing is touched.
	async sync() {
		const problems = new Set();
		const wanted = await this.snapshot(problems, this.written());
		if (this.stopped)
			return;
		const written = this.written();
		let changed = false;

		for (const [file, item] of written) {
			if (wanted.has(file))
				continue;
			Fs.rmSync(Path.join(this.folder, file), { force: true });
			changed = true;
			this.log('Docker: removed ' + file + ' (the container ' + item.container + ' does not run)');
		}

		for (const [file, item] of wanted) {
			const current = written.get(file);
			if (current && current.text === item.text)
				continue;
			const filename = Path.join(this.folder, file);
			if (!current && Fs.existsSync(filename)) {
				problems.add('Docker: the container ' + item.container + ' is not published: ' + file + ' was written by hand');
				continue;
			}
			// The name of the temporary file does not end with .json: the proxy never reads it
			const tmp = Path.join(this.folder, '.' + file + '.docker.tmp');
			Fs.mkdirSync(this.folder, { recursive: true, mode: 0o700 });
			Fs.writeFileSync(tmp, item.text, { mode: 0o600 });
			Fs.renameSync(tmp, filename);
			changed = true;
			this.log('Docker: ' + file + ' -> ' + item.data.target + ' (the container ' + item.container + ')');
		}

		// Said once, and again only after it went away
		for (const problem of problems)
			this.problems.has(problem) || this.error(problem);
		this.problems = problems;

		if (changed)
			this.onChange();
	}

	// One sync at a time; a call during one runs another after it. Resolves when the folder is in step.
	reconcile() {
		this.pending = true;
		if (this.running)
			return this.running;
		this.running = (async () => {
			while (this.pending && !this.stopped) {
				this.pending = false;
				try {
					await this.sync();
					this.failure = '';
				} catch (err) {
					// Without a socket there is no Docker to ask (the proxy runs without discovery): said for anything else
					const message = err.code === 'ENOENT' && err.syscall === 'connect' ? '' : 'Docker: ' + this.socket + ': ' + err.message;
					// A network that is not there (yet) is not a mistake of the proxy: said, but not in error.log
					if (message && message !== this.failure && !this.stopped)
						(err.status === 404 ? this.log : this.error)(message);
					this.failure = message;
				}
			}
			this.running = null;
		})();
		return this.running;
	}

	// The events of Docker: a container that joins or leaves the network starts a sync
	listen() {
		if (this.stopped)
			return;
		const again = () => {
			this.stream = null;
			if (!this.stopped && !this.retry) {
				this.retry = setTimeout(() => {
					this.retry = null;
					this.listen();
					// What happened while nobody listened
					this.reconcile();
				}, 3000);
				this.retry.unref();
			}
		};
		const filters = encodeURIComponent(JSON.stringify({ type: ['network', 'container'] }));
		const req = Http.get(Object.assign(this.target('/events?filters=' + filters), { agent: false }), res => {
			if (res.statusCode !== 200) {
				res.resume();
				res.once('close', again);
				return;
			}
			let buffer = '';
			res.setEncoding('utf8');
			res.on('data', chunk => {
				buffer += chunk;
				let index;
				while ((index = buffer.indexOf('\n')) !== -1) {
					const line = buffer.substring(0, index);
					buffer = buffer.substring(index + 1);
					let event;
					try {
						event = JSON.parse(line);
					} catch {
						continue;
					}
					const attributes = (event.Actor && event.Actor.Attributes) || {};
					if (event.Type === 'network' ? attributes.name === this.network : (event.Action === 'start' || event.Action === 'die'))
						this.reconcile();
				}
				if (buffer.length > 1024 * 1024)
					buffer = '';
			});
			res.on('error', () => {});
			res.once('close', again);
		});
		req.on('error', again);
		this.stream = req;
	}

	start() {
		if (!this.stopped)
			return;
		this.stopped = false;
		this.listen();
		this.timer = setInterval(() => this.reconcile(), this.interval);
		this.timer.unref();
		return this.reconcile();
	}

	stop() {
		this.stopped = true;
		clearInterval(this.timer);
		clearTimeout(this.retry);
		this.timer = this.retry = null;
		if (this.stream) {
			this.stream.destroy();
			this.stream = null;
		}
	}
}

Docker.site = site;
module.exports = Docker;
