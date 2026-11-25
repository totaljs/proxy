'use strict';

// What one client must never do to the edge or to the containers behind it

const Test = require('node:test');
const Assert = require('node:assert/strict');
const Net = require('node:net');
const Http = require('node:http');
const Guard = require('../lib/guard');
const { edge: start, request } = require('./helpers');

// A container that counts the requests it gets
async function counter() {
	const seen = [];
	const server = Http.createServer(function(req, res) {
		const chunks = [];
		req.on('data', chunk => chunks.push(chunk));
		req.on('end', function() {
			seen.push({ method: req.method, url: req.url, host: req.headers.host, xff: req.headers['x-forwarded-for'], body: Buffer.concat(chunks).toString() });
			res.end('ok');
		});
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	server.seen = seen;
	return server;
}

function raw(port, text) {
	return new Promise(function(resolve) {
		const socket = Net.connect(port, '127.0.0.1', () => socket.write(text));
		let output = '';
		socket.on('data', chunk => output += chunk);
		socket.on('error', () => resolve(output));
		socket.on('close', () => resolve(output));
		setTimeout(() => socket.destroy(), 1500);
	});
}

Test('hardening', async function(t) {

	const backend = await counter();
	const target = 'http://127.0.0.1:' + backend.address().port;
	const edge = await start({}, [
		{ id: 'site', hosts: ['site.test'], target, tls: 'off' },
		{ id: 'private', hosts: ['private.test'], target, tls: 'off', auth: [{ user: 'ana', hash: Guard.hash('right-password') }] }
	]);
	t.after(async () => {
		await edge.stop();
		backend.close();
	});
	const port = edge.ports.http;

	await t.test('a client that resets an upgrade being refused does not end the edge', async function() {
		const attempts = [];
		for (let i = 0; i < 200; i++) {
			attempts.push(new Promise(function(resolve) {
				const socket = Net.connect(port, '127.0.0.1', function() {
					socket.write('GET / HTTP/1.1\r\nHost: nobody.invalid\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
					socket.resetAndDestroy();
					resolve();
				});
				socket.on('error', resolve);
			}));
		}
		await Promise.all(attempts);
		await new Promise(done => setTimeout(done, 300));
		Assert.equal((await request({ port, host: 'site.test' })).status, 200, 'the edge is still there');
	});

	await t.test('a chunked body is never read by the container as another request', async function() {
		backend.seen.length = 0;
		const smuggled = 'GET /smuggled HTTP/1.1\r\nHost: site.test\r\nX-Forwarded-For: 6.6.6.6\r\n\r\n';
		await raw(port, 'GET / HTTP/1.1\r\nHost: site.test\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n' + smuggled.length.toString(16) + '\r\n' + smuggled + '\r\n0\r\n\r\n');
		await new Promise(done => setTimeout(done, 300));
		Assert.ok(!backend.seen.some(item => item.url === '/smuggled'), JSON.stringify(backend.seen));
		Assert.equal(backend.seen.length, 1);
		Assert.equal(backend.seen[0].body, smuggled, 'the body arrives as a body');
		Assert.equal(backend.seen[0].xff, '127.0.0.1');
	});

	await t.test('the container gets the host the edge routed by and a plain path', async function() {
		backend.seen.length = 0;
		await raw(port, 'GET http://evil.test/x?y=1 HTTP/1.1\r\nHost: site.test:x@evil.test\r\nConnection: close\r\n\r\n');
		await new Promise(done => setTimeout(done, 300));
		// "site.test:x@evil.test" is not a host of the edge; a plain one with an absolute address
		await raw(port, 'GET http://evil.test/x?y=1 HTTP/1.1\r\nHost: site.test\r\nConnection: close\r\n\r\n');
		await new Promise(done => setTimeout(done, 300));
		Assert.ok(backend.seen.every(item => !item.host.includes('evil')), JSON.stringify(backend.seen));
		const plain = backend.seen.find(item => item.url === '/x?y=1');
		Assert.ok(plain, JSON.stringify(backend.seen));
		Assert.equal(plain.host, 'site.test:' + port);
	});

	await t.test('wrong passwords do not stop the other sites', async function() {
		const header = user => 'Basic ' + Buffer.from(user + ':wrong-' + Math.random()).toString('base64');
		const wrong = [];
		for (let i = 0; i < 40; i++)
			wrong.push(request({ port, host: 'private.test', headers: { authorization: header(i % 2 ? 'ana' : 'nobody') } }));
		const started = Date.now();
		const other = await request({ port, host: 'site.test' });
		const took = Date.now() - started;
		Assert.equal(other.status, 200);
		Assert.ok(took < 400, 'another site answered in ' + took + ' ms');
		for (const res of await Promise.all(wrong))
			Assert.equal(res.status, 401);
		const right = await request({ port, host: 'private.test', headers: { authorization: 'Basic ' + Buffer.from('ana:right-password').toString('base64') } });
		Assert.equal(right.status, 200);
	});

	await t.test('a WebSocket client that goes before the container answers leaves nothing open', async function() {
		const before = (await new Promise(resolve => backend.getConnections((err, count) => resolve(count))));
		for (let i = 0; i < 20; i++) {
			const socket = Net.connect(port, '127.0.0.1', function() {
				socket.end('GET /ws HTTP/1.1\r\nHost: site.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
			});
			socket.on('error', () => {});
		}
		await new Promise(done => setTimeout(done, 800));
		const after = (await new Promise(resolve => backend.getConnections((err, count) => resolve(count))));
		Assert.ok(after <= before + 1, before + ' → ' + after);
	});
});

Test('a slow route cannot fill the concurrent HTTP budget of another route', async function(t) {
	let admit;
	const reached = new Promise(resolve => admit = resolve);
	let held;
	const backend = Http.createServer((req, res) => {
		if (req.url === '/hold') {
			held = res;
			admit();
		} else
			res.end('ready');
	});
	await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
	const target = 'http://127.0.0.1:' + backend.address().port;
	const edge = await start({ http_active: 2, http_active_per_route: 1 }, [
		{ id: 'slow', hosts: ['slow.test'], target, tls: 'off', limit: false },
		{ id: 'ready', hosts: ['ready.test'], target, tls: 'off' }
	]);
	t.after(async () => {
		await edge.stop();
		backend.closeAllConnections();
		backend.close();
	});
	const port = edge.ports.http;
	const pending = request({ port, host: 'slow.test', path: '/hold' });
	await reached;
	const overloaded = await request({ port, host: 'slow.test' });
	Assert.equal(overloaded.status, 503);
	Assert.equal(overloaded.headers['retry-after'], '1');
	Assert.equal((await request({ port, host: 'ready.test' })).status, 200);
	held.end('done');
	Assert.equal((await pending).status, 200);
	Assert.equal((await request({ port, host: 'slow.test' })).status, 200);
});

Test('the WebSocket budget is released after the connection closes', function() {
	const { EventEmitter } = require('node:events');
	const { Capacity } = require('../lib/limiter');
	const capacity = new Capacity(2, 1);
	const first = new EventEmitter();
	const second = new EventEmitter();
	const third = new EventEmitter();
	Assert.equal(capacity.take('first', first), true);
	Assert.equal(capacity.take('first', second), false);
	Assert.equal(capacity.take('second', second), true);
	Assert.equal(capacity.take('third', third), false);
	first.emit('close');
	Assert.equal(capacity.take('third', third), true);
	second.emit('close');
	third.emit('close');
	Assert.equal(capacity.routes.size, 0);
});

Test('the upstream pool queues requests and reuses a bounded number of connections', async function(t) {
	let active = 0;
	let peak = 0;
	let connections = 0;
	const backend = Http.createServer((req, res) => {
		peak = Math.max(peak, ++active);
		setTimeout(() => {
			active--;
			res.end('ok');
		}, 25);
	});
	backend.on('connection', () => connections++);
	await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
	t.after(() => backend.close());
	const edge = await start({ upstream_connections: 2, upstream_idle_connections: 2 }, [
		{ id: 'pool', hosts: ['pool.test'], target: 'http://127.0.0.1:' + backend.address().port }
	]);
	t.after(() => edge.stop());
	const responses = await Promise.all(Array.from({ length: 8 }, () => request({ port: edge.ports.http, host: 'pool.test' })));
	Assert.ok(responses.every(res => res.status === 200 && res.text === 'ok'));
	Assert.equal(peak, 2);
	Assert.equal(connections, 2);
});
