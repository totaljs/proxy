'use strict';

// The control API for managing routes. JSON over HTTP, on a Unix socket
// (readable only by the owner) or on a network address with a token.
//
//   GET    /routes           every route
//   GET    /routes/{id}      one route
//   PUT    /routes/{id}      adds or replaces a route
//   DELETE /routes/{id}      removes a route
//   GET    /stats/{id}       the visits of a route by day (?from=YYYY-MM-DD&to=YYYY-MM-DD); DELETE removes them
//   GET    /settings         the settings of every site (addresses denied, limit per address, headers, HSTS, page)
//   PUT    /settings         replaces them
//   GET    /status           ports, DNS zone and the state of each certificate
//   POST   /renew/{host}     asks for a new certificate now
//   GET    /dns/{host}       the CNAME record a host needs for the DNS check

const Fs = require('node:fs');
const Path = require('node:path');
const Http = require('node:http');
const Crypto = require('node:crypto');
const Hosts = require('./hosts');

// Routes and settings carry the HTML of a page (512 KB at most)
const LIMIT = 2 * 1024 * 1024;

function send(res, status, body) {
	const data = JSON.stringify(body);
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data), 'cache-control': 'no-store' });
	res.end(data);
}

function error(message, status) {
	const err = new Error(message);
	err.status = status;
	return err;
}

function readbody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on('data', chunk => {
			size += chunk.length;
			if (size > LIMIT) {
				reject(error('The body is too large', 413));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
			} catch {
				reject(error('The body must be JSON', 400));
			}
		});
		req.on('error', reject);
	});
}

const ROUTE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function sameToken(given, token) {
	const expected = Buffer.from('Bearer ' + token);
	return given.length === expected.length && Crypto.timingSafeEqual(given, expected);
}

function overlap(a, b) {
	return a === b || Hosts.wildcard(a) === b || Hosts.wildcard(b) === a;
}

function loadClients(filename, adminToken) {
	if (!filename)
		return [];
	let entries;
	try {
		entries = JSON.parse(Fs.readFileSync(filename, 'utf8'));
	} catch {
		throw new Error('Cannot read control_clients_file as JSON');
	}
	if (!entries || typeof entries !== 'object' || Array.isArray(entries))
		throw new Error('control_clients_file must contain an object of named clients');
	const clients = [];
	const tokens = new Set([adminToken]);
	for (const [name, value] of Object.entries(entries)) {
		if (!/^[a-z][a-z0-9]{0,23}$/.test(name) || !value || typeof value.token !== 'string' || !/^[a-z0-9_-]{32,128}$/i.test(value.token) || tokens.has(value.token))
			throw new Error('Invalid control client name or token in control_clients_file');
		if (!Array.isArray(value.domains) || !value.domains.length)
			throw new Error('Control client ' + name + ' needs at least one allowed domain');
		const domains = new Set(value.domains.map(Hosts.normalize));
		for (const host of domains) {
			if (!Hosts.valid(host, true))
				throw new Error('Invalid domain for control client ' + name);
			if (clients.some(client => [...client.domains].some(other => overlap(host, other))))
				throw new Error('Overlapping domains for control client ' + name);
		}
		tokens.add(value.token);
		clients.push({ name, prefix: name + '--', token: value.token, domains });
	}
	if (!clients.length)
		throw new Error('control_clients_file must define at least one client');
	return clients;
}

function authenticate(req, adminToken, clients) {
	if (!adminToken && !clients.length)
		return true;
	const given = Buffer.from(String(req.headers.authorization || ''));
	if (adminToken && sameToken(given, adminToken))
		return true;
	return clients.find(client => sameToken(given, client.token)) || false;
}

function allows(scope, host) {
	return scope.domains.has(host) || (!host.startsWith('*.') && scope.domains.has(Hosts.wildcard(host)));
}

function owns(scope, id) {
	return id.startsWith(scope.prefix);
}

function publicRoute(route, scope) {
	return scope ? { ...route, id: route.id.substring(scope.prefix.length) } : route;
}

function routeNames(route) {
	return route.hosts.concat(route.redirects, (route.forwards || []).map(item => item.host));
}

function checkRoute(proxy, scope, route) {
	if (route.cert_file)
		throw error('Certificate file paths are managed by the Proxy administrator', 403);
	for (const host of routeNames(route)) {
		if (!allows(scope, host))
			throw error('Domain is outside this control client’s scope: ' + host, 403);
		for (const [other, match] of proxy.routes.index) {
			if (!owns(scope, match.route.id) && overlap(host, other))
				throw error('Domain conflicts with another route: ' + host, 409);
		}
	}
}

function issocket(target) {
	return /[/\\]|\.sock$/.test(target);
}

