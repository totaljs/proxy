'use strict';

const Test = require('node:test');
const Assert = require('node:assert/strict');
const Net = require('node:net');
const Tls = require('node:tls');
const Path = require('node:path');
const { proxy: start, backend: makebackend, request, selfsigned, tmpdir } = require('./helpers');

Test('proxy', async function(t) {

	const backend = await makebackend();
	const target = 'http://127.0.0.1:' + backend.port;

	const data = tmpdir();
	const cert = selfsigned(Path.join(data, 'custom'), 'secure', ['secure.test', 'www.secure.test']);

	const proxy = await start({ data }, [
		{ id: 'shop', hosts: ['shop.test', '*.apps.test'], redirects: ['www.shop.test'], target, maxupload: 1 },
		{ id: 'secure', hosts: ['secure.test'], redirects: ['www.secure.test'], target, tls: 'custom', hsts: true },
		{ id: 'down', hosts: ['down.test'], target: 'http://127.0.0.1:9', tls: 'off' },
		{ id: 'pending', hosts: ['pending.test'], target, tls: 'auto' }
	]);

	t.after(async () => {
		await proxy.stop();
		backend.close();
	});

	const http = proxy.ports.http;
	const https = proxy.ports.https;

	await t.test('forwards a request with fresh forwarding headers', async function() {
		const res = await request({ port: http, host: 'Shop.test', path: '/api/list?page=2', headers: { 'x-forwarded-for': '6.6.6.6', 'x-real-ip': '6.6.6.6', 'forwarded': 'for=6.6.6.6' } });
		Assert.equal(res.status, 200);
		Assert.equal(res.json.url, '/api/list?page=2');
		// The host the proxy routed by, as the proxy knows it
		Assert.equal(res.json.headers.host, 'shop.test:' + http);
		Assert.equal(res.json.headers['x-forwarded-for'], '127.0.0.1');
		Assert.equal(res.json.headers['x-real-ip'], '127.0.0.1');
		Assert.equal(res.json.headers['x-forwarded-proto'], 'http');
		Assert.equal(res.json.headers['x-forwarded-host'], 'shop.test');
		Assert.equal(res.json.headers.forwarded, undefined);
		Assert.deepEqual(res.headers['set-cookie'], ['a=1', 'b=2']);
		Assert.equal(res.headers['strict-transport-security'], undefined);
	});

	await t.test('wildcard hosts match one label', async function() {
		Assert.equal((await request({ port: http, host: 'ana.apps.test' })).status, 200);
		Assert.equal((await request({ port: http, host: 'a.ana.apps.test' })).status, 404);
	});

	await t.test('unknown hosts and bad Host headers get 404', async function() {
		Assert.equal((await request({ port: http, host: 'nobody.test' })).status, 404);
		Assert.equal((await request({ port: http, host: '127.0.0.1' })).status, 404);
	});

	await t.test('redirect hosts send to the first host', async function() {
		const res = await request({ port: http, host: 'www.shop.test', path: '/a?b=1' });
		Assert.equal(res.status, 301);
		Assert.equal(res.headers.location, 'http://shop.test:' + http + '/a?b=1');
	});

	await t.test('uploads over the limit get 413', async function() {
		const body = Buffer.alloc(2 * 1024 * 1024);
		const res = await request({ port: http, host: 'shop.test', method: 'POST', body, headers: { 'content-length': body.length } });
		Assert.equal(res.status, 413);

		// Without a length, the proxy counts while it forwards
		const chunked = await request({ port: http, host: 'shop.test', method: 'POST', body, headers: { 'transfer-encoding': 'chunked' } });
		Assert.equal(chunked.status, 413);

		const small = await request({ port: http, host: 'shop.test', method: 'POST', body: Buffer.alloc(1000) });
		Assert.equal(small.json.size, 1000);

		// A client that asks first is refused before it sends the body, or let through
		const ask = (size) => new Promise((resolve, reject) => {
			const req = require('node:http').request({ hostname: '127.0.0.1', port: http, method: 'POST', agent: false, headers: { host: 'shop.test', expect: '100-continue', 'content-length': size } });
			let continued = false;
			req.on('continue', () => {
				continued = true;
				req.end(Buffer.alloc(size));
			});
			req.on('response', res => {
				const chunks = [];
				res.on('data', chunk => chunks.push(chunk));
				res.on('end', () => resolve({ status: res.statusCode, continued, text: Buffer.concat(chunks).toString() }));
			});
			req.on('error', reject);
			req.flushHeaders();
		});
		const refused = await ask(2 * 1024 * 1024);
		Assert.equal(refused.status, 413);
		Assert.equal(refused.continued, false);
		const allowed = await ask(500);
		Assert.equal(allowed.status, 200);
		Assert.equal(allowed.continued, true);
		Assert.equal(JSON.parse(allowed.text).size, 500);
	});

	await t.test('a container that does not answer gets the page of the proxy, 503', async function() {
		const res = await request({ port: http, host: 'down.test', headers: { 'accept-language': 'es-ES,es;q=0.9,en;q=0.8' } });
		Assert.equal(res.status, 503);
		Assert.equal(res.headers['retry-after'], '60');
		Assert.match(res.text, /Volvemos enseguida/);
		Assert.match((await request({ port: http, host: 'down.test' })).text, /Back in a moment/);
	});

	await t.test('answers the ACME HTTP check', async function() {
		proxy.challenges.set('token123', 'token123.thumb');
		const res = await request({ port: http, host: 'shop.test', path: '/.well-known/acme-challenge/token123' });
		Assert.equal(res.status, 200);
		Assert.equal(res.text, 'token123.thumb');
		proxy.challenges.delete('token123');
		const gone = await request({ port: http, host: 'shop.test', path: '/.well-known/acme-challenge/token123' });
		Assert.equal(gone.json.url, '/.well-known/acme-challenge/token123');
	});

	await t.test('HTTP goes to HTTPS when the host has a certificate', async function() {
		const res = await request({ port: http, host: 'secure.test', path: '/x' });
		Assert.equal(res.status, 301);
		Assert.equal(res.headers.location, 'https://secure.test:' + https + '/x');

		const redirect = await request({ port: http, host: 'www.secure.test', path: '/y' });
		Assert.equal(redirect.headers.location, 'https://secure.test:' + https + '/y');
	});

	await t.test('HTTPS routes wait for a usable certificate before proxying HTTP', async function() {
		const res = await request({ port: http, host: 'pending.test' });
		Assert.equal(res.status, 503);
		Assert.equal(res.headers['retry-after'], '60');
		Assert.match(res.text, /waiting for its HTTPS certificate/);
		proxy.challenges.set('pending-token', 'test-validation');
		const challenge = await request({ port: http, host: 'pending.test', path: '/.well-known/acme-challenge/pending-token' });
		Assert.equal(challenge.status, 200);
		Assert.equal(challenge.text, 'test-validation');
	});


	await t.test('HTTPS with the certificate of the host', async function() {
		const res = await request({ port: https, secure: true, servername: 'secure.test', ca: cert.cert, host: 'secure.test', path: '/s' });
		Assert.equal(res.status, 200);
		Assert.equal(res.json.headers['x-forwarded-proto'], 'https');
		Assert.equal(res.json.headers['x-forwarded-port'], String(https));
		Assert.equal(res.headers['strict-transport-security'], 'max-age=31536000');
	});

	await t.test('the certificate of one site does not carry requests for another (421)', async function() {
		const res = await request({ port: https, secure: true, servername: 'secure.test', ca: cert.cert, host: 'shop.test', path: '/' });
		Assert.equal(res.status, 421);
		// Its own names, yes
		Assert.equal((await request({ port: https, secure: true, servername: 'secure.test', ca: cert.cert, host: 'secure.test' })).status, 200);
	});

	await t.test('only WebSockets are upgraded', async function() {
		const answer = await new Promise(function(resolve) {
			const socket = Net.connect(http, '127.0.0.1', () => socket.write('GET / HTTP/1.1\r\nHost: shop.test\r\nConnection: Upgrade, HTTP2-Settings\r\nUpgrade: h2c\r\nHTTP2-Settings: AAMAAABkAAQAAP__\r\n\r\n'));
			let text = '';
			socket.on('data', chunk => text += chunk);
			socket.on('close', () => resolve(text));
			socket.on('error', () => resolve(text));
		});
		Assert.match(answer, /^HTTP\/1\.1 400/);
	});

	await t.test('HTTPS without a certificate for the name fails the handshake', async function() {
		await Assert.rejects(request({ port: https, secure: true, servername: 'shop.test', ca: cert.cert, host: 'shop.test' }));
		await Assert.rejects(request({ port: https, secure: true, servername: 'nobody.test', ca: cert.cert, host: 'nobody.test' }));
	});

	await t.test('WebSockets', async function() {
		const output = await new Promise((resolve, reject) => {
			const socket = Net.connect(http, '127.0.0.1', function() {
				socket.write('GET /live?x=1 HTTP/1.1\r\nHost: shop.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
			});
			let text = '';
			let sent = false;
			socket.on('data', chunk => {
				text += chunk.toString();
				if (!sent && text.includes('\r\n\r\n')) {
					sent = true;
					socket.write('ping');
				}
				if (text.endsWith('ping')) {
					socket.end();
					resolve(text);
				}
			});
			socket.on('error', reject);
		});
		Assert.match(output, /^HTTP\/1\.1 101 Switching Protocols/);
		Assert.match(output, /X-Path: \/live\?x=1/);
		Assert.ok(output.endsWith('\r\n\r\nping'));
	});

	await t.test('WebSockets over HTTPS', async function() {
		const output = await new Promise((resolve, reject) => {
			const socket = Tls.connect({ port: https, host: '127.0.0.1', servername: 'secure.test', ca: cert.cert }, function() {
				socket.write('GET /live HTTP/1.1\r\nHost: secure.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
			});
			let text = '';
			let sent = false;
			socket.on('data', chunk => {
				text += chunk.toString();
				if (!sent && text.includes('\r\n\r\n')) {
					sent = true;
					socket.write('pong');
				}
				if (text.endsWith('pong')) {
					socket.end();
					resolve(text);
				}
			});
			socket.on('error', reject);
		});
		Assert.match(output, /^HTTP\/1\.1 101/);
	});
});
