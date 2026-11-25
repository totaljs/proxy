'use strict';

// Reads the Proxy config file, in the same "key : value" format as a Total.js config.

const Fs = require('node:fs');
const Path = require('node:path');
const Hosts = require('./hosts');
const Headers = require('./headers');
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
	data: 'data',
	custom_cert_dir: '',
	routes_file: '',
	docker_routes_file: '',
	control: 'control/proxy.sock',
	token: '',
	control_clients_file: '',
	renew_days: 30,
	http_active: 2048,
	upstream_connections: 128,
	upstream_idle_connections: 128,
	http_active_per_route: 256,
	ws_active: 1024,
	ws_active_per_route: 128,
	precheck: true,
	// Every site: extra headers ("Name: value | Name: value"), the value of HSTS, the upload limit in MB of routes
	// without their own, compression, the folder of the error pages, and the access log ("", "stdout" or a folder)
	headers: '',
	hsts: 'max-age=31536000',
	maxupload: 50,
	compress: true,
	errors: 'data/errors',
	eventlog: 'stdout',
	accesslog: '',
	accesslog_default: true,
	accesslog_days: 14,
	accesslog_maxsize: 500,
	// Days the visits of the sites are kept (route option "stats")
	stats_days: 400
};

exports.DEFAULTS = DEFAULTS;

exports.parse = function(text) {
	const output = {};
	for (let line of text.split(/\r?\n/)) {
		line = line.trim();
		if (!line || line.startsWith('//') || line.startsWith('#'))
			continue;
		const index = line.indexOf(':');
		if (index === -1)
			continue;
		output[line.substring(0, index).trim()] = line.substring(index + 1).trim();
	}
	return output;
};

// filename: the config file (optional); overrides: values that win over the file (used by tests)
exports.load = function(filename, overrides) {

	overrides = overrides || {};

	const values = filename ? exports.parse(Fs.readFileSync(filename, 'utf8')) : {};
	const base = filename ? Path.dirname(Path.resolve(filename)) : process.cwd();

	for (const key in values) {
		if (!(key in DEFAULTS))
			throw new Error('Unknown key in the Proxy config: ' + key);
	}

	const config = {};
	const environment = {
		eventlog: process.env.PROXY_EVENTLOG ?? process.env.EDGE_EVENTLOG,
		accesslog: process.env.PROXY_ACCESSLOG ?? process.env.EDGE_ACCESSLOG,
		accesslog_default: process.env.PROXY_ACCESSLOG_DEFAULT ?? process.env.EDGE_ACCESSLOG_DEFAULT
	};

	for (const key in DEFAULTS) {
		let value = key in overrides ? overrides[key] : environment[key] ?? values[key] ?? DEFAULTS[key];
		const type = typeof DEFAULTS[key];
		if (type === 'number' && typeof value === 'string') {
			value = parseInt(value, 10);
			if (isNaN(value))
				throw new Error('The edge config key "' + key + '" needs a number');
		} else if (type === 'boolean' && typeof value === 'string')
			value = value === 'true';
		config[key] = value;
	}

	config.data = Path.resolve(base, config.data);
	config.custom_cert_dir = config.custom_cert_dir ? Path.resolve(base, config.custom_cert_dir) : Path.join(config.data, 'tls');
	config.custom_certs = CertFiles.configured(process.env.PROXY_CUSTOM_CERTS ?? process.env.EDGE_CUSTOM_CERTS);
	if (config.routes_file)
		config.routes_file = Path.resolve(base, config.routes_file);
	if (config.docker_routes_file) {
		config.docker_routes_file = Path.resolve(base, config.docker_routes_file);
		if (!config.routes_file || config.docker_routes_file === config.routes_file)
			throw new Error('docker_routes_file requires a separate manual routes_file');
	}

	if (config.control_clients_file)
		config.control_clients_file = Path.resolve(base, config.control_clients_file);

	if (config.acme_ca)
		config.acme_ca = Path.resolve(base, config.acme_ca);

	if (config.control && /[/\\]|\.sock$/.test(config.control))
		config.control = Path.resolve(base, config.control);

	for (const key of ['http_active', 'http_active_per_route', 'ws_active', 'ws_active_per_route', 'upstream_connections', 'upstream_idle_connections']) {
		if (!Number.isInteger(config[key]) || config[key] < 1 || config[key] > 65536)
			throw new Error(key + ' must be a whole number between 1 and 65536');
	}
	if (config.http_active_per_route > config.http_active || config.ws_active_per_route > config.ws_active)
		throw new Error('Per-route limits cannot exceed the corresponding global limits');

	config.headers = Headers.parse(config.headers, 'headers in the Proxy config');

	if (!config.hsts || !Headers.validvalue('strict-transport-security', config.hsts) || !/max-age=\d+/.test(config.hsts))
		throw new Error('hsts in the Proxy config needs max-age=<seconds>');

	if (!(config.maxupload >= 1 && config.maxupload <= 10240))
		throw new Error('maxupload in the Proxy config must be between 1 and 10240 MB');

	config.errors = config.errors ? Path.resolve(base, config.errors) : '';

	if (config.eventlog && config.eventlog !== 'stdout' && config.eventlog !== 'off')
		config.eventlog = Path.resolve(base, config.eventlog);

	if (config.accesslog && config.accesslog !== 'stdout')
		config.accesslog = Path.resolve(base, config.accesslog);

	config.dns_zone = Hosts.normalize(config.dns_zone);
	config.dns_ns = Hosts.normalize(config.dns_ns);

	if (config.dns_zone && !Hosts.valid(config.dns_zone, false))
		throw new Error('Invalid dns_zone in the Proxy config');

	if (config.dns_ns && !Hosts.valid(config.dns_ns, false))
		throw new Error('Invalid dns_ns in the Proxy config');

	return config;
};
