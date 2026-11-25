'use strict';

// The edge: listens on HTTP and HTTPS, sends every host to its container,
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
const Control = require('./control');
const Guard = require('./guard');
const AccessLog = require('./accesslog');
const Stats = require('./stats');
const Settings = require('./settings');
const Limiter = require('./limiter');

const CHALLENGE = '/.well-known/acme-challenge/';
const BUSY = 'The site is busy right now. Try again in a moment.';
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

function tune(server, edge, secure) {
	// Expect: 100-continue is answered after the route is known (see Proxy.checkcontinue)
	server.on('checkContinue', (req, res) => edge.request(req, res, secure, true));
	server.headersTimeout = 30000;
	// A whole request, body included, within 10 minutes: a client that sends a byte now and then holds no connection of
	// a site for ever
	server.requestTimeout = 600000;
	server.keepAliveTimeout = 65000;
	server.maxConnections = edge.config.http_active + edge.config.ws_active + 1024;
	server.on('clientError', (err, socket) => socket.destroy());
	return server;
}

// true when the name of TLS (SNI) and the Host of an HTTPS request are not the same site
function misdirected(req, host) {
	const name = req.socket && req.socket.servername;
	return !!(name && host && Hosts.normalize(name) !== host);
}

function clientip(req) {
	const ip = req.socket.remoteAddress || '';
	return ip.startsWith('::ffff:') ? ip.substring(7) : ip;
}

class Edge {

	// options: { log: false | function(message) }
	constructor(config, options) {
		options = options || {};
		this.config = config;
		this.version = require('../package.json').version;
		this.events = new AccessLog.Events(config.eventlog);
		this.log = options.log === false ? () => {} : (options.log || (message => this.events.write(message)));
		this.routes = new Routes(config.routes_file || Path.join(config.data, 'routes.json'), !!config.routes_file, config.docker_routes_file);
		this.certs = new Certs(Path.join(config.data, 'certs'), Path.join(config.data, 'custom'), this.log);
		this.challenges = new Map();
		this.dns = config.dns_zone ? new Dns.Server({ zone: config.dns_zone, ns: config.dns_ns }) : null;
		this.acme = new Acme({ directory: config.acme, email: config.email, folder: Path.join(config.data, 'acme'), ca: config.acme_ca ? Fs.readFileSync(config.acme_ca) : null, log: this.log });
		this.manager = new Manager(this);
		this.accesslog = new AccessLog(config.accesslog, config.accesslog_days, config.accesslog_maxsize);
		// The visits of the sites that ask for them (route option "stats")
		this.stats = new Stats(Path.join(config.data, 'stats'), config.stats_days);
		// The settings of every site that Code changes (Settings → Security), and the limit of requests of each address
		this.settings = new Settings(Path.join(config.data, 'settings.json'));
		this.limiter = new Limiter();
		this.upstreamAgent = Proxy.createAgent(config.upstream_connections, config.upstream_idle_connections);
		this.httpCapacity = new Limiter.Capacity(config.http_active, config.http_active_per_route);
		this.wsCapacity = new Limiter.Capacity(config.ws_active, config.ws_active_per_route);
		this.ports = {};
	}

	async start() {
		try {
			return await this.open();
		} catch (err) {
			this.log('Startup failed: ' + err.message);
			await this.stop();
			throw err;
		}
	}