async function handle(proxy, clients, req, res) {

	const identity = authenticate(req, proxy.config.token, clients);
	if (!identity) {
		send(res, 401, { error: 'Unauthorized' });
		return;
	}

	const url = new URL(req.url, 'http://proxy');
	let parts;
	try {
		parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
	} catch {
		throw error('Invalid address', 400);
	}

	const [section, id] = parts;
	const method = req.method;
	const scope = identity === true ? null : identity;
	const routeId = scope ? scope.prefix + id : id;
	if (scope && section === 'settings') {
		send(res, 403, { error: 'Global settings are managed by the Proxy administrator' });
		return;
	}

	if (section === 'routes' && parts.length === 1 && method === 'GET') {
		const routes = proxy.routes.list();
		send(res, 200, scope ? routes.filter(route => owns(scope, route.id)).map(route => publicRoute(route, scope)) : routes);
		return;
	}

	if (section === 'routes' && parts.length === 2) {
		if (scope && (!ROUTE_ID.test(id) || !ROUTE_ID.test(routeId)))
			throw error('Invalid route id for this control client', 400);

		if (method === 'GET') {
			const route = proxy.routes.get(routeId);
			route ? send(res, 200, publicRoute(route, scope)) : send(res, 404, { error: 'Route not found' });
			return;
		}

		if (method === 'PUT') {
			const body = await readbody(req);
			if (!body || typeof body !== 'object' || Array.isArray(body))
				throw error('The route must be an object', 400);
			body.id = routeId;
			const route = proxy.routes.set(body, scope ? item => checkRoute(proxy, scope, item) : null);
			proxy.routesChanged();
			proxy.log('Routes: ' + route.id + ' -> ' + route.target + ' (' + route.hosts.join(', ') + ')');
			send(res, 200, publicRoute(route, scope));
			return;
		}

		if (method === 'DELETE') {
			if (!proxy.routes.remove(routeId)) {
				send(res, 404, { error: 'Route not found' });
				return;
			}
			proxy.routesChanged();
			proxy.log('Routes: removed ' + routeId);
			send(res, 200, { success: true });
			return;
		}
	}

	// The visits of a route: the counters of each day between "from" and "to" (YYYY-MM-DD); DELETE removes them
	if (section === 'stats' && parts.length === 2) {
		if (!ROUTE_ID.test(id) || !ROUTE_ID.test(routeId)) {
			send(res, 400, { error: 'Invalid route id' });
			return;
		}
		if (method === 'GET') {
			send(res, 200, proxy.stats.get(routeId, url.searchParams.get('from'), url.searchParams.get('to')));
			return;
		}
		if (method === 'DELETE') {
			proxy.stats.remove(routeId);
			send(res, 200, { success: true });
			return;
		}
	}

	if (section === 'settings' && parts.length === 1) {
		if (method === 'GET') {
			send(res, 200, proxy.settings.get());
			return;
		}
		if (method === 'PUT') {
			const values = proxy.settings.set(await readbody(req));
			proxy.limiter.set(values.ratelimit || null);
			proxy.log('Settings: ' + (values.ratelimit ? values.ratelimit.rate + ' requests a second (' + values.ratelimit.burst + ' at once)' : 'no limit') + ', ' + (values.deny ? values.deny.length : 0) + ' addresses denied');
			send(res, 200, values);
			return;
		}
	}

	if (section === 'status' && parts.length === 1 && method === 'GET') {
		let hosts = proxy.manager.list();
		if (scope) {
			const names = new Set(proxy.routes.list().filter(route => owns(scope, route.id)).flatMap(routeNames));
			hosts = Object.fromEntries(Object.entries(hosts).filter(([host]) => names.has(host)));
		}
		send(res, 200, { version: proxy.version, ports: proxy.ports, dns_zone: proxy.config.dns_zone || null, hosts, scope: scope?.name });
		return;
	}

	if (section === 'renew' && parts.length === 2 && method === 'POST') {
		const host = Hosts.normalize(id);
		if (!proxy.routes.tlshosts().some(item => item.host === host && (!scope || owns(scope, item.route.id)))) {
			send(res, 404, { error: 'No route asks for a certificate for this host' });
			return;
		}
		proxy.manager.renew(host);
		send(res, 202, { success: true });
		return;
	}

	if (section === 'dns' && parts.length === 2 && method === 'GET') {
		const host = Hosts.normalize(id);
		if (!Hosts.valid(host, true))
			throw error('Invalid host name', 400);
		if (scope && !allows(scope, host))
			throw error('Domain is outside this control client’s scope', 403);
		const record = proxy.manager.record(host);
		record ? send(res, 200, record) : send(res, 404, { error: 'The proxy has no dns_zone in its config' });
		return;
	}

	send(res, 404, { error: 'Not found' });
}

exports.listen = function(proxy) {

	const target = proxy.config.control;
	if (!target)
		return Promise.resolve(null);

	const clients = loadClients(proxy.config.control_clients_file, proxy.config.token);
	const server = Http.createServer(function(req, res) {
		handle(proxy, clients, req, res).catch(err => {
			if (!res.headersSent)
				send(res, err.status || 500, { error: err.status ? err.message : 'Internal error' });
			if (!err.status)
				proxy.log('Control: ' + err.stack);
		});
	});

	return new Promise((resolve, reject) => {
		server.once('error', reject);
		if (issocket(target)) {
			try {
				if (Fs.statSync(target).isSocket())
					Fs.unlinkSync(target);
			} catch {}
			// Create the socket with owner-only permissions from the start.
			try {
				Fs.mkdirSync(Path.dirname(target), { recursive: true, mode: 0o700 });
			} catch {}
			const mask = process.umask(0o177);
			server.listen(target, () => {
				process.umask(mask);
				Fs.chmodSync(target, 0o600);
				resolve(server);
			});
		} else {
			if (!proxy.config.token && !clients.length) {
				reject(new Error('A control address on the network needs a token in Proxy config'));
				return;
			}
			const index = target.lastIndexOf(':');
			const host = index === -1 ? '127.0.0.1' : target.substring(0, index);
			const port = +(index === -1 ? target : target.substring(index + 1));
			server.listen(port, host, () => resolve(server));
		}
	});
};
