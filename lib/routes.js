'use strict';

// The routing table: which host names go to which container.
// Stored in data/routes.json; Clients change it through the control API.

const Fs = require('node:fs');
const Net = require('node:net');
const Hosts = require('./hosts');
const Headers = require('./headers');
const CertFiles = require('./cert-files');

const EMPTY_DOCKER_ROUTES = '{"source":"proxy-docker","routes":[]}';
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const TLS = ['off', 'custom', 'auto'];
const USER = /^[^:\s]{1,64}$/;
// scrypt$<salt>$<key>, both base64
const HASH = /^scrypt\$[A-Za-z0-9+/=]{16,64}\$[A-Za-z0-9+/=]{40,64}$/;

// Addresses and networks: "203.0.113.7", "10.0.0.0/8", "2001:db8::/32"
function addresses(value, name) {
	if (value == null || value === '')
		return [];
	if (typeof value === 'string')
		value = value.split(/[\s,]+/);
	if (!Array.isArray(value))
		throw fail(name + ' must be a list of addresses');
	const output = [];
	for (let item of value) {
		item = String(item || '').trim().toLowerCase();
		if (!item || output.includes(item))
			continue;
		const [ip, bits, extra] = item.split('/');
		const family = Net.isIP(ip);
		const max = family === 4 ? 32 : 128;
		if (!family || extra != null || (bits != null && !(/^\d{1,3}$/.test(bits) && +bits <= max)))
			throw fail(name + ': not an address or a network: ' + item);
		output.push(item);
	}
	if (output.length > 200)
		throw fail(name + ': at most 200 addresses');
	return output;
}

// A BlockList for the checks of every request
function blocklist(list) {
	if (!list.length)
		return null;
	const block = new Net.BlockList();
	for (const item of list) {
		const [ip, bits] = item.split('/');
		const type = Net.isIP(ip) === 4 ? 'ipv4' : 'ipv6';
		if (bits == null)
			block.addAddress(ip, type);
		else
			block.addSubnet(ip, +bits, type);
	}
	return block;
}

function fail(message, status) {
	const err = new Error(message);
	err.status = status || 400;
	return err;
}

// The largest own page of a site
const PAGE = 512 * 1024;

// Names that redirect to any address: [{ host, to, path, permanent }]. "path" keeps the path of the request
// (old.example.com/blog → https://new.example.com/blog), "permanent" answers 301 (308) instead of 302 (307).
function forwards(value) {
	if (value == null || value === '')
		return [];
	if (!Array.isArray(value) || value.length > 50)
		throw fail('forwards must be a list of at most 50 names');
	const output = [];
	for (const item of value) {
		const host = Hosts.normalize(item && item.host || '');
		if (!host || !Hosts.valid(host, false))
			throw fail('Invalid forward host name: ' + (item && item.host));
		let to;
		try {
			to = new URL(String(item.to || ''));
		} catch {
			throw fail('forward ' + host + ': the address must start with https:// or http://');
		}
		if ((to.protocol !== 'https:' && to.protocol !== 'http:') || !to.hostname || to.username || to.password || to.href.length > 2048 || /[\r\n]/.test(to.href))
			throw fail('forward ' + host + ': the address must start with https:// or http://');
		if (Hosts.normalize(to.hostname) === host)
			throw fail('forward ' + host + ': it cannot redirect to itself');
		if (output.some(other => other.host === host))
			continue;
		output.push({ host, to: to.href, path: item.path !== false, permanent: item.permanent !== false });
	}
	return output;
}

// Where a forward sends a request
function forwardto(item, url) {
	if (!item.path)
		return item.to;
	const base = new URL(item.to);
	const path = url.startsWith('/') ? url : '/';
	// The path of the address, then the one of the request: https://new.example.com/es + /blog → /es/blog
	return base.origin + base.pathname.replace(/\/$/, '') + path;
}

function hostlist(value, name) {

	if (value == null)
		return [];

	if (typeof value === 'string')
		value = value.split(',');

	if (!Array.isArray(value))
		throw fail(name + ' must be a list of host names');

	const output = [];
	for (let item of value) {
		item = Hosts.normalize(item);
		if (item && !output.includes(item))
			output.push(item);
	}
	return output;
}

