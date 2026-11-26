'use strict';

// The proxy: listens on HTTP and HTTPS, sends every host to its container,
// answers the ACME checks and keeps the certificates up to date.

const Fs = require('node:fs');
const Path = require('node:path');
const Http = require('node:http');
const Https = require('node:https');
const Hosts = require('./hosts');
const Routes = require('./routes');
const Certs = require('./certs');
const Proxy = require('./proxy');
const Acme = require('./acme');
const Dns = require('./dns');
const Manager = require('./manager');
const Guard = require('./guard');
const Logs = require('./logs');
const Stats = require('./stats');
const Limiter = require('./limiter');
const Workers = require('./workers');
const Docker = require('./docker');

const CHALLENGE = '/.well-known/acme-challenge/';
const BUSY = 'The site is busy right now. Try again in a moment.';
const CROWD = 'Too many requests at once from your address. Try again in a moment.';
const HTTPS_PENDING = 'This site is waiting for its HTTPS certificate. Try again in a moment.';

function listen(server, port) {
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, () => {
			server.removeListener('error', reject);
			resolve(server.address().port);
		});
	});
}

function tune(server, proxy, secure) {
	// Expect: 100-continue is answered after the route is known (see Proxy.checkcontinue)
	server.on('checkContinue', (req, res) => proxy.request(req, res, secure, true).catch(err => proxy.broken(err, req, res)));
	server.headersTimeout = 30000;
	// A whole request, body included, within 10 minutes: a client that sends a byte now and then holds no connection of
	// a site for ever
	server.requestTimeout = 600000;
	server.keepAliveTimeout = 65000;
	server.maxConnections = proxy.config.http_active + proxy.config.ws_active + 1024;
	server.on('clientError', (err, socket) => socket.destroy());
	return server;
}


function clientip(req) {
	const ip = req.socket.remoteAddress || '';
	return ip.startsWith('::ffff:') ? ip.substring(7) : ip;
}

class ProxyServer {

	// options: { log: false | function(message) }
	// With more than one worker in the config this process is the "primary": it keeps the files, the certificates
	// and the visits, and its workers (lib/worker.js, role "worker") serve HTTP, HTTPS and WebSockets.
	constructor(config, options) {
		options = options || {};
		this.config = config;
		this.role = options.role || (config.workers > 1 ? 'primary' : 'single');
		const worker = this.role === 'worker';
		this.version = require('../package.json').version;
		this.options = options;
		// logs/<site>.log and logs/error.log; a worker sends its lines to the primary
		this.logs = new Logs(config.logs, config.logs_maxsize, options.logs);
		// What happens goes to the output of the process; what goes wrong goes to logs/error.log too
		// One line each, also when a message carries what someone else wrote (a container, a request)
		this.log = options.log === false ? () => {} : (options.log || (message => console.log(new Date().toISOString() + '  ' + Logs.clean(message))));
		this.error = message => {
			this.log(message);
			this.logs.error(message);
		};
		// A request that the app of a site did not answer
		this.failed = (req, route, host, status, reason) => {
			this.stats.failed(route.id);
			this.logs.error('Upstream: ' + host + ' ' + req.method + ' ' + JSON.stringify(req.url) + ' ' + status + ' ' + route.target + ' ' + reason);
		};
		this.routes = new Routes(config.sites);
		// A site file with a mistake: said once, and the site keeps what it had
		this.invalid = (err, filename) => this.error('Sites: ' + filename + ' was not applied: ' + err.message);
		// The containers of the Docker network write their own site files
		this.docker = !worker && config.docker ? new Docker({ socket: config.docker, network: config.docker_network, folder: config.sites, log: message => this.log(message), error: message => this.error(message), onChange: () => this.rescan() }) : null;
		this.certs = new Certs(Path.join(config.data, 'certs'), Path.join(config.data, 'custom'), this.error);
		this.challenges = new Map();
		// A worker asks the primary for the answer of an ACME check
		this.challenge = options.challenge || (token => this.challenges.get(token));
		this.ticketKeys = options.ticketKeys || null;
		this.dns = !worker && config.dns_zone ? new Dns.Server({ zone: config.dns_zone, ns: config.dns_ns }) : null;
		this.acme = worker ? null : new Acme({ directory: config.acme, email: config.email, folder: Path.join(config.data, 'acme'), ca: config.acme_ca ? Fs.readFileSync(config.acme_ca) : null, log: this.log });
		this.manager = worker ? null : new Manager(this);
		this.workers = this.role === 'primary' ? new Workers(this) : null;
		// The requests of each site, counted (data/stats): a worker sends what it counted to the primary
		this.stats = new Stats(Path.join(config.data, 'stats'), config.stats_days, { send: options.stats, fold: options.fold });
		// Of every site (config): the addresses that never come in, the page of a site that does not answer, and the
		// per-IP request rate limit
		this.denied = null;
		this.page = null;
		this.ratelimit = null;
		this.limiter = new Limiter();
		this.upstreamAgent = Proxy.createAgent(config.upstream_connections, config.upstream_idle_connections);
		this.httpCapacity = new Limiter.Capacity(config.http_active, config.http_active_per_route, config.http_active_per_ip);
		this.wsCapacity = new Limiter.Capacity(config.ws_active, config.ws_active_per_route, config.ws_active_per_ip);
		this.ports = {};
	}

