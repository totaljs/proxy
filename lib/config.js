'use strict';

// Reads the config of Proxy: the JSON object in <data>/config.json. Every key is optional; a file that is not there
// is the same as "{}". The file is watched (lib/runner.js): a change is applied by itself, a mistake keeps what runs.

const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');
const Hosts = require('./hosts');
const Headers = require('./headers');
const Routes = require('./routes');
const CertFiles = require('./cert-files');

const DEFAULTS = {
	email: '',
	acme: 'https://acme-v02.api.letsencrypt.org/directory',
	acme_ca: '',
	http: 80,
	https: 443,
	dns: 0,
	dns_zone: '',
	dns_ns: '',
	custom_cert_dir: '',
	// Docker discovery (lib/docker.js): the socket of Docker, or http://host:port of a socket proxy (empty: off), and
	// the network whose containers publish themselves
	docker: '/var/run/docker.sock',
	docker_network: 'proxy',
	renew_days: 30,
	// Processes that serve HTTP, HTTPS and WebSockets: 1 is one process for everything, 0 is one for each CPU core
	workers: 1,
	http_active: 2048,
	upstream_connections: 128,
	upstream_idle_connections: 128,
	http_active_per_route: 256,
	ws_active: 1024,
	ws_active_per_route: 128,
	// Of one address at once: it never holds every slot of a site
	http_active_per_ip: 64,
	ws_active_per_ip: 32,
	precheck: true,
	// Every site: extra headers ({ "Name": "value" } or "Name: value | Name: value"), the value of HSTS, the upload
	// limit in MB of sites without their own, compression and the folder of the error pages (empty: <data>/errors)
	headers: '',
	hsts: 'max-age=31536000',
	maxupload: 50,
	compress: true,
	errors: '',
	// Every site: the requests a second that one address may send (0: no limit; four times as many may come at once,
	// so a page with its images, styles and scripts fits), the addresses and networks that reach no site, and the HTML
	// of the page of a site whose app does not answer and has no page of its own
	ratelimit: 0,
	deny: [],
	page: '',
	// The folder of the logs (one file for each site and error.log; empty: no files) and the largest size of one file
	// in MB: a full file becomes <name>.log.1 and a new one starts
	logs: 'logs',
	logs_maxsize: 100,
	// Days the request counters of the sites are kept (data/stats)
	stats_days: 400
};

// Applied while Proxy runs. A change of any other key starts Proxy again with the new config.
const LIVE = new Set(['renew_days', 'precheck', 'headers', 'hsts', 'maxupload', 'compress', 'errors', 'ratelimit', 'deny', 'page', 'logs_maxsize', 'stats_days', 'http_active', 'http_active_per_route', 'http_active_per_ip', 'ws_active', 'ws_active_per_route', 'ws_active_per_ip', 'upstream_connections', 'upstream_idle_connections']);

exports.DEFAULTS = DEFAULTS;
exports.LIVE = LIVE;

exports.filename = function(data) {
	return Path.join(data, 'config.json');
};

// The text of the config file ('' when it is not there)
exports.read = function(data) {
	try {
		return Fs.readFileSync(exports.filename(data), 'utf8');
	} catch (err) {
		if (err.code === 'ENOENT')
			return '';
		throw err;
	}
};

function typed(key, value) {
	const type = typeof DEFAULTS[key];
	if (key === 'headers' && value && typeof value === 'object')
		return value;
	// Checked as a whole below
	if (key === 'deny')
		return value;
	// The form of before, { "rate": 100, "burst": 400 }: said, not taken for something else
	if (key === 'ratelimit' && value && typeof value === 'object')
		throw new Error('ratelimit in config.json is now one number: the requests a second of each address');
	if (type === 'number') {
		if (typeof value === 'string' && value.trim() !== '')
			value = Number(value);
		if (typeof value !== 'number' || !Number.isFinite(value))
			throw new Error('The config key "' + key + '" needs a number');
		return value;
	}
	if (type === 'boolean') {
		if (value === 'true' || value === 'false')
			return value === 'true';
		if (typeof value !== 'boolean')
			throw new Error('The config key "' + key + '" needs true or false');
		return value;
	}
	if (value == null)
		return '';
	if (typeof value !== 'string' && typeof value !== 'number')
		throw new Error('The config key "' + key + '" needs a text');
	return String(value);
}

