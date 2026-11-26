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
		headers: "X-Content-Type-Options: nosniff | Content-Security-Policy: default-src 'self' https:; frame-ancestors * | Strict-Transport-Security: max-age=31536000; includeSubDomains; preload",
		maxupload: 1,
		errors,
		logs
	}, [
		{ id: 'open', cert: 'off', hosts: ['open.test'], target, headers: { 'X-Frame-Options': 'SAMEORIGIN', 'Content-Security-Policy': "default-src 'self'" } },
		{ id: 'secure', hosts: ['secure.test'], target, cert: 'custom', hsts: true },
		{ id: 'big', cert: 'off', hosts: ['big.test'], target, maxupload: 3 },
		{ id: 'plain', cert: 'off', hosts: ['plain.test'], target, compress: false, logs: false },
		{ id: 'private', cert: 'off', hosts: ['private.test'], target, auth: [{ user: 'ana', hash: Guard.hash('secret pass') }] },
		{ id: 'office', cert: 'off', hosts: ['office.test'], target, allow: ['10.0.0.0/8', '2001:db8::/32'] },
		{ id: 'home', cert: 'off', hosts: ['home.test'], target, allow: ['127.0.0.0/8'], deny: ['127.0.0.1'] },
		{ id: 'down', cert: 'off', hosts: ['down.test'], target: 'http://127.0.0.1:9' }
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
		const nobody = await request({ port: http, host: 'nobody.test' });
		Assert.equal(nobody.status, 404);
		Assert.match(nobody.text, /<h1>Nothing here yet<\/h1>.*No site is published at <b>nobody\.test<\/b>/);
		// In English for everybody, with its picture inside: nothing is asked from another server
		Assert.match((await request({ port: http, host: 'nobody.test', headers: { 'accept-language': 'es-ES,es;q=0.9,en;q=0.8' } })).text, /<h1>Nothing here yet<\/h1>/);
		Assert.match(nobody.text, /<svg viewBox="0 0 300 96"/);
		Assert.doesNotMatch(nobody.text, /(src|href)=|url\(/);
		// Without a host name that could be one, nothing of the request is shown
		const odd = await request({ port: http, host: '<script>alert(1)</script>' });
		Assert.equal(odd.status, 404);
		Assert.match(odd.text, /No site is published at this address\./);
		Assert.doesNotMatch(odd.text, /script>alert/);
		const head = await request({ port: http, host: 'nobody.test', method: 'HEAD' });
		Assert.deepEqual([head.status, head.text], [404, '']);
	});

	await t.test('the log of each site and the errors', async function() {
		await proxy.logs.close();
		const files = Fs.readdirSync(logs).sort();
		// Not "plain" (logs: false); "down" does not answer: its requests are in error.log too
		Assert.ok(files.includes('open.log') && files.includes('private.log') && files.includes('error.log'));
		Assert.equal(files.includes('plain.log'), false);
		const text = Fs.readFileSync(Path.join(logs, 'open.log'), 'utf8');
		Assert.match(text, / 127\.0\.0\.1 open\.test GET "\/big" 200 \d+ /);
		Assert.doesNotMatch(text, / private\.test /);
		Assert.match(Fs.readFileSync(Path.join(logs, 'private.log'), 'utf8'), / private\.test GET "\/" 401 /);
		Assert.match(Fs.readFileSync(Path.join(logs, 'down.log'), 'utf8'), / down\.test GET "\/" 503 /);
		Assert.match(Fs.readFileSync(Path.join(logs, 'error.log'), 'utf8'), /Upstream: down\.test GET "\/" 503 http:\/\/127\.0\.0\.1:9 ECONNREFUSED/);
	});
});

Test('bad options are refused', async function() {
	const Routes = require('../lib/routes');
	const base = { id: 'x', hosts: ['x.test'], target: 'http://x:8000' };
	Assert.throws(() => Routes.validate({ ...base, logs: 'true' }), /logs must be true or false/);
	for (const id of ['../x', 'a/b', '.hidden', ''])
		Assert.throws(() => Routes.validate({ ...base, id }), /Invalid route id/);
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
	Assert.throws(() => Headers.parse({ 'x-test': 'Not valid: 🚀' }, 'headers'), /not valid/);
	Assert.throws(() => Config.load(null, { hsts: 'max-age=60 🚀' }), /hsts/);
	Assert.deepEqual(Config.load(null, { headers: { 'x-test': 'a | b' } }).headers, [['x-test', 'a | b']]);
});