	async start() {
		try {
			return await this.open();
		} catch (err) {
			this.error('Startup failed: ' + err.message);
			await this.stop();
			throw err;
		}
	}

	async open() {

		Fs.mkdirSync(this.config.data, { recursive: true, mode: 0o700 });
		// Made before with other rights: the keys and the account are only for the proxy
		try {
			Fs.chmodSync(this.config.data, 0o700);
		} catch {}
		this.stats.start();

		if (this.role === 'worker')
			this.routes.assign(this.options.routes || []);
		else {
			this.logs.prepare();
			try {
				Fs.mkdirSync(this.config.sites, { recursive: true, mode: 0o700 });
			} catch {}
			this.routes.load(this.invalid);
		}
		this.apply();
		this.limiter.start();
		// The file of before: said, so a limit or a denied address does not go away without a word
		if (this.role !== 'worker' && Fs.existsSync(Path.join(this.config.data, 'settings.json')))
			this.error('Settings: data/settings.json is no longer read: move ratelimit, deny, headers, hsts and page to config.json');
		this.certs.load();
		this.bindCertificates();
		Proxy.errorpages(this.config.errors);

		if (this.dns)
			this.ports.dns = await this.dns.listen(this.config.dns);

		if (this.workers)
			Object.assign(this.ports, await this.workers.start());
		else
			await this.listen();

		if (this.role === 'worker')
			return this;

		this.manager.start();
		this.routes.watch(() => this.sitesChanged(), this.invalid, this.options.watch);
		// A certificate that someone put in data/certs, replaced or removed
		let signature = this.certs.signature();
		this.certwatch = setInterval(() => {
			const now = this.certs.signature();
			if (now === signature)
				return;
			signature = now;
			this.certs.load();
			this.bindCertificates();
			this.certsChanged();
			this.manager.schedule(0);
			this.log('Certificates: reloaded');
		}, this.options.watch || 2000);
		this.certwatch.unref();
		// Not awaited: the proxy serves while Docker is asked, and without Docker too
		this.docker?.start();

		this.log('Total.js Proxy ' + this.version + ': HTTP ' + this.ports.http + ', HTTPS ' + this.ports.https + (this.dns ? ', DNS ' + this.ports.dns + ' for ' + this.config.dns_zone : '') + ', ' + this.routes.items.size + ' sites' + (this.workers ? ', ' + this.config.workers + ' workers' : ''));
		return this;
	}

