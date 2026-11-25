'use strict';

// What nginx-proxy did and the proxy now does too: headers for every site and for one, full HSTS, the default upload
// limit, compression, a user and password per site, allowed and blocked addresses, own error pages, the access log.

const Test = require('node:test');
const Assert = require('node:assert/strict');
const Fs = require('node:fs');
const Path = require('node:path');
const Http = require('node:http');
const Net = require('node:net');
const Zlib = require('node:zlib');
const Config = require('../lib/config');
const Guard = require('../lib/guard');
const { proxy: start, request, selfsigned, tmpdir } = require('./helpers');

const BIG = '<p>' + 'The proxy compresses text. '.repeat(200) + '</p>';

// A container that answers what each test needs
async function backend() {
	const server = Http.createServer(function(req, res) {
		req.resume();
		req.on('end', function() {
			switch (req.url) {
				case '/big':
					res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(BIG) });
					return res.end(BIG);
				case '/own':
					res.writeHead(200, { 'content-type': 'text/plain', 'content-security-policy': "default-src 'none'", 'x-frame-options': 'DENY' });
					return res.end('own');
				case '/zipped':
					res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
					return res.end(Zlib.gzipSync(BIG));
				case '/image':
					res.writeHead(200, { 'content-type': 'image/png' });
					return res.end(Buffer.alloc(4096));
				default:
					res.writeHead(200, { 'content-type': 'text/plain', 'content-length': 2 });
					res.end('ok');
			}
		});
	});
	server.on('upgrade', function(req, socket) {
		socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	return server;
}

function upgrade(port, host, headers) {
	return new Promise(function(resolve, reject) {
		const socket = Net.connect(port, '127.0.0.1', function() {
			let text = 'GET /live HTTP/1.1\r\nHost: ' + host + '\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n';
			for (const key in headers || {})
				text += key + ': ' + headers[key] + '\r\n';
			socket.write(text + '\r\n');
		});
		socket.once('data', chunk => {
			resolve(+chunk.toString().split(' ')[1]);
			socket.destroy();
		});
		socket.on('error', reject);
	});
}

Test('the options of nginx-proxy', async function(t) {

	const server = await backend();
	const target = 'http://127.0.0.1:' + server.address().port;
	const data = tmpdir();
	const cert = selfsigned(Path.join(data, 'custom'), 'secure', ['secure.test']);
	const errors = Path.join(data, 'errors');
	const logs = Path.join(data, 'logs');
	Fs.mkdirSync(errors);
	Fs.writeFileSync(Path.join(errors, '502.html'), '<h1>We are back soon</h1>');

	const proxy = await start({
		data,
		headers: Config.parse("headers : X-Content-Type-Options: nosniff | Content-Security-Policy: default-src 'self' https:; frame-ancestors * | Strict-Transport-Security: max-age=31536000; includeSubDomains; preload").headers,
		maxupload: 1,
		errors,
		accesslog: logs
	}, [
		{ id: 'open', tls: 'off', hosts: ['open.test'], target, headers: { 'X-Frame-Options': 'SAMEORIGIN', 'Content-Security-Policy': "default-src 'self'" } },
		{ id: 'secure', hosts: ['secure.test'], target, tls: 'custom', hsts: true },
		{ id: 'big', tls: 'off', hosts: ['big.test'], target, maxupload: 3 },
		{ id: 'plain', tls: 'off', hosts: ['plain.test'], target, compress: false, accesslog: false },
		{ id: 'private', tls: 'off', hosts: ['private.test'], target, auth: [{ user: 'ana', hash: Guard.hash('secret pass') }] },
		{ id: 'office', tls: 'off', hosts: ['office.test'], target, allow: ['10.0.0.0/8', '2001:db8::/32'] },
		{ id: 'home', tls: 'off', hosts: ['home.test'], target, allow: ['127.0.0.0/8'], deny: ['127.0.0.1'] },
		{ id: 'down', tls: 'off', hosts: ['down.test'], target: 'http://127.0.0.1:9' }
	]);

	t.after(async () => {
		await proxy.stop();
		server.close();
	});

	const http = proxy.ports.http;
	const https = proxy.ports.https;

	await t.test('headers of every site and of one site, never over the ones of the app', async function() {
		let res = await request({ port: http, host: 'open.test' });
		Assert.equal(res.headers['x-content-type-options'], 'nosniff');
		Assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
		// The site wins over every site
		Assert.equal(res.headers['content-security-policy'], "default-src 'self'");
		// HSTS only over HTTPS
		Assert.equal(res.headers['strict-transport-security'], undefined);
		res = await request({ port: http, host: 'open.test', path: '/own' });
		Assert.equal(res.headers['content-security-policy'], "default-src 'none'");
		Assert.equal(res.headers['x-frame-options'], 'DENY');
		res = await request({ port: http, host: 'plain.test' });
		Assert.equal(res.headers['content-security-policy'], "default-src 'self' https:; frame-ancestors *");
	});

	await t.test('HSTS over HTTPS with the value of the config', async function() {
		const res = await request({ port: https, host: 'secure.test', secure: true, servername: 'secure.test', ca: cert.cert });
		Assert.equal(res.status, 200);
		Assert.equal(res.headers['strict-transport-security'], 'max-age=31536000; includeSubDomains; preload');
	});

	await t.test('the upload limit of the config, unless the route has its own', async function() {
		const body = Buffer.alloc(2 * 1024 * 1024);
		Assert.equal((await request({ port: http, host: 'open.test', method: 'POST', body })).status, 413);
		Assert.equal((await request({ port: http, host: 'big.test', method: 'POST', body })).status, 200);
	});

	await t.test('text is compressed with brotli or gzip; small, binary and compressed answers are not', async function() {
		let res = await rawget(http, 'open.test', '/big', 'gzip, deflate, br');
		Assert.equal(res.headers['content-encoding'], 'br');
		Assert.equal(Zlib.brotliDecompressSync(res.body).toString(), BIG);
		Assert.match(res.headers.vary, /Accept-Encoding/);
		Assert.equal(res.headers['content-length'], undefined);
		res = await rawget(http, 'open.test', '/big', 'gzip');
		Assert.equal(res.headers['content-encoding'], 'gzip');
		Assert.equal(Zlib.gunzipSync(res.body).toString(), BIG);
		res = await rawget(http, 'open.test', '/big', 'gzip;q=0, identity');
		Assert.equal(res.headers['content-encoding'], undefined);
		Assert.equal((await rawget(http, 'open.test', '/', 'gzip')).headers['content-encoding'], undefined);
		Assert.equal((await rawget(http, 'open.test', '/image', 'gzip')).headers['content-encoding'], undefined);
		res = await rawget(http, 'open.test', '/zipped', 'br, gzip');
		Assert.equal(res.headers['content-encoding'], 'gzip');
		Assert.equal(Zlib.gunzipSync(res.body).toString(), BIG);
		// Turned off for one site
		Assert.equal((await rawget(http, 'plain.test', '/big', 'gzip')).headers['content-encoding'], undefined);
	});

	await t.test('a user and a password for the whole site, WebSockets too', async function() {
		const basic = (user, pass) => 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
		let res = await request({ port: http, host: 'private.test' });
		Assert.equal(res.status, 401);
		Assert.match(res.headers['www-authenticate'], /^Basic realm="private.test"/);
		Assert.equal((await request({ port: http, host: 'private.test', headers: { authorization: basic('ana', 'wrong') } })).status, 401);
		Assert.equal((await request({ port: http, host: 'private.test', headers: { authorization: basic('bob', 'secret pass') } })).status, 401);
		res = await request({ port: http, host: 'private.test', headers: { authorization: basic('ana', 'secret pass') } });
		Assert.equal(res.status, 200);
		// The second time it comes from the memory of right answers
		Assert.equal((await request({ port: http, host: 'private.test', headers: { authorization: basic('ana', 'secret pass') } })).status, 200);
		Assert.equal(await upgrade(http, 'private.test'), 401);
		Assert.equal(await upgrade(http, 'private.test', { authorization: basic('ana', 'secret pass') }), 101);
	});

	await t.test('allowed and blocked addresses', async function() {
		Assert.equal((await request({ port: http, host: 'office.test' })).status, 403);
		Assert.equal((await request({ port: http, host: 'home.test' })).status, 403);
		Assert.equal(await upgrade(http, 'office.test'), 403);
		Assert.equal((await request({ port: http, host: 'open.test' })).status, 200);
		// The address the proxy sees, never a forwarding header
		Assert.equal((await request({ port: http, host: 'office.test', headers: { 'x-forwarded-for': '10.0.0.1' } })).status, 403);
	});

	await t.test('own error pages', async function() {
		// An app that does not answer: 503 with the own page (502.html of before), so search engines come back later
		const res = await request({ port: http, host: 'down.test' });
		Assert.equal(res.status, 503);
		Assert.equal(res.headers['retry-after'], '60');
		Assert.equal(res.text, '<h1>We are back soon</h1>');
		// The ones without a file keep the page of the proxy
		Assert.match((await request({ port: http, host: 'nobody.test' })).text, /No site is published/);
	});

	await t.test('the access log uses a daily file per route', async function() {
		const { once } = require('node:events');
		const written = [...proxy.accesslog.files.values()].map(file => once(file.stream, 'finish'));
		proxy.accesslog.close();
		await Promise.all(written);
		const files = Fs.readdirSync(logs);
		const open = files.find(name => /^access-open-\d{4}-\d{2}-\d{2}\.log$/.test(name));
		const privateLog = files.find(name => /^access-private-\d{4}-\d{2}-\d{2}\.log$/.test(name));
		Assert.ok(open && privateLog);
		const text = Fs.readFileSync(Path.join(logs, open), 'utf8');
		Assert.match(text, / 127\.0\.0\.1 open\.test GET "\/big" 200 \d+ /);
		Assert.doesNotMatch(text, / private\.test /);
		Assert.match(Fs.readFileSync(Path.join(logs, privateLog), 'utf8'), / private\.test GET "\/" 401 /);
		Assert.equal(files.some(name => name.startsWith('access-plain-')), false);
	});
});

Test('bad options are refused', async function() {
	const Routes = require('../lib/routes');
	const base = { id: 'x', hosts: ['x.test'], target: 'http://x:8000' };
	for (const directory of ['/var/log', '../other', 'app/../other', '.'])
		Assert.throws(() => Routes.validate({ ...base, accesslog_dir: directory }), /relative subdirectory/);
	Assert.throws(() => Routes.validate(Object.assign({}, base, { headers: { 'Set-Cookie': 'a=1' } })), /cannot be set/);
	Assert.throws(() => Routes.validate(Object.assign({}, base, { headers: { 'X-A': 'a\r\nb' } })), /not valid/);
	Assert.throws(() => Routes.validate(Object.assign({}, base, { allow: ['10.0.0.0/40'] })), /not an address/);
	Assert.throws(() => Routes.validate(Object.assign({}, base, { deny: ['example.com'] })), /not an address/);
	Assert.throws(() => Routes.validate(Object.assign({}, base, { auth: [{ user: 'a:b', hash: Guard.hash('x') }] })), /scrypt hash/);
	Assert.throws(() => Routes.validate(Object.assign({}, base, { auth: [{ user: 'ana', hash: 'plain' }] })), /scrypt hash/);
	Assert.throws(() => Config.load(null, { data: tmpdir(), headers: 'X-A nosniff' }), /Name: value/);
	Assert.throws(() => Config.load(null, { data: tmpdir(), hsts: 'preload' }), /max-age/);
});

// A GET that keeps the body as bytes (the helper reads text)
function rawget(port, host, path, accept) {
	return new Promise(function(resolve, reject) {
		const req = Http.request({ hostname: '127.0.0.1', port, path, headers: { host, 'accept-encoding': accept }, agent: false }, function(res) {
			const chunks = [];
			res.on('data', chunk => chunks.push(chunk));
			res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
		});
		req.on('error', reject);
		req.end();
	});
}

Test('extra headers are validated before they can be sent', function() {
	const Headers = require('../lib/headers');
	const Settings = require('../lib/settings');
	Assert.throws(() => Headers.parse({ 'x-test': 'Not valid: 🚀' }, 'headers'), /not valid/);
	Assert.throws(() => Config.load(null, { hsts: 'max-age=60 🚀' }), /hsts/);
	Assert.throws(() => Settings.validate({ hsts: 'max-age=60 🚀' }), /hsts/);
	Assert.equal(Settings.validate({ headers: { 'x-test': 'a | b' } }).headers['x-test'], 'a | b');
});


Test('an access log can be limited to opted-in routes', async function(t) {
	const { once } = require('node:events');
	const data = tmpdir();
	const target = 'http://127.0.0.1:9';
	const logs = Path.join(data, 'logs');
	const proxy = await start({ data, accesslog: logs, accesslog_default: false }, [
		{ id: 'audit', hosts: ['audit.test', 'audit-alias.test'], target, tls: 'off', accesslog: true, accesslog_dir: 'apps/audit' },
		{ id: 'quiet', hosts: ['quiet.test'], target, tls: 'off' }
	]);
	t.after(async () => {
		await proxy.stop();
		Fs.rmSync(data, { recursive: true, force: true });
	});
	const port = proxy.ports.http;
	Assert.equal((await request({ port, host: 'quiet.test' })).status, 503);
	Assert.equal(Fs.existsSync(logs), false);
	Assert.equal((await request({ port, host: 'audit.test' })).status, 503);
	Assert.equal((await request({ port, host: 'audit-alias.test' })).status, 503);
	const stream = [...proxy.accesslog.files.values()][0].stream;
	const finished = once(stream, 'finish');
	proxy.accesslog.close();
	await finished;
	const appLogs = Path.join(logs, 'apps', 'audit');
	const [file] = Fs.readdirSync(appLogs);
	Assert.match(file, /^access-audit-/);
	const text = Fs.readFileSync(Path.join(appLogs, file), 'utf8');
	Assert.match(text, / audit-alias\.test GET .* 503 /);
	Assert.match(text, / audit\.test GET .* 503 /);
	Assert.doesNotMatch(text, / quiet\.test /);
});

Test('the daily byte limit applies independently to each route file', async function(t) {
	const AccessLog = require('../lib/accesslog');
	const { once } = require('node:events');
	const data = tmpdir();
	t.after(() => Fs.rmSync(data, { recursive: true, force: true }));
	const maxBytes = 200;
	const logs = new AccessLog(data, 14, maxBytes / 1024 / 1024);
	const req = { method: 'GET', url: '/', headers: { 'user-agent': 'é'.repeat(48) } };
	const res = { statusCode: 200 };
	for (const id of ['one', 'two']) {
		for (let i = 0; i < 3; i++)
			logs.write(req, res, '127.0.0.1', id + '.test', Date.now(), { id });
	}
	const finished = [...logs.files.values()].map(file => once(file.stream, 'finish'));
	logs.close();
	await Promise.all(finished);
	const files = Fs.readdirSync(data);
	Assert.equal(files.length, 2);
	for (const file of files) {
		const contents = Fs.readFileSync(Path.join(data, file));
		Assert.ok(contents.length > 90 && contents.length <= maxBytes);
		Assert.equal((contents.toString().match(/ GET /g) || []).length, 1);
	}
});