	async open() {

		Fs.mkdirSync(this.config.data, { recursive: true, mode: 0o700 });
		// Made before with other rights: the keys, the account and the control socket are only for the edge
		try {
			Fs.chmodSync(this.config.data, 0o700);
		} catch {}
		this.stats.start();

		this.routes.load((err, filename) => this.log('Routes: could not load ' + filename + ': ' + err.message));
		this.settings.load();
		this.limiter.set(this.settings.get().ratelimit || null);
		this.limiter.start();
		this.certs.load();
		this.bindCertificates();
		Proxy.errorpages(this.config.errors);

		if (this.dns)
			this.ports.dns = await this.dns.listen(this.config.dns);

		this.http = tune(Http.createServer((req, res) => this.request(req, res, false)), this, false);
		this.http.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head, false));
		this.ports.http = await listen(this.http, this.config.http);

		this.https = tune(Https.createServer({ SNICallback: (name, callback) => this.sni(name, callback), minVersion: 'TLSv1.2', handshakeTimeout: 15000 }, (req, res) => this.request(req, res, true)), this, true);
		this.https.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head, true));
		this.https.on('tlsClientError', () => {});
		this.ports.https = await listen(this.https, this.config.https);

		this.control = await Control.listen(this);
		this.manager.start();
		this.routes.watch(() => {
			this.routesChanged();
			this.log('Routes: reloaded ' + this.routes.items.size + ' routes');
		}, (err, filename) => this.log('Routes: could not reload ' + filename + ': ' + err.message));

		this.log('Total.js Edge ' + this.version + ': HTTP ' + this.ports.http + ', HTTPS ' + this.ports.https + (this.dns ? ', DNS ' + this.ports.dns + ' for ' + this.config.dns_zone : '') + ', ' + this.routes.items.size + ' routes');
		return this;
	}

	async stop() {
		this.routes.unwatch();
		this.manager.stop();
		this.limiter.stop();
		this.accesslog.close();
		this.stats.stop();
		this.upstreamAgent.destroy();
		Proxy.closeall();
		const close = server => server && server.listening ? new Promise(resolve => {
			server.close(() => resolve());
			server.closeAllConnections && server.closeAllConnections();
		}) : null;
		await Promise.all([close(this.http), close(this.https), close(this.control)]);
		if (this.dns)
			this.dns.close();
		await this.events.close();
	}

	bindCertificates() {
		this.certs.bind(this.routes.items.values(), this.config.custom_cert_dir, this.config.custom_certs);
	}

	routesChanged() {
		this.bindCertificates();
		this.manager.schedule();
	}

	certificate(host, match) {
		if (!match || match.route.tls === 'off')
			return null;
		const now = Date.now();
		if (match.route.tls === 'custom')
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
		if (secure || !match.route.https || match.route.tls === 'off')
			return null;
		return this.certificate(host, match)
			? [301, { location: this.address(host, true) + req.url }]
			: [503, { 'retry-after': '60' }];
	}

	// What the proxy needs from the config for one route
	info(route, host, secure) {
		const config = this.config;
		const settings = this.settings;
		// The headers and HSTS of the settings win over the ones of the config file
		return { secure, host, agent: this.upstreamAgent, port: secure ? this.ports.https : this.ports.http, maxupload: route.maxupload || config.maxupload, hsts: settings.get().hsts || config.hsts, headers: settings.$headers || config.headers, compress: route.compress == null ? config.compress : route.compress, page: route.$page || settings.$page };
	}

	// The addresses that never come in and the limit of requests of each one: null when the request may go on, else
	// [status, message, headers]. Code itself (a route with limit off) has no limit, so its people never wait.
	limit(req, route) {
		const ip = clientip(req);
		if (this.settings.denied(ip))
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
			return [301, this.address(host, !!this.certificate(host, match)) + req.url];
		}
		return null;
	}

	// The browser challenge for a protected upstream. HTTP-to-HTTPS redirects happen before asking for credentials.
	async authenticate(req, route) {
		if (!(await Guard.authorized(route, req.headers.authorization)))
			return [401, 'This site needs a user name and a password.', { 'www-authenticate': 'Basic realm="' + route.hosts[0].replace(/^\*\./, '') + '", charset="UTF-8"' }];
		return null;
	}

	async request(req, res, secure, expect) {

		const host = Hosts.fromheader(req.headers.host);
		const match = host ? this.routes.lookup(host) : null;
		const started = Date.now();
		if (this.config.accesslog && (match?.route.accesslog ?? this.config.accesslog_default))
			res.once('finish', () => this.accesslog.write(req, res, clientip(req), host, started, match?.route));

		if (!secure && req.url.startsWith(CHALLENGE)) {
			const value = this.challenges.get(req.url.substring(CHALLENGE.length));
			if (value) {
				res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
				res.end(value);
				return;
			}
		}

		// Over HTTPS the certificate was chosen for one host name: another Host on that connection is another site
		if (secure && misdirected(req, host)) {
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
			Proxy.page(res, 404, 'No site is published at this address.');
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

		if (!this.httpCapacity.take(route.id, res)) {
			res.setHeader('connection', 'close');
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

		// The visits of this site, when it asks for them: counted when the answer ends
		if (route.stats)
			res.once('finish', () => this.stats.record(route, { method: req.method, path: req.url, status: res.statusCode, ms: Date.now() - started, ip: clientip(req), ua: req.headers['user-agent'], referer: req.headers.referer }));

		if (expect && !Proxy.checkcontinue(req, res, info.maxupload))
			return;

		Proxy.web(req, res, route, info);
	}

	async upgrade(req, socket, head, secure) {

		// Node takes away its own error handler from an upgraded socket: without this one, a client that resets the
		// connection while the edge answers would end the process, and every site with it
		socket.on('error', () => socket.destroy());

		// Only WebSockets: another protocol (h2c) would pass the upload limit, the headers and the access log
		if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
			Proxy.raw(socket, 400, {});
			return;
		}

		const host = Hosts.fromheader(req.headers.host);
		if (secure && misdirected(req, host)) {
			Proxy.raw(socket, 421, {});
			return;
		}
		const match = host ? this.routes.lookup(host) : null;

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

		if (!this.wsCapacity.take(route.id, socket)) {
			Proxy.raw(socket, 503, { 'retry-after': '1' });
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

		Proxy.ws(req, socket, head, route, this.info(route, host, secure));
	}
}

module.exports = Edge;