function validate(input) {

	if (!input || typeof input !== 'object')
		throw fail('The route must be an object');

	const route = {};

	route.id = String(input.id || '');
	if (!ID.test(route.id))
		throw fail('Invalid route id');

	route.hosts = hostlist(input.hosts, 'hosts');
	route.redirects = hostlist(input.redirects, 'redirects');
	route.forwards = forwards(input.forwards);

	// A route sends its hosts to a container, or only redirects other names to any address (an old domain of the site)
	if (!route.hosts.length && !route.forwards.length)
		throw fail('The route needs at least one host');

	if (route.redirects.length && !route.hosts.length)
		throw fail('Redirects to the main host need a host');

	if (route.hosts.length + route.redirects.length + route.forwards.length > 50)
		throw fail('Too many host names in one route');

	for (const item of route.forwards) {
		if (route.hosts.includes(item.host) || route.redirects.includes(item.host))
			throw fail(item.host + ' is both a host and a redirect');
	}
	if (!route.forwards.length)
		delete route.forwards;

	for (const host of route.hosts) {
		if (!Hosts.valid(host, true))
			throw fail('Invalid host name: ' + host);
	}

	for (const host of route.redirects) {
		if (!Hosts.valid(host, false))
			throw fail('Invalid redirect host name: ' + host);
		if (route.hosts.includes(host))
			throw fail(host + ' is both a host and a redirect');
	}

	if (route.redirects.length && route.hosts[0].startsWith('*.'))
		throw fail('A route with redirects needs a first host that is not a wildcard');

	// Only a route with hosts goes to a container
	if (route.hosts.length || input.target) {
		let target;
		try {
			target = new URL(String(input.target || ''));
		} catch {
			throw fail('Invalid target');
		}

		if (target.protocol !== 'http:' || !target.hostname || target.username || target.password || target.pathname !== '/' || target.search || target.hash)
			throw fail('The target must look like http://container:8000');

		route.target = 'http://' + target.host;
	}

	// The page while the app does not answer (stopped), and the maintenance that shows it even when it answers
	if (input.page != null && input.page !== '') {
		if (typeof input.page !== 'string' || Buffer.byteLength(input.page) > PAGE)
			throw fail('page must be HTML of at most 512 KB');
		route.page = input.page;
	}
	if (input.maintenance === true)
		route.maintenance = true;

	// The limit of requests of each address (settings of Proxy) applies unless the route turns it off
	if (input.limit === false)
		route.limit = false;
	route.https = input.https !== false;
	route.hsts = input.hsts === true;
	// Count the visits of the site (lib/stats.js): no cookies, no addresses kept
	route.stats = input.stats === true;

	// Without its own limit, the route takes the one of the config
	if (input.maxupload != null) {
		const maxupload = Number(input.maxupload);
		if (!Number.isFinite(maxupload) || maxupload < 1 || maxupload > 10240)
			throw fail('maxupload must be between 1 and 10240 MB');
		route.maxupload = Math.round(maxupload);
	}

	// Headers of this site (added when the app does not send them)
	const headers = Headers.parse(input.headers, 'headers');
	if (headers.length)
		route.headers = Object.fromEntries(headers);

	// Who may come: only "allow" when it has addresses, never "deny"
	const allow = addresses(input.allow, 'allow');
	const deny = addresses(input.deny, 'deny');
	if (allow.length)
		route.allow = allow;
	if (deny.length)
		route.deny = deny;

	// A user name and password for the whole site (HTTP Basic)
	if (input.auth != null) {
		if (!Array.isArray(input.auth) || input.auth.length > 50)
			throw fail('auth must be a list of at most 50 users');
		const users = [];
		for (const item of input.auth) {
			const user = String(item && item.user || '');
			const hash = String(item && item.hash || '');
			if (!USER.test(user) || !HASH.test(hash))
				throw fail('auth: every user needs a name without ":" and a scrypt hash');
			if (!users.some(other => other.user === user))
				users.push({ user, hash });
		}
		if (users.length)
			route.auth = users;
	}

	if (input.accesslog != null) {
		if (typeof input.accesslog !== 'boolean')
			throw fail('accesslog must be true or false');
		route.accesslog = input.accesslog;
	}

	if (input.accesslog_dir != null && input.accesslog_dir !== '') {
		const directory = input.accesslog_dir;
		if (typeof directory !== 'string' || directory.length > 240 || !/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/i.test(directory))
			throw fail('accesslog_dir must be a relative subdirectory of the configured access log directory');
		route.accesslog_dir = directory;
	}

	// Compression: true or false here wins over the config
	if (input.compress === true || input.compress === false)
		route.compress = input.compress;

	route.tls = input.tls || 'off';
	if (!TLS.includes(route.tls))
		throw fail('tls must be one of: ' + TLS.join(', '));

	if ('cert_file' in input || 'key_file' in input) {
		if (route.tls !== 'custom')
			throw fail('cert_file and key_file require tls: custom');
		try {
			Object.assign(route, CertFiles.pair(input));
		} catch (err) {
			throw fail(err.message);
		}
	}

	route.challenge = input.challenge === 'dns' ? 'dns' : 'http';
	return route;
}

