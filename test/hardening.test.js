'use strict';

// What one client must never do to the proxy or to the containers behind it

const Test = require('node:test');
const Assert = require('node:assert/strict');
const Net = require('node:net');
const Http = require('node:http');
const Guard = require('../lib/guard');
const { proxy: start, request } = require('./helpers');

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
	const proxy = await start({}, [
		{ id: 'site', hosts: ['site.test'], target, cert: 'off' },
		{ id: 'private', hosts: ['private.test'], target, cert: 'off', auth: [{ user: 'ana', hash: Guard.hash('right-password') }] }
	]);
	t.after(async () => {
		await proxy.stop();
		backend.close();
	});
	const port = proxy.ports.http;

	await t.test('a client that resets an upgrade being refused does not end the proxy', async function() {
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
		Assert.equal((await request({ port, host: 'site.test' })).status, 200, 'the proxy is still there');
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

	await t.test('the container gets the host the proxy routed by and a plain path', async function() {
		backend.seen.length = 0;
		await raw(port, 'GET http://evil.test/x?y=1 HTTP/1.1\r\nHost: site.test:x@evil.test\r\nConnection: close\r\n\r\n');
		await new Promise(done => setTimeout(done, 300));
		// "site.test:x@evil.test" is not a host of the proxy; a plain one with an absolute address
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
		// A few are checked at once, the rest is told to wait: none gets in
		const statuses = (await Promise.all(wrong)).map(res => res.status);
		Assert.ok(statuses.every(status => status === 401 || status === 429), statuses.join());
		Assert.ok(statuses.includes(401) && statuses.includes(429), statuses.join());
		// The address that was wrong so often waits, also with the right password, until it may try again
		Assert.equal((await request({ port, host: 'private.test', headers: { authorization: 'Basic ' + Buffer.from('ana:right-password').toString('base64') } })).status, 429);
		require('../lib/guard').forget();
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
	const proxy = await start({ http_active: 2, http_active_per_route: 1 }, [
		{ id: 'slow', hosts: ['slow.test'], target, cert: 'off', limit: false },
		{ id: 'ready', hosts: ['ready.test'], target, cert: 'off' }
	]);
	t.after(async () => {
		await proxy.stop();
		backend.closeAllConnections();
		backend.close();
	});
	const port = proxy.ports.http;
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
	Assert.equal(capacity.take('first', first), 0);
	Assert.equal(capacity.take('first', second), 'full');
	Assert.equal(capacity.take('second', second), 0);
	Assert.equal(capacity.take('third', third), 'full');
	first.emit('close');
	Assert.equal(capacity.take('third', third), 0);
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
	const proxy = await start({ upstream_connections: 2, upstream_idle_connections: 2 }, [
		{ id: 'pool', hosts: ['pool.test'], target: 'http://127.0.0.1:' + backend.address().port }
	]);
	t.after(() => proxy.stop());
	const responses = await Promise.all(Array.from({ length: 8 }, () => request({ port: proxy.ports.http, host: 'pool.test' })));
	Assert.ok(responses.every(res => res.status === 200 && res.text === 'ok'));
	Assert.equal(peak, 2);
	Assert.equal(connections, 2);
});

Test('a mistake of the proxy in one request does not end the process', async function(t) {
	const Fs = require('node:fs');
	const Path = require('node:path');
	const Net = require('node:net');
	const { proxy: start, backend: makebackend, request } = require('./helpers');
	const backend = await makebackend();
	const proxy = await start({}, [{ id: 'a', hosts: ['a.test'], target: '127.0.0.1:' + backend.port }]);
	proxy.manager.stop();
	t.after(() => backend.close());

	const lookup = proxy.routes.lookup;
	proxy.routes.lookup = () => {
		throw new Error('a bug in a handler');
	};
	const res = await request({ port: proxy.ports.http, host: 'a.test' });
	Assert.equal(res.status, 500);
	Assert.equal(res.headers.connection, 'close');
	Assert.doesNotMatch(res.text, /a bug in a handler/);
	const upgraded = await new Promise((resolve, reject) => {
		const socket = Net.connect(proxy.ports.http, '127.0.0.1', () => socket.write('GET /live HTTP/1.1\r\nHost: a.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'));
		socket.once('data', chunk => resolve(String(chunk)));
		socket.once('error', reject);
	});
	Assert.match(upgraded, /^HTTP\/1\.1 500/);

	// The next request is served as if nothing happened
	proxy.routes.lookup = lookup;
	Assert.equal((await request({ port: proxy.ports.http, host: 'a.test' })).status, 200);
	await proxy.stop();
	Assert.match(Fs.readFileSync(Path.join(proxy.config.logs, 'error.log'), 'utf8'), /Request: GET "\/" failed: Error: a bug in a handler/);
});

Test('headers made to be slow to read cost nothing', function() {
	const Proxy = require('../lib/proxy');
	const Logs = require('../lib/logs');
	const cases = { 'gzip, deflate, br, zstd': 'br', 'gzip': 'gzip', 'br;q=0, gzip': 'gzip', 'br;q=0.0,gzip;q=0': null, 'GZIP ; q=0.5': 'gzip', 'identity': null, '': null, 'br ;q=1.0': 'br', 'xbr, gzipp': null, 'br;q=abc': null };
	for (const header in cases)
		Assert.equal(Proxy.accepted(header), cases[header], header);
	const started = Date.now();
	for (let i = 0; i < 200; i++) {
		Proxy.accepted('br' + ' '.repeat(15000) + 'x');
		Proxy.accepted('br' + ' '.repeat(400) + 'x');
	}
	Logs.clean('a' + ' '.repeat(200000) + 'b');
	Assert.ok(Date.now() - started < 500);
	Assert.equal(Logs.clean('one\r\n  two\u001b[31m'), 'one |   two?[31m');
	Assert.equal(Logs.clean('x'.repeat(9000)).length, 8001);
});

Test('a request whose client goes away is written as 499, not as an app that failed', async function(t) {
	const Fs = require('node:fs');
	const Path = require('node:path');
	const Net = require('node:net');
	const Http = require('node:http');
	const { proxy: start, request } = require('./helpers');
	// An app that takes its time, and says when a request reached it
	let reached = 0;
	const slow = Http.createServer((req, res) => {
		reached++;
		setTimeout(() => res.end('late'), 300);
	});
	slow.on('upgrade', (req, socket) => socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'));
	await new Promise(resolve => slow.listen(0, '127.0.0.1', resolve));
	const proxy = await start({}, [{ id: 'slow', hosts: ['slow.test'], target: '127.0.0.1:' + slow.address().port }]);
	proxy.manager.stop();
	t.after(() => slow.close());

	await new Promise(resolve => {
		const socket = Net.connect(proxy.ports.http, '127.0.0.1', () => {
			socket.write('POST /order HTTP/1.1\r\nHost: slow.test\r\nContent-Length: 0\r\n\r\n');
			setTimeout(() => socket.destroy(), 100);
		});
		socket.once('close', resolve);
	});
	await new Promise(resolve => setTimeout(resolve, 150));
	Assert.equal(reached, 1);
	Assert.equal((await request({ port: proxy.ports.http, host: 'slow.test', path: '/done' })).text, 'late');
	// A WebSocket that is opened is written too
	await new Promise((resolve, reject) => {
		const socket = Net.connect(proxy.ports.http, '127.0.0.1', () => socket.write('GET /live HTTP/1.1\r\nHost: slow.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'));
		socket.once('data', () => socket.destroy());
		socket.once('close', resolve);
		socket.once('error', reject);
	});

	const total = proxy.stats.get('slow').total;
	Assert.deepEqual([total.requests, total['2xx'], total['4xx'], total.failed, total.websockets], [2, 1, 1, 0, 1]);
	await proxy.stop();
	const log = Fs.readFileSync(Path.join(proxy.config.logs, 'slow.log'), 'utf8');
	Assert.match(log, / 127\.0\.0\.1 slow\.test POST "\/order" 499 /);
	Assert.match(log, / slow\.test GET "\/done" 200 /);
	Assert.match(log, / slow\.test GET "\/live" 101 /);
	Assert.equal(Fs.existsSync(Path.join(proxy.config.logs, 'error.log')), false);
});

Test('a resumed TLS session does not reach a site that has no certificate', async function(t) {
	const Path = require('node:path');
	const Tls = require('node:tls');
	const { proxy: start, backend: makebackend, selfsigned, tmpdir } = require('./helpers');
	const backend = await makebackend();
	const data = tmpdir();
	const cert = selfsigned(Path.join(data, 'certs'), 'secure.test', ['secure.test']);
	const target = '127.0.0.1:' + backend.port;
	const proxy = await start({ data }, [
		{ id: 'secure', hosts: ['https://secure.test'], target, cert: 'custom' },
		{ id: 'plain', hosts: ['plain.test'], target }
	]);
	proxy.manager.stop();
	t.after(async () => {
		await proxy.stop();
		backend.close();
	});
	// One request on a TLS 1.2 connection, with or without the session of the one before
	const ask = (host, session) => new Promise((resolve, reject) => {
		let text = '';
		let reused = false;
		let kept = null;
		const socket = Tls.connect({ port: proxy.ports.https, host: '127.0.0.1', servername: 'secure.test', ca: cert.cert, maxVersion: 'TLSv1.2', session }, () => {
			reused = socket.isSessionReused();
			kept = socket.getSession();
			socket.write('GET / HTTP/1.1\r\nHost: ' + host + '\r\nConnection: close\r\n\r\n');
		});
		socket.on('data', chunk => text += chunk);
		socket.on('error', reject);
		socket.on('close', () => resolve({ status: +text.substring(9, 12), session: kept, reused }));
	});
	const first = await ask('secure.test');
	Assert.equal(first.status, 200);
	Assert.equal((await ask('plain.test')).status, 421);
	const resumed = await ask('plain.test', first.session);
	Assert.equal(resumed.reused, true, 'the test did not resume the session');
	Assert.equal(resumed.status, 421);
	// Its own site is still served on a resumed session
	const again = await ask('secure.test', first.session);
	Assert.deepEqual([again.reused, again.status], [true, 200]);
});

Test('wrong passwords of one address wait longer each time', async function() {
	const Guard = require('../lib/guard');
	Guard.forget();
	const route = { id: 'x', auth: [{ user: 'ana', hash: Guard.hash('right') }], $authkey: 'k' };
	const basic = (user, pass) => 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
	const ip = '203.0.113.7';

	// Five tries are free: a typo, an old password that the browser kept
	for (let i = 0; i < 5; i++)
		Assert.equal(await Guard.authorized(route, basic('ana', 'wrong' + i), ip), false);
	Assert.equal(Guard.waiting(ip), 0);
	// The sixth one starts the wait: 2, 4, 8... seconds, at most 5 minutes
	Assert.equal(await Guard.authorized(route, basic('ana', 'wrong'), ip), false);
	Assert.equal(Guard.waiting(ip), 2);
	// While it waits nothing is checked, not even the right password
	Assert.equal(await Guard.authorized(route, basic('ana', 'right'), ip), 2);
	// Another address is not held by it, and a request without a password is only asked for one
	Assert.equal(await Guard.authorized(route, basic('ana', 'right'), '198.51.100.1'), true);
	Assert.equal(await Guard.authorized(route, '', ip), false);

	const now = Date.now();
	for (let i = 0; i < 20; i++)
		Guard.failed(ip, now);
	Assert.equal(Guard.waiting(ip, now), 300);
	Assert.equal(Guard.waiting(ip, now + 301000), 0);
	// Forgotten after 15 minutes without a try
	Guard.failed(ip, now + 16 * 60000);
	Assert.equal(Guard.waiting(ip, now + 16 * 60000), 0);

	// A right password forgets the wrong ones
	Guard.forget();
	for (let i = 0; i < 4; i++)
		await Guard.authorized(route, basic('ana', 'wrong'), ip);
	Assert.equal(await Guard.authorized(route, basic('ana', 'right'), ip), true);
	for (let i = 0; i < 5; i++)
		await Guard.authorized(route, basic('ana', 'other' + i), ip);
	Assert.equal(Guard.waiting(ip), 0);
	Guard.forget();
});

Test('one address does not hold every slot of a site', async function(t) {
	const Net = require('node:net');
	const Http = require('node:http');
	const Proxy = require('../lib/proxy');
	const { Capacity } = require('../lib/limiter');
	const { proxy: start, request, settings } = require('./helpers');

	const { EventEmitter } = require('node:events');
	const capacity = new Capacity(10, 10, 2);
	const [a, b, c] = [new EventEmitter(), new EventEmitter(), new EventEmitter()];
	Assert.equal(capacity.take('site', a, '203.0.113.7'), 0);
	Assert.equal(capacity.take('site', b, '203.0.113.7'), 0);
	Assert.equal(capacity.take('other', c, '203.0.113.7'), 'address');
	Assert.equal(capacity.take('site', c, '198.51.100.1'), 0);
	a.emit('close');
	Assert.equal(capacity.take('other', a, '203.0.113.7'), 0);
	for (const item of [a, b, c])
		item.emit('close');
	Assert.deepEqual([capacity.active, capacity.routes.size, capacity.addresses.size], [0, 0, 0]);

	// An app that answers when it is told to
	const pending = [];
	const app = Http.createServer((req, res) => {
		req.resume();
		req.url === '/hold' ? pending.push(res) : res.end('ok');
	});
	await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
	const proxy = await start({ http_active_per_ip: 2 }, [{ id: 'app', hosts: ['app.test'], target: '127.0.0.1:' + app.address().port }]);
	proxy.manager.stop();
	const upload = Proxy.limits.upload;
	t.after(async () => {
		Proxy.limits.upload = upload;
		await proxy.stop();
		app.close();
	});
	const port = proxy.ports.http;

	const held = [request({ port, host: 'app.test', path: '/hold' }), request({ port, host: 'app.test', path: '/hold' })];
	await new Promise(resolve => setTimeout(resolve, 100));
	const third = await request({ port, host: 'app.test' });
	Assert.equal(third.status, 429);
	Assert.equal(third.headers['retry-after'], '1');
	pending.forEach(res => res.end('late'));
	await Promise.all(held);
	Assert.equal((await request({ port, host: 'app.test' })).status, 200);
	// The limit changes with the config, while the proxy runs
	settings(proxy, { http_active_per_ip: 1 });
	Assert.equal(proxy.httpCapacity.perAddress, 1);

	// An upload that stops sending is ended with 408, and its slot is free again
	Proxy.limits.upload = 150;
	const answer = await new Promise((resolve, reject) => {
		const socket = Net.connect(port, '127.0.0.1', () => socket.write('POST /hold HTTP/1.1\r\nHost: app.test\r\nContent-Length: 1000\r\n\r\nonly the start'));
		let text = '';
		socket.on('data', chunk => text += chunk);
		socket.on('close', () => resolve(text));
		socket.on('error', reject);
	});
	Assert.match(answer, /^HTTP\/1\.1 408 /);
	Assert.equal(proxy.httpCapacity.active, 0);
	// One that keeps sending is not ended
	const steady = await new Promise((resolve, reject) => {
		const socket = Net.connect(port, '127.0.0.1', () => {
			socket.write('POST /slow HTTP/1.1\r\nHost: app.test\r\nContent-Length: 6\r\nConnection: close\r\n\r\n');
			let sent = 0;
			const timer = setInterval(() => {
				socket.write('x');
				if (++sent === 6)
					clearInterval(timer);
			}, 80);
		});
		let text = '';
		socket.on('data', chunk => text += chunk);
		socket.on('close', () => resolve(text));
		socket.on('error', reject);
	});
	Assert.match(steady, /^HTTP\/1\.1 200 /);
});
