'use strict';

// The sites: which host names go to which container. Each site is a JSON file in data/sites, named after the site
// (totaljs.com.json): { "hosts": ["totaljs.com", "www.totaljs.com"], "target": "172.18.0.5:8000", "logs": true }.
// The folder is watched: a file that is added, changed or removed is applied by itself. A file with a mistake is
// reported and the site keeps what it had. Docker discovery (lib/docker.js) writes the same files for the containers
// that publish themselves.

const Fs = require('node:fs');
const Path = require('node:path');
const Net = require('node:net');
const Hosts = require('./hosts');
const Headers = require('./headers');
const CertFiles = require('./cert-files');

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
// The largest file of a site: its options and its page (512 KB)
const FILE = 2 * 1024 * 1024;
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

// A list of host names. A name may say how it is served: "https://totaljs.com" (a certificate, and HTTP redirects
// to HTTPS) or "http://totaljs.com" (HTTP only). A name alone follows "cert" of the site. schemes: { host: 'https' }
function hostlist(value, name, schemes) {

	if (value == null)
		return [];

	if (typeof value === 'string')
		value = value.split(',');

	if (!Array.isArray(value))
		throw fail(name + ' must be a list of host names');

	const output = [];
	for (let item of value) {
		item = String(item == null ? '' : item).trim();
		const scheme = (/^https?:\/\//i.exec(item) || [''])[0];
		// "https://totaljs.com/" is the same; a port or a path is not a host name
		if (scheme)
			item = item.substring(scheme.length).replace(/\/$/, '');
		item = Hosts.normalize(item);
		if (!item || output.includes(item))
			continue;
		if (scheme)
			schemes[item] = scheme.length === 8 ? 'https' : 'http';
		output.push(item);
	}
	return output;
}

// How a host name of a route is served: 'off', 'auto' or 'custom'
function mode(route, host) {
	const scheme = route.$schemes && route.$schemes[host];
	if (scheme === 'http')
		return 'off';
	if (scheme === 'https')
		return route.cert === 'custom' ? 'custom' : 'auto';
	return route.cert;
}

function validate(input) {

	if (!input || typeof input !== 'object')
		throw fail('The route must be an object');

	const route = {};

	route.id = String(input.id || '');
	if (!ID.test(route.id))
		throw fail('Invalid route id');

	const schemes = {};
	route.hosts = hostlist(input.hosts, 'hosts', schemes);
	route.redirects = hostlist(input.redirects, 'redirects', schemes);
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
			// "172.18.0.5:8000" is the same as "http://172.18.0.5:8000"
			const text = String(input.target || '').trim();
			target = new URL(text.includes('://') ? text : 'http://' + text);
		} catch {
			throw fail('Invalid target');
		}

		if (target.protocol !== 'http:' || !target.hostname || target.username || target.password || target.pathname !== '/' || target.search || target.hash)
			throw fail('The target must look like container:8000 or http://container:8000');

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

	// The requests of the site go to logs/<site>.log unless it says false
	if (input.logs != null) {
		if (typeof input.logs !== 'boolean')
			throw fail('logs must be true or false');
		route.logs = input.logs;
	}

	// Compression: true or false here wins over the config
	if (input.compress === true || input.compress === false)
		route.compress = input.compress;

	// The name of before: said, so a site does not go to plain HTTP without a word
	if (input.tls != null)
		throw fail('"tls" is now "cert"');
	route.cert = input.cert || 'off';
	if (!TLS.includes(route.cert))
		throw fail('cert must be one of: ' + TLS.join(', '));

	if ('cert_file' in input || 'key_file' in input) {
		if (route.cert !== 'custom')
			throw fail('cert_file and key_file require cert: custom');
		try {
			Object.assign(route, CertFiles.pair(input));
		} catch (err) {
			throw fail(err.message);
		}
	}

	// Written by Docker discovery: the container of the site
	if (input.docker != null && input.docker !== '') {
		if (typeof input.docker !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,127}$/i.test(input.docker))
			throw fail('docker must be the name of a container');
		route.docker = input.docker;
	}

	route.challenge = input.challenge === 'dns' ? 'dns' : 'http';
	// Runtime: not stored as a field, the names are written back with their scheme (see clean)
	route.$schemes = schemes;
	return route;
}