// A route as stored and shown, without the runtime fields (they start with "$")
function clean(route) {
	const output = {};
	for (const key in route) {
		if (key[0] !== '$')
			output[key] = route[key];
	}
	return output;
}

function target(route) {
	const url = new URL(route.target);
	return { hostname: url.hostname.replace(/^\[|\]$/g, ''), port: +(url.port || 80) };
}

function names(route) {
	return route.hosts.concat(route.redirects, (route.forwards || []).map(item => item.host));
}

function parseRoutes(data) {
	if (!Array.isArray(data))
		throw fail('Routes file must contain an array');
	const items = new Map();
	const owners = new Map();
	for (const item of data) {
		const route = validate(item);
		if (items.has(route.id))
			throw fail('Duplicate route id: ' + route.id);
		for (const host of names(route)) {
			if (owners.has(host))
				throw fail(host + ' already belongs to the route ' + owners.get(host), 409);
			owners.set(host, route.id);
		}
		items.set(route.id, route);
	}
	return items;
}

class Routes {

	constructor(filename, readonly, dockerFilename) {
		this.filename = filename;
		this.readonly = readonly;
		this.dockerFilename = dockerFilename;
		this.manual = new Map();
		this.discovered = new Map();
		this.items = new Map();
		this.index = new Map();
		this.source = null;
		this.watcher = null;
	}

	load(onError = () => {}) {
		let source;
		try {
			source = Fs.readFileSync(this.filename, 'utf8');
		} catch (err) {
			if (err.code !== 'ENOENT' || this.readonly)
				throw err;
			source = '[]';
		}
		this.replace(source);
		if (this.dockerFilename) {
			try {
				this.replaceDocker(Fs.readFileSync(this.dockerFilename, 'utf8'));
			} catch (err) {
				if (err.code !== 'ENOENT')
					onError(err, this.dockerFilename);
			}
		}
	}

	replace(source) {
		this.manual = parseRoutes(JSON.parse(source));
		this.merge();
		this.source = source;
	}

	replaceDocker(source) {
		const document = JSON.parse(source);
		if (document?.source !== 'proxy-docker')
			throw fail('Expected a route snapshot generated by Proxy Docker');
		this.discovered = parseRoutes(document.routes);
		this.merge();
		this.dockerSource = source;
	}

	merge() {
		const items = new Map(this.manual);
		const manualHosts = new Set([...items.values()].flatMap(names));
		const manualWildcards = new Set([...manualHosts].map(Hosts.wildcard));
		for (const route of this.discovered.values()) {
			if (items.has(route.id) || names(route).some(host => manualHosts.has(host) || manualHosts.has(Hosts.wildcard(host)) || manualWildcards.has(host)))
				continue;
			items.set(route.id, route);
		}
		this.rebuild(items);
	}