Test('a full log becomes <name>.log.1 and a new one starts', async function(t) {
	const Logs = require('../lib/logs');
	const data = tmpdir();
	t.after(() => Fs.rmSync(data, { recursive: true, force: true }));
	const folder = Path.join(data, 'logs');
	const maxBytes = 320;
	const logs = new Logs(folder, maxBytes / 1024 / 1024);
	logs.prepare();
	Assert.equal(Fs.statSync(folder).isDirectory(), true);

	const req = { method: 'GET', url: '/', headers: { 'user-agent': 'é'.repeat(20) } };
	const res = { statusCode: 200 };
	// A line is about 100 bytes: three in a file, the fourth starts the next one
	for (const site of ['one.test', 'two.test']) {
		for (let i = 0; i < 7; i++)
			logs.access(site, req, 200, '127.0.0.1', site, Date.now());
	}
	logs.error('Config: something\nwent wrong');
	// Names that are not a site never become a path
	logs.write('../outside', 'x\n');
	await logs.close();

	Assert.deepEqual(Fs.readdirSync(folder).sort(), ['error.log', 'one.test.log', 'one.test.log.1', 'two.test.log', 'two.test.log.1']);
	Assert.equal(Fs.existsSync(Path.join(data, 'outside.log')), false);
	for (const site of ['one.test', 'two.test']) {
		const current = Fs.readFileSync(Path.join(folder, site + '.log'), 'utf8');
		const before = Fs.readFileSync(Path.join(folder, site + '.log.1'), 'utf8');
		Assert.ok(Buffer.byteLength(before) <= maxBytes && Buffer.byteLength(current) <= maxBytes);
		// The one before the last full file is gone: 7 lines, 3 + 3 + 1
		Assert.equal(before.split('\n').length - 1, 3);
		Assert.equal(current.split('\n').length - 1, 1);
	}
	Assert.match(Fs.readFileSync(Path.join(folder, 'error.log'), 'utf8'), /^\S+  Config: something \| went wrong\n$/);

	// The limit can change while it runs, and it is read again when the file is opened
	const larger = new Logs(folder, 1);
	for (let i = 0; i < 5; i++)
		larger.access('one.test', req, 200, '127.0.0.1', 'one.test', Date.now());
	await larger.close();
	Assert.equal(Fs.readFileSync(Path.join(folder, 'one.test.log'), 'utf8').split('\n').length - 1, 6);

	// Without a folder nothing is written
	const off = new Logs('', 1);
	off.error('nothing');
	await off.close();
});

Test('each host name is served as it says', async function(t) {
	const server = await backend();
	const target = '127.0.0.1:' + server.address().port;
	const data = tmpdir();
	// A certificate for the name that says https://
	const cert = selfsigned(Path.join(data, 'custom'), 'secure', ['secure.test']);
	const proxy = await start({ data }, [
		{ id: 'secure.test', hosts: ['https://secure.test', 'http://plain.test', 'bare.test', 'https://waiting.test'], target }
	]);
	proxy.manager.stop();
	t.after(async () => {
		await proxy.stop();
		server.close();
	});
	const { http, https } = proxy.ports;

	// https://: HTTP goes to HTTPS, and HTTPS answers
	const redirected = await request({ port: http, host: 'secure.test', path: '/a?b=1' });
	Assert.equal(redirected.status, 301);
	Assert.equal(redirected.headers.location, 'https://secure.test:' + https + '/a?b=1');
	Assert.equal((await request({ port: https, secure: true, host: 'secure.test', servername: 'secure.test', ca: cert.cert })).status, 200);

	// http:// and a name alone: HTTP, no redirect, and no certificate is offered
	for (const host of ['plain.test', 'bare.test']) {
		Assert.equal((await request({ port: http, host })).status, 200);
		await Assert.rejects(request({ port: https, secure: true, host, servername: host, ca: cert.cert }));
	}

	// https:// without its certificate yet: not served over HTTP in the meantime
	Assert.equal((await request({ port: http, host: 'waiting.test' })).status, 503);
	Assert.deepEqual(proxy.routes.tlshosts().map(item => item.host), ['secure.test', 'waiting.test']);
});