// A route as stored and shown, without the runtime fields (they start with "$")
function clean(route) {
	const output = {};
	const schemes = route.$schemes || {};
	const written = host => schemes[host] ? schemes[host] + '://' + host : host;
	for (const key in route) {
		if (key[0] !== '$')
			output[key] = key === 'hosts' || key === 'redirects' ? route[key].map(written) : route[key];
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

// What tells that a file changed
function signature(info) {
	return info.mtimeMs + ':' + info.size + ':' + info.ino;
}

class Routes {

	constructor(folder) {
		this.folder = folder;
		// file name → { sign, route (the last one that was valid, or null), error }
		this.files = new Map();
		this.manual = new Map();
		this.items = new Map();
		this.index = new Map();
		this.watcher = null;
	}

	load(onError = () => {}) {
		this.scan(onError);
	}

	// Reads the files of the folder that changed. true when the sites are not the same as before.
	scan(onError = () => {}) {
		let list = [];
		try {
			list = Fs.readdirSync(this.folder).filter(name => name.endsWith('.json') && name[0] !== '.').sort();
		} catch (err) {
			if (err.code !== 'ENOENT')
				onError(err, this.folder);
		}

		const files = new Map();
		let changed = false;

		for (const name of list) {
			const filename = Path.join(this.folder, name);
			let info;
			try {
				info = Fs.statSync(filename);
			} catch {
				continue;
			}
			const sign = signature(info);
			let entry = this.files.get(name);
			if (!entry || entry.sign !== sign) {
				changed = true;
				entry = { sign, route: entry ? entry.route : null, error: '' };
				try {
					if (!info.isFile() || info.size > FILE)
						throw fail('A site is a JSON file of at most 2 MB');
					let input;
					try {
						input = JSON.parse(Fs.readFileSync(filename, 'utf8'));
					} catch (err) {
						throw fail('Not valid JSON: ' + err.message);
					}
					if (!input || typeof input !== 'object' || Array.isArray(input))
						throw fail('The site must be a JSON object');
					entry.route = validate(Object.assign({}, input, { id: name.substring(0, name.length - 5) }));
				} catch (err) {
					entry.error = err.message;
					onError(err, filename);
				}
			}
			files.set(name, entry);
		}

		if (files.size !== this.files.size)
			changed = true;
		this.files = files;
		if (!changed)
			return false;

		// A host name belongs to one site. When two files have it, in this order: a site written by hand before one that
		// a container wrote (lib/docker.js), the site that has the name now before a new one, then the first file by name.
		// So a container that says the name of another site never takes it, also after the proxy starts again.
		const rank = entry => (entry.route.docker ? 2 : 0) + (this.manual.has(entry.route.id) ? 0 : 1);
		const order = [...files].filter(item => item[1].route).sort((a, b) => rank(a[1]) - rank(b[1]));
		// The first name of a site is its own: no other site gets it as one more of its names
		const first = new Map();
		for (const [, entry] of order) {
			const host = names(entry.route)[0];
			first.has(host) || first.set(host, entry.route.id);
		}
		const items = new Map();
		const owners = new Map();
		for (const [name, entry] of order) {
			const route = entry.route;
			const filename = Path.join(this.folder, name);
			const taken = names(route).find(host => owners.has(host) || (first.has(host) && first.get(host) !== route.id));
			if (taken) {
				onError(fail(taken + ' already belongs to the site ' + (owners.get(taken) || first.get(taken))), filename);
				continue;
			}
			// A container gets no name under the wildcard of another site: "*.example.com" stays whole
			const under = route.docker && route.hosts.find(host => owners.has(Hosts.wildcard(host)));
			if (under) {
				onError(fail(under + ' is under ' + Hosts.wildcard(under) + ' of the site ' + owners.get(Hosts.wildcard(under))), filename);
				continue;
			}
			for (const host of names(route))
				owners.set(host, route.id);
			items.set(route.id, route);
		}
		this.manual = items;
		this.rebuild(items);
		return true;
	}

	// In a worker: the sites as the primary has them
	assign(list) {
		const items = new Map();
		for (const item of list)
			items.set(item.id, validate(item));
		this.rebuild(items);
	}

	// Looks at the folder every "interval" milliseconds
	watch(onChange, onError, interval) {
		if (this.watcher)
			return;
		const timer = setInterval(() => {
			let changed = false;
			try {
				changed = this.scan(onError);
			} catch (err) {
				onError(err, this.folder);
			}
			if (changed && this.watcher === timer)
				onChange();
		}, interval || 2000);
		this.watcher = timer.unref();
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
			// cert: how this name is served (its own scheme, else the one of the site)
			for (const host of route.hosts)
				index.set(host, { route, redirect: false, cert: mode(route, host) });
			for (const host of route.redirects)
				index.set(host, { route, redirect: true, cert: mode(route, host) });
			for (const item of route.forwards || [])
				index.set(item.host, { route, forward: item, cert: route.cert });
		}
		this.items = items;
		this.index = index;
	}

	list() {
		return [...this.items.values()].map(clean);
	}

	// { route, redirect } for a host name, or null. A wildcard matches one label only.
	lookup(host) {
		return this.index.get(host) || this.index.get(Hosts.wildcard(host)) || null;
	}

	// By default, return hosts that can request a Let's Encrypt certificate.
	tlshosts(wanted = 'auto') {
		const output = [];
		for (const route of this.items.values()) {
			for (const host of names(route)) {
				if (mode(route, host) === wanted)
					output.push({ host, route });
			}
		}
		return output;
	}
}

Routes.validate = validate;
Routes.clean = clean;
Routes.mode = mode;
Routes.addresses = addresses;
Routes.blocklist = blocklist;
Routes.forwardto = forwardto;

module.exports = Routes;