// data: the data folder with config.json (null: no file, for tests); overrides: values that win over the file
exports.load = function(data, overrides) {

	overrides = overrides || {};

	let values = {};
	if (data) {
		const text = exports.read(data);
		if (text.trim()) {
			try {
				values = JSON.parse(text);
			} catch (err) {
				throw new Error('config.json is not valid JSON: ' + err.message);
			}
			if (!values || typeof values !== 'object' || Array.isArray(values))
				throw new Error('config.json must be a JSON object');
		}
	}

	for (const key in values) {
		if (!(key in DEFAULTS))
			throw new Error('Unknown key in config.json: ' + key);
	}

	const config = {};
	const environment = {
		workers: process.env.PROXY_WORKERS || undefined
	};

	for (const key in DEFAULTS)
		config[key] = typed(key, key in overrides ? overrides[key] : environment[key] ?? values[key] ?? DEFAULTS[key]);

	// Paths in the config start at the folder that holds the data folder
	config.data = Path.resolve(overrides.data || data || 'data');
	const base = Path.dirname(config.data);

	config.sites = Path.join(config.data, 'sites');
	config.custom_cert_dir = config.custom_cert_dir ? Path.resolve(base, config.custom_cert_dir) : Path.join(config.data, 'tls');
	config.custom_certs = CertFiles.configured(process.env.PROXY_CUSTOM_CERTS);

	if (config.docker && !/^https?:\/\//i.test(config.docker))
		config.docker = Path.resolve(base, config.docker);
	if (config.docker && !/^[a-z0-9][a-z0-9_.-]{0,127}$/i.test(config.docker_network))
		throw new Error('docker_network in config.json must be the name of a Docker network');

	if (config.acme_ca)
		config.acme_ca = Path.resolve(base, config.acme_ca);

	for (const key of ['http', 'https', 'dns']) {
		if (!Number.isInteger(config[key]) || config[key] < 0 || config[key] > 65535)
			throw new Error(key + ' must be a port number');
	}

	for (const key of ['http_active', 'http_active_per_route', 'http_active_per_ip', 'ws_active', 'ws_active_per_route', 'ws_active_per_ip', 'upstream_connections', 'upstream_idle_connections']) {
		if (!Number.isInteger(config[key]) || config[key] < 1 || config[key] > 65536)
			throw new Error(key + ' must be a whole number between 1 and 65536');
	}

	if (!Number.isInteger(config.workers) || config.workers < 0 || config.workers > 64)
		throw new Error('workers must be a whole number between 0 and 64');
	if (!config.workers)
		config.workers = Math.min(Os.availableParallelism(), 64);

	if (config.http_active_per_route > config.http_active || config.ws_active_per_route > config.ws_active)
		throw new Error('Per-route limits cannot exceed the corresponding global limits');

	config.headers = Headers.parse(config.headers, 'headers in config.json');

	if (!config.hsts || !Headers.validvalue('strict-transport-security', config.hsts) || !/max-age=\d+/.test(config.hsts))
		throw new Error('hsts in config.json needs max-age=<seconds>');

	if (!(config.maxupload >= 1 && config.maxupload <= 10240))
		throw new Error('maxupload in config.json must be between 1 and 10240 MB');

	if (!(config.renew_days >= 1 && config.renew_days <= 365))
		throw new Error('renew_days in config.json must be between 1 and 365');

	if (!(config.stats_days >= 1))
		throw new Error('stats_days in config.json must be at least 1');

	if (!(config.logs_maxsize > 0 && config.logs_maxsize <= 10240))
		throw new Error('logs_maxsize in config.json must be between 1 and 10240 MB');

	if (!Number.isInteger(config.ratelimit) || config.ratelimit < 0 || config.ratelimit > 100000)
		throw new Error('ratelimit in config.json must be a whole number of requests a second, or 0 for no limit');

	try {
		config.deny = Routes.addresses(config.deny, 'deny');
	} catch (err) {
		throw new Error(err.message.replace(/^deny/, 'deny in config.json'));
	}

	if (Buffer.byteLength(config.page) > 512 * 1024)
		throw new Error('page in config.json must be HTML of at most 512 KB');

	config.errors = config.errors ? Path.resolve(base, config.errors) : Path.join(config.data, 'errors');
	config.logs = config.logs ? Path.resolve(base, config.logs) : '';

	config.dns_zone = Hosts.normalize(config.dns_zone);
	config.dns_ns = Hosts.normalize(config.dns_ns);

	if (config.dns_zone && !Hosts.valid(config.dns_zone, false))
		throw new Error('Invalid dns_zone in config.json');

	if (config.dns_ns && !Hosts.valid(config.dns_ns, false))
		throw new Error('Invalid dns_ns in config.json');

	return config;
};

// The keys with another value in two loaded configs
exports.changed = function(a, b) {
	return Object.keys(DEFAULTS).filter(key => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
};
