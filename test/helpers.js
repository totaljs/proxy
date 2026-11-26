'use strict';

const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');
const Http = require('node:http');
const Https = require('node:https');
const Child = require('node:child_process');
const Config = require('../lib/config');
const ProxyServer = require('../lib/server');

exports.tmpdir = function() {
	return Fs.mkdtempSync(Path.join(Os.tmpdir(), 'totaljs-proxy-'));
};

// A self-signed certificate made with OpenSSL, for the tests only
exports.selfsigned = function(folder, name, hosts) {
	Fs.mkdirSync(folder, { recursive: true });
	const key = Path.join(folder, name + '.key');
	const crt = Path.join(folder, name + '.crt');
	Child.execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', key, '-out', crt, '-days', '30', '-subj', '/CN=' + hosts[0], '-addext', 'subjectAltName=' + hosts.map(host => 'DNS:' + host).join(',')], { stdio: 'ignore' });
	return { key: Fs.readFileSync(key), cert: Fs.readFileSync(crt) };
};

// Writes the sites of a test as Proxy reads them: data/sites/<id>.json
exports.sites = function(data, routes) {
	const folder = Path.join(data, 'sites');
	Fs.mkdirSync(folder, { recursive: true });
	for (const route of routes) {
		const site = Object.assign({}, route);
		delete site.id;
		Fs.writeFileSync(Path.join(folder, route.id + '.json'), JSON.stringify(site));
	}
};

exports.config = function(overrides) {
	const data = (overrides && overrides.data) || exports.tmpdir();
	return Config.load(null, Object.assign({ http: 0, https: 0, data, acme: 'https://127.0.0.1:9/directory', precheck: false, logs: Path.join(data, 'logs'), docker: '' }, overrides));
};

// Writes (route) or removes (null) the file of a site of a proxy that runs, and has it applied at once
exports.site = function(proxy, id, route) {
	const file = Path.join(proxy.config.sites, id + '.json');
	if (route) {
		const site = Object.assign({}, route);
		delete site.id;
		Fs.mkdirSync(proxy.config.sites, { recursive: true });
		Fs.writeFileSync(file + '.tmp', JSON.stringify(site));
		Fs.renameSync(file + '.tmp', file);
	} else
		Fs.rmSync(file, { force: true });
	proxy.rescan();
};

// What config.json says for every site (ratelimit, deny, headers, hsts, page), applied to a proxy that runs as a
// change of the file is: without a restart. {} is the config the proxy started with.
exports.settings = function(proxy, values) {
	proxy.reconfigure(exports.config(Object.assign({}, proxy.$overrides, { data: proxy.config.data }, values)));
};

// options: of ProxyServer (the folder of the sites is read every 50 ms)
exports.proxy = async function(overrides, routes, options) {
	const config = exports.config(overrides);
	if (routes)
		exports.sites(config.data, routes);
	const proxy = new ProxyServer(config, Object.assign({ log: false, watch: 50, fold: 100 }, options));
	proxy.$overrides = overrides || {};
	await proxy.start();
	return proxy;
};

// A container stand-in: answers with what it received, echoes WebSockets
exports.backend = async function() {
	const server = Http.createServer(function(req, res) {
		const chunks = [];
		req.on('data', chunk => chunks.push(chunk));
		req.on('end', function() {
			const body = JSON.stringify({ method: req.method, url: req.url, headers: req.headers, size: Buffer.concat(chunks).length });
			res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': ['a=1', 'b=2'], 'connection': 'keep-alive' });
			res.end(body);
		});
	});
	server.on('upgrade', function(req, socket) {
		socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Path: ' + req.url + '\r\n\r\n');
		socket.on('data', chunk => socket.write(chunk));
		socket.on('error', () => {});
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	server.port = server.address().port;
	return server;
};

// options: { port, host, path, method, headers, body, secure, servername, ca, socketPath }
exports.request = function(options) {
	return new Promise((resolve, reject) => {
		const lib = options.secure ? Https : Http;
		const headers = Object.assign({}, options.headers);
		if (options.host)
			headers.host = options.host;
		const req = lib.request({ hostname: '127.0.0.1', port: options.port, socketPath: options.socketPath, path: options.path || '/', method: options.method || 'GET', headers, servername: options.servername, ca: options.ca, agent: false }, function(res) {
			const chunks = [];
			res.on('data', chunk => chunks.push(chunk));
			res.on('end', function() {
				const text = Buffer.concat(chunks).toString('utf8');
				let json = null;
				try {
					json = JSON.parse(text);
				} catch {}
				resolve({ status: res.statusCode, headers: res.headers, text, json });
			});
		});
		req.on('error', reject);
		req.end(options.body);
	});
};