	async listen() {
		// A request that throws is answered and said: it never ends the process, and every site with it
		this.http = tune(Http.createServer((req, res) => this.request(req, res, false).catch(err => this.broken(err, req, res))), this, false);
		this.http.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head, false).catch(err => this.broken(err, req, null, socket)));
		this.ports.http = await listen(this.http, this.config.http);

		this.https = tune(Https.createServer({ SNICallback: (name, callback) => this.sni(name, callback), minVersion: 'TLSv1.2', handshakeTimeout: 15000 }, (req, res) => this.request(req, res, true).catch(err => this.broken(err, req, res))), this, true);
		this.https.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head, true).catch(err => this.broken(err, req, null, socket)));
		this.https.on('tlsClientError', () => {});
		// The same keys in every worker: a TLS session started in one is resumed in another
		if (this.ticketKeys)
			this.https.setTicketKeys(this.ticketKeys);
		this.ports.https = await listen(this.https, this.config.https);
	}

	async stop() {
		this.routes.unwatch();
		clearInterval(this.certwatch);
		this.docker?.stop();
		this.manager?.stop();
		this.limiter.stop();
		this.upstreamAgent.destroy();
		Proxy.closeall();
		const close = server => server && server.listening ? new Promise(resolve => {
			server.close(() => resolve());
			server.closeAllConnections && server.closeAllConnections();
		}) : null;
		await Promise.all([close(this.http), close(this.https), this.workers?.stop()]);
		// After the workers ended: what they counted last is in
		this.stats.stop();
		if (this.dns)
			this.dns.close();
		await this.logs.close();
	}

	bindCertificates() {
		this.certs.bind(this.routes.items.values(), this.config.custom_cert_dir, this.config.custom_certs);
	}

	sitesChanged() {
		this.routesChanged();
		this.log('Sites: reloaded, ' + this.routes.items.size + ' sites');
	}

	// Right after Docker discovery wrote or removed files: not at the next look of the watcher
	rescan() {
		if (this.routes.scan(this.invalid))
			this.sitesChanged();
	}

	routesChanged() {
		this.bindCertificates();
		this.manager.schedule();
		this.workers?.reload('routes', this.routes.list());
	}

	// A new certificate of Let's Encrypt is on the disk
	certsChanged() {
		this.workers?.reload('certs');
	}

	// In a worker: what the primary changed (the sites come with the message, the certificates are read from the disk)
	reload(what, data) {
		try {
			if (what === 'routes')
				this.routes.assign(data || []);
			else
				this.certs.load();
			this.bindCertificates();
		} catch (err) {
			this.error('Workers: could not reload the ' + what + ': ' + err.message);
		}
	}

	// A config whose changes need no restart (Config.LIVE): applied while the proxy runs
	reconfigure(config) {
		Object.assign(this.config, config);
		const values = this.config;
		this.httpCapacity.total = values.http_active;
		this.httpCapacity.perRoute = values.http_active_per_route;
		this.httpCapacity.perAddress = values.http_active_per_ip;
		this.wsCapacity.total = values.ws_active;
		this.wsCapacity.perRoute = values.ws_active_per_route;
		this.wsCapacity.perAddress = values.ws_active_per_ip;
		this.upstreamAgent.maxSockets = values.upstream_connections;
		this.upstreamAgent.maxFreeSockets = Math.min(values.upstream_connections, values.upstream_idle_connections);
		for (const server of [this.http, this.https]) {
			if (server)
				server.maxConnections = values.http_active + values.ws_active + 1024;
		}
		this.logs.maxsize = values.logs_maxsize * 1024 * 1024;
		this.stats.days = values.stats_days;
		Proxy.errorpages(values.errors);
		this.apply();
		this.workers?.configure();
	}

	// What the config says for every site, ready for the requests
	apply() {
		const config = this.config;
		this.denied = config.deny.length ? Routes.blocklist(config.deny) : null;
		this.page = config.page ? Buffer.from(config.page) : null;
		// The buckets start again only when the limit itself changed
		if (config.ratelimit !== this.ratelimit) {
			this.ratelimit = config.ratelimit;
			// Four times the rate at once: what a browser asks for when it opens a page
			this.limiter.set(config.ratelimit ? { rate: config.ratelimit, burst: config.ratelimit * 4 } : null);
		}
	}

	// true when an HTTPS request asks for another site than the one its connection was made for. The name of the
	// connection (SNI) is not there on a TLS session that was resumed: then the site of the Host must be one that
	// is served over HTTPS at all, so a site without a certificate is never reached through the one of another.
	misdirected(req, host, match) {
		const name = req.socket.servername;
		if (name)
			return !!host && Hosts.normalize(name) !== host;
		return !!match && !this.certificate(host, match);
	}

	certificate(host, match) {
		if (!match || match.cert === 'off')
			return null;
		const now = Date.now();
		if (match.cert === 'custom')
			return this.certs.customFor(match.route, host, now).item || null;
		return this.certs.find(host, item => item.notBefore <= now && item.notAfter > now);
	}

	sni(name, callback) {
		const host = Hosts.normalize(name || '');
		const item = host && this.certificate(host, this.routes.lookup(host));
		if (item)
			callback(null, item.context);
		else
			callback(new Error('No certificate for ' + host));
	}

	address(host, secure) {
		const port = secure ? this.ports.https : this.ports.http;
		return (secure ? 'https://' : 'http://') + host + (port === (secure ? 443 : 80) ? '' : ':' + port);
	}

	transport(match, host, req, secure) {
		if (secure || !match.route.https || match.cert === 'off')
			return null;
		return this.certificate(host, match)
			? [301, { location: this.address(host, true) + req.url }]
			: [503, { 'retry-after': '60' }];
	}

	// What the proxy needs from the config for one route
	info(route, host, secure) {
		const config = this.config;
		return { secure, host, failed: this.failed, agent: this.upstreamAgent, port: secure ? this.ports.https : this.ports.http, maxupload: route.maxupload || config.maxupload, hsts: config.hsts, headers: config.headers, compress: route.compress == null ? config.compress : route.compress, page: route.$page || this.page };
	}

	// The addresses that never come in and the limit of requests of each one: null when the request may go on, else
	// [status, message, headers]. Routes with limit off skip the per-IP rate limit.
	limit(req, route) {
		const ip = clientip(req);
		if (this.denied && ip && this.denied.check(ip, ip.includes(':') ? 'ipv6' : 'ipv4'))
			return [403, 'This server is not open to your address.'];
		if (route && route.limit === false)
			return null;
		const wait = this.limiter.take(ip);
		return wait ? [429, 'Too many requests. Try again in a moment.', { 'retry-after': String(wait) }] : null;
	}

	// Where a name of a route goes when it redirects: to the main host, or to any address (forward)
	redirect(match, req) {
		if (match.forward) {
			const permanent = match.forward.permanent;
			const keep = req.method === 'GET' || req.method === 'HEAD';
			return [permanent ? (keep ? 301 : 308) : (keep ? 302 : 307), Routes.forwardto(match.forward, req.url)];
		}
		if (match.redirect) {
			const host = match.route.hosts[0];
			return [301, this.address(host, !!this.certificate(host, this.routes.lookup(host))) + req.url];
		}
		return null;
	}

	// The browser challenge for a protected upstream. HTTP-to-HTTPS redirects happen before asking for credentials.
	async authenticate(req, route) {
		const answer = await Guard.authorized(route, req.headers.authorization, clientip(req));
		// Too many wrong passwords from this address: it waits, and nothing is checked meanwhile
		if (typeof answer === 'number')
			return [429, 'Too many wrong passwords. Try again in a moment.', { 'retry-after': String(answer) }];
		if (!answer)
			return [401, 'This site needs a user name and a password.', { 'www-authenticate': 'Basic realm="' + route.hosts[0].replace(/^\*\./, '') + '", charset="UTF-8"' }];
		return null;
	}

	// A mistake of the proxy itself while it served a request: 500 for that request, the reason in logs/error.log
	broken(err, req, res, socket) {
		try {
			this.error('Request: ' + req.method + ' ' + JSON.stringify(req.url) + ' failed: ' + (err && err.stack || err));
			if (res && !res.headersSent) {
				res.setHeader('connection', 'close');
				Proxy.page(res, 500, 'Something went wrong on this server.');
			} else if (res)
				res.destroy();
			else
				Proxy.raw(socket, 500, {});
		} catch {
			(res || socket).destroy();
		}
	}

	async request(req, res, secure, expect) {

		const host = Hosts.fromheader(req.headers.host);
		const match = host ? this.routes.lookup(host) : null;
		const started = Date.now();
		// Counted, and written to the log of the site, when the answer ends
		if (match) {
			const id = match.route.id;
			// Now: a connection that is closed has no address any more
			const ip = clientip(req);
			const logged = match.route.logs !== false && this.logs.folder;
			// "close" and not "finish": a request whose client went away reached the app too, and is counted and
			// written as 499
			res.once('close', () => {
				const status = res.writableFinished ? res.statusCode : 499;
				this.stats.hit(id, status, Date.now() - started);
				logged && this.logs.access(id, req, status, ip, host, started);
			});
		}

		if (!secure && req.url.startsWith(CHALLENGE)) {
			const value = await this.challenge(req.url.substring(CHALLENGE.length));
			if (req.socket.destroyed)
				return;
			if (value) {
				res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
				res.end(value);
				return;
			}
		}

		// Over HTTPS the certificate was chosen for one host name: another Host on that connection is another site
		if (secure && this.misdirected(req, host, match)) {
			Proxy.page(res, 421, 'This connection is for another site.');
			return;
		}

		const limited = this.limit(req, match && match.route);
		if (limited) {
			res.setHeader('connection', 'close');
			Proxy.page(res, limited[0], limited[1], limited[2]);
			return;
		}

		if (!match) {
			Proxy.unknown(req, res, host);
			return;
		}

		const route = match.route;
		if (!Guard.allowed(route, clientip(req))) {
			res.setHeader('connection', 'close');
			Proxy.page(res, 403, 'This site is not open to your address.');
			return;
		}

		const redirect = this.redirect(match, req);
		if (redirect) {
			res.writeHead(redirect[0], { location: redirect[1], 'content-length': 0 });
			res.end();
			return;
		}

		const transport = this.transport(match, host, req, secure);
		if (transport) {
			if (transport[0] === 301) {
				res.writeHead(301, { location: transport[1].location, 'content-length': 0 });
				res.end();
			} else {
				res.setHeader('connection', 'close');
				Proxy.page(res, 503, HTTPS_PENDING, transport[1]);
			}
			return;
		}

		const busy = this.httpCapacity.take(route.id, res, clientip(req));
		if (busy) {
			res.setHeader('connection', 'close');
			if (busy === 'address')
				Proxy.page(res, 429, CROWD, { 'retry-after': '1' });
			else
				Proxy.page(res, 503, BUSY, { 'retry-after': '1' });
			return;
		}

		const refused = route.auth && await this.authenticate(req, route);
		if (req.socket.destroyed)
			return;
		if (refused) {
			// The body of a refused request is not read
			res.setHeader('connection', 'close');
			Proxy.page(res, refused[0], refused[1], refused[2]);
			return;
		}

		const info = this.info(route, host, secure);

		// Maintenance: the page of the site, even when its app answers
		if (route.maintenance) {
			Proxy.stopped(req, res, info);
			return;
		}

		if (expect && !Proxy.checkcontinue(req, res, info.maxupload))
			return;

		Proxy.web(req, res, route, info);
	}

	async upgrade(req, socket, head, secure) {

		// Node takes away its own error handler from an upgraded socket: without this one, a client that resets the
		// connection while the proxy answers would end the process, and every site with it
		socket.on('error', () => socket.destroy());

		// Only WebSockets: another protocol (h2c) would pass the upload limit, the headers and the access log
		if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
			Proxy.raw(socket, 400, {});
			return;
		}

		const host = Hosts.fromheader(req.headers.host);
		const match = host ? this.routes.lookup(host) : null;
		if (secure && this.misdirected(req, host, match)) {
			Proxy.raw(socket, 421, {});
			return;
		}

		const limited = this.limit(req, match && match.route);
		if (limited) {
			Proxy.raw(socket, limited[0], limited[2] || {});
			return;
		}

		if (!match) {
			Proxy.raw(socket, 404, {});
			return;
		}

		const route = match.route;
		if (!Guard.allowed(route, clientip(req))) {
			Proxy.raw(socket, 403, {});
			return;
		}

		const redirect = this.redirect(match, req);
		if (redirect) {
			Proxy.raw(socket, redirect[0], { location: redirect[1] });
			return;
		}

		const transport = this.transport(match, host, req, secure);
		if (transport) {
			Proxy.raw(socket, transport[0], transport[1]);
			return;
		}

		const busy = this.wsCapacity.take(route.id, socket, clientip(req));
		if (busy) {
			Proxy.raw(socket, busy === 'address' ? 429 : 503, { 'retry-after': '1' });
			return;
		}

		const refused = route.auth && await this.authenticate(req, route);
		if (req.socket.destroyed)
			return;
		if (refused) {
			Proxy.raw(socket, refused[0], refused[2] || {});
			return;
		}

		if (route.maintenance) {
			Proxy.raw(socket, 503, { 'retry-after': '60' });
			return;
		}

		this.stats.websocket(route.id);
		if (route.logs !== false && this.logs.folder)
			this.logs.access(route.id, req, 101, clientip(req), host, Date.now());
		Proxy.ws(req, socket, head, route, this.info(route, host, secure));
	}
}

module.exports = ProxyServer;
