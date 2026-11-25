'use strict';

const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');
const Http = require('node:http');
const Https = require('node:https');
const Child = require('node:child_process');
const Config = require('../lib/config');
const Edge = require('../lib/edge');

exports.tmpdir = function() {
	return Fs.mkdtempSync(Path.join(Os.tmpdir(), 'code-edge-'));
};

// A self-signed certificate made with OpenSSL, for the tests only
exports.selfsigned = function(folder, name, hosts) {
	Fs.mkdirSync(folder, { recursive: true });
	const key = Path.join(folder, name + '.key');
	const crt = Path.join(folder, name + '.crt');
	Child.execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', key, '-out', crt, '-days', '30', '-subj', '/CN=' + hosts[0], '-addext', 'subjectAltName=' + hosts.map(host => 'DNS:' + host).join(',')], { stdio: 'ignore' });
	return { key: Fs.readFileSync(key), cert: Fs.readFileSync(crt) };
};

exports.edge = async function(overrides, routes) {
	const data = (overrides && overrides.data) || exports.tmpdir();
	if (routes)
		Fs.writeFileSync(Path.join(data, 'routes.json'), JSON.stringify(routes));
	const config = Config.load(null, Object.assign({ http: 0, https: 0, data, control: Path.join(data, 'edge.sock'), acme: 'https://127.0.0.1:9/directory', precheck: false }, overrides));
	const edge = new Edge(config, { log: false });
	await edge.start();
	return edge;
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