	watch(onChange, onError) {
		if (!this.readonly || this.watcher)
			return;
		let reading = false;
		const errors = new Map();
		const refresh = async (filename, docker) => {
			try {
				const source = await this.readSource(filename, docker);
				if (this.watcher !== timer)
					return;
				if (source !== (docker ? this.dockerSource : this.source)) {
					if (docker)
						this.replaceDocker(source);
					else
						this.replace(source);
					onChange();
				}
				errors.delete(filename);
			} catch (err) {
				if (this.watcher === timer && errors.get(filename) !== err.message) {
					errors.set(filename, err.message);
					onError(err, filename);
				}
			}
		};
		const timer = setInterval(async () => {
			if (reading)
				return;
			reading = true;
			await Promise.all([refresh(this.filename, false), this.dockerFilename && refresh(this.dockerFilename, true)]);
			reading = false;
		}, 5000);
		this.watcher = timer.unref();
	}

	async readSource(filename, optional) {
		try {
			return await Fs.promises.readFile(filename, 'utf8');
		} catch (err) {
			if (optional && err.code === 'ENOENT')
				return EMPTY_DOCKER_ROUTES;
			throw err;
		}
	}

	unwatch() {
		clearInterval(this.watcher);
		this.watcher = null;
	}

	rebuild(items = this.items) {
		const index = new Map();
		for (const route of items.values()) {
			route.$target = route.target ? target(route) : null;
			route.$page = route.page ? Buffer.from(route.page) : null;
			route.$headers = route.headers ? Object.entries(route.headers) : [];
			route.$allow = route.allow ? blocklist(route.allow) : null;
			route.$deny = route.deny ? blocklist(route.deny) : null;
			route.$authkey = route.auth ? route.auth.map(item => item.user + item.hash).join() : '';
			for (const host of route.hosts)
				index.set(host, { route, redirect: false });
			for (const host of route.redirects)
				index.set(host, { route, redirect: true });
			for (const item of route.forwards || [])
				index.set(item.host, { route, forward: item });
		}
		this.items = items;
		this.index = index;
	}

	write(items) {
		const tmp = this.filename + '.tmp';
		Fs.writeFileSync(tmp, JSON.stringify([...items.values()].map(clean), null, '\t'), { mode: 0o600 });
		Fs.renameSync(tmp, this.filename);
	}

	list() {
		return [...this.items.values()].map(clean);
	}

	get(id) {
		const route = this.items.get(id);
		return route ? clean(route) : null;
	}

	set(input, authorize) {
		if (this.readonly)
			throw fail('Routes are managed by routes_file', 409);
		const route = validate(input);
		if (authorize)
			authorize(route);
		for (const host of route.hosts.concat(route.redirects, (route.forwards || []).map(item => item.host))) {
			const found = this.index.get(host);
			if (found && found.route.id !== route.id)
				throw fail(host + ' already belongs to the route ' + found.route.id, 409);
		}
		const items = new Map(this.items);
		items.set(route.id, route);
		this.write(items);
		this.rebuild(items);
		return clean(route);
	}

	remove(id) {
		if (this.readonly)
			throw fail('Routes are managed by routes_file', 409);
		if (!this.items.has(id))
			return false;
		const items = new Map(this.items);
		items.delete(id);
		this.write(items);
		this.rebuild(items);
		return true;
	}

	// { route, redirect } for a host name, or null. A wildcard matches one label only.
	lookup(host) {
		return this.index.get(host) || this.index.get(Hosts.wildcard(host)) || null;
	}

	// By default, return hosts that can request a Let's Encrypt certificate.
	tlshosts(mode = 'auto') {
		const output = [];
		for (const route of this.items.values()) {
			if (route.tls !== mode)
				continue;
			for (const host of route.hosts.concat(route.redirects, (route.forwards || []).map(item => item.host)))
				output.push({ host, route });
		}
		return output;
	}
}

Routes.validate = validate;
Routes.clean = clean;
Routes.addresses = addresses;
Routes.blocklist = blocklist;
Routes.forwardto = forwardto;

module.exports = Routes;
