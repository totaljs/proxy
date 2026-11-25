'use strict';

// Names that redirect to any address, the page of a site while its app does not answer or is in maintenance, and the
// shared site settings: addresses denied, the limit of requests of each
// address, the headers and HSTS of every site, the page of every site.

const Test = require('node:test');
const Assert = require('node:assert/strict');
const Net = require('node:net');
const Routes = require('../lib/routes');
const Limiter = require('../lib/limiter');
const Pages = require('../lib/pages');
const { proxy: start, backend: makebackend, request } = require('./helpers');

function upgrade(port, host) {
	return new Promise(function(resolve, reject) {
		const socket = Net.connect(port, '127.0.0.1', () => socket.write('GET /live HTTP/1.1\r\nHost: ' + host + '\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'));
		socket.once('data', chunk => {
			resolve(chunk.toString());
			socket.destroy();
		});
		socket.on('error', reject);
	});
}

Test('routes: names that redirect to any address, and the page of the site', function() {
	const route = Routes.validate({ id: 'old', forwards: [{ host: 'Old.Example.com', to: 'https://new.example.com/es/' }, { host: 'promo.example.com', to: 'https://shop.example.com/offer', path: false, permanent: false }] });
	// Only names that redirect: no container
	Assert.equal(route.target, undefined);
	Assert.deepEqual(route.forwards[0], { host: 'old.example.com', to: 'https://new.example.com/es/', path: true, permanent: true });
	Assert.equal(Routes.forwardto(route.forwards[0], '/blog/post?id=1'), 'https://new.example.com/es/blog/post?id=1');
	Assert.equal(Routes.forwardto(route.forwards[1], '/anything'), 'https://shop.example.com/offer');

	for (const bad of [{ host: 'x.example.com', to: 'ftp://new.example.com' }, { host: 'x.example.com', to: 'https://user:pw@new.example.com' }, { host: 'x.example.com', to: 'https://x.example.com/' }, { host: '*.example.com', to: 'https://new.example.com' }, { host: 'x.example.com', to: 'javascript:alert(1)' }])
		Assert.throws(() => Routes.validate({ id: 'bad', forwards: [bad] }), /forward|Invalid/, JSON.stringify(bad));

	Assert.throws(() => Routes.validate({ id: 'bad', hosts: ['a.example.com'], target: 'http://a:1', forwards: [{ host: 'a.example.com', to: 'https://b.example.com' }] }), /both a host and a redirect/);
	Assert.throws(() => Routes.validate({ id: 'bad', hosts: ['a.example.com'], target: 'http://a:1', page: 'x'.repeat(600 * 1024) }), /512 KB/);
	Assert.throws(() => Routes.validate({ id: 'bad' }), /at least one host/);
	// A route with hosts still needs its container
	Assert.throws(() => Routes.validate({ id: 'bad', hosts: ['a.example.com'] }), /target/);

	// Certificates for the names that redirect too
	const routes = new Routes('/dev/null');
	routes.items.set(route.id, Object.assign(route, { tls: 'auto' }));
	routes.rebuild();
	Assert.deepEqual(routes.tlshosts().map(item => item.host), ['old.example.com', 'promo.example.com']);
	Assert.equal(routes.lookup('old.example.com').forward.to, 'https://new.example.com/es/');
});

Test('the limit of requests of each address', function() {
	const limiter = new Limiter();
	Assert.equal(limiter.take('1.2.3.4'), 0, 'off by default');
	limiter.set({ rate: 2, burst: 3 });
	const now = 1000000;
	Assert.deepEqual([limiter.take('1.2.3.4', now), limiter.take('1.2.3.4', now), limiter.take('1.2.3.4', now)], [0, 0, 0]);
	Assert.equal(limiter.take('1.2.3.4', now), 1, 'a fourth at once waits');
	Assert.equal(limiter.take('5.6.7.8', now), 0, 'each address its own');
	Assert.equal(limiter.take('1.2.3.4', now + 600), 0, 'it fills with the rate');
	limiter.sweep(now + 60000);
	Assert.equal(limiter.buckets.size, 0, 'full buckets are forgotten');
});

Test('the page of the proxy in the language of the visitor', function() {
	Assert.equal(Pages.language('es-ES,es;q=0.9,en;q=0.8'), 'es');
	Assert.equal(Pages.language('en-US,en;q=0.9,es;q=0.8'), 'en');
	Assert.equal(Pages.language(''), 'en');
	Assert.match(Pages.stopped('es').toString(), /lang="es"/);
});

Test('redirects, pages, maintenance and the settings of every site', async function(t) {

	const backend = await makebackend();
	const target = 'http://127.0.0.1:' + backend.port;
	const proxy = await start({}, [
		{ id: 'shop', hosts: ['shop.test'], target, tls: 'off', forwards: [{ host: 'old.test', to: 'https://shop.example.com/' }, { host: 'promo.test', to: 'https://shop.example.com/offer', path: false, permanent: false }] },
		{ id: 'down', hosts: ['down.test'], target: 'http://127.0.0.1:9', tls: 'off', page: '<h1>Resting</h1>' },
		{ id: 'fixing', hosts: ['fixing.test'], target, tls: 'off', maintenance: true, page: '<h1>Fixing things</h1>' },
		{ id: 'code', hosts: ['code.test'], target, tls: 'off', limit: false }
	]);
	proxy.manager.stop();
	const http = proxy.ports.http;
	const socketPath = proxy.config.control;
	const api = (method, path, body) => request({ socketPath, method, path, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json' } });

	t.after(async () => {
		await proxy.stop();
		backend.close();
	});

	await t.test('a name redirects to any address, with its path or without', async function() {
		const old = await request({ port: http, host: 'old.test', path: '/blog/post?id=1' });
		Assert.equal(old.status, 301);
		Assert.equal(old.headers.location, 'https://shop.example.com/blog/post?id=1');
		const promo = await request({ port: http, host: 'promo.test', path: '/x' });
		Assert.equal(promo.status, 302);
		Assert.equal(promo.headers.location, 'https://shop.example.com/offer');
		// A form keeps its method: 308 and 307
		Assert.equal((await request({ port: http, host: 'old.test', method: 'POST', body: 'a=1' })).status, 308);
		Assert.equal((await request({ port: http, host: 'promo.test', method: 'POST', body: 'a=1' })).status, 307);
		Assert.match(await upgrade(http, 'old.test'), /^HTTP\/1\.1 301[\s\S]*location: https:\/\/shop\.example\.com\/live/i);
	});

	await t.test('the own page of a site that does not answer, and maintenance', async function() {
		const down = await request({ port: http, host: 'down.test' });
		Assert.deepEqual([down.status, down.text, down.headers['retry-after']], [503, '<h1>Resting</h1>', '60']);
		const fixing = await request({ port: http, host: 'fixing.test' });
		Assert.deepEqual([fixing.status, fixing.text], [503, '<h1>Fixing things</h1>']);
		Assert.match(await upgrade(http, 'fixing.test'), /^HTTP\/1\.1 503/);
		// The control API takes a page of hundreds of KB
		const big = '<p>' + 'x'.repeat(300 * 1024) + '</p>';
		Assert.equal((await api('PUT', '/routes/down', { hosts: ['down.test'], target: 'http://127.0.0.1:9', tls: 'off', page: big })).status, 200);
		Assert.equal((await request({ port: http, host: 'down.test' })).text.length, big.length);
	});

	await t.test('the settings of every site', async function() {
		Assert.deepEqual((await api('GET', '/settings')).json, {});
		Assert.equal((await api('PUT', '/settings', { ratelimit: { rate: 5, burst: 1 } })).status, 400, 'the burst is at least the rate');
		Assert.equal((await api('PUT', '/settings', { deny: ['not an address'] })).status, 400);
		Assert.equal((await api('PUT', '/settings', { hsts: 'nope' })).status, 400);

		const saved = await api('PUT', '/settings', { headers: 'X-Server-Wide: yes', hsts: 'max-age=600', page: '<h1>Everybody rests</h1>' });
		Assert.equal(saved.status, 200);
		Assert.equal((await request({ port: http, host: 'shop.test' })).headers['x-server-wide'], 'yes');
		// The page of the settings for a site without its own
		await api('PUT', '/routes/down', { hosts: ['down.test'], target: 'http://127.0.0.1:9', tls: 'off' });
		Assert.equal((await request({ port: http, host: 'down.test' })).text, '<h1>Everybody rests</h1>');

		// The limit: a few at once, then 429 with Retry-After; a route with limit off skips the rate limit
		await api('PUT', '/settings', { ratelimit: { rate: 1, burst: 3 } });
		const statuses = [];
		for (let i = 0; i < 5; i++)
			statuses.push((await request({ port: http, host: 'shop.test' })).status);
		Assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
		const limited = await request({ port: http, host: 'shop.test' });
		Assert.ok(+limited.headers['retry-after'] >= 1);
		Assert.equal((await request({ port: http, host: 'code.test' })).status, 200);

		// Addresses that never come in, to any site
		await api('PUT', '/settings', { deny: ['127.0.0.0/8'] });
		Assert.equal((await request({ port: http, host: 'code.test' })).status, 403);
		Assert.match(await upgrade(http, 'shop.test'), /^HTTP\/1\.1 403/);

		// Kept: the proxy starts again with them
		proxy.settings.load();
		Assert.deepEqual(proxy.settings.get().deny, ['127.0.0.0/8']);
		await api('PUT', '/settings', {});
		Assert.equal((await request({ port: http, host: 'shop.test' })).status, 200);
	});
});

Test('standalone routes combine address restrictions, Basic auth and response headers', async function(t) {
	const backend = await makebackend();
	const target = 'http://127.0.0.1:' + backend.port;
	const Guard = require('../lib/guard');
	const auth = [{ user: 'ana', hash: Guard.hash('test-password') }];
	const authorization = 'Basic ' + Buffer.from('ana:test-password').toString('base64');
	const proxy = await start({}, [
		{ id: 'private', hosts: ['private.test'], target, allow: ['127.0.0.0/8', '2001:db8::/32'], auth, headers: { 'X-Frame-Options': 'SAMEORIGIN' } },
		{ id: 'restricted', hosts: ['restricted.test'], redirects: ['alias.test'], target, allow: ['127.0.0.0/8'], deny: ['127.0.0.1'], auth },
		{ id: 'office', hosts: ['office.test'], target, allow: ['10.0.0.0/8'] },
		{ id: 'public', hosts: ['public.test'], target }
	]);
	t.after(async () => {
		await proxy.stop();
		backend.close();
	});
	const visit = (host, headers) => request({ port: proxy.ports.http, host, headers });
	Assert.equal((await visit('office.test', { 'x-forwarded-for': '10.0.0.5' })).status, 403);
	for (const host of ['restricted.test', 'alias.test'])
		Assert.equal((await visit(host, { authorization })).status, 403);

	const challenge = await visit('private.test');
	Assert.equal(challenge.status, 401);
	Assert.match(challenge.headers['www-authenticate'], /^Basic /);
	const accepted = await visit('private.test', { authorization });
	Assert.equal(accepted.status, 200);
	Assert.equal(accepted.headers['x-frame-options'], 'SAMEORIGIN');
	Assert.equal(accepted.json.headers.authorization, undefined);
	Assert.equal((await visit('public.test', { authorization })).json.headers.authorization, authorization);

	const ws = host => new Promise((resolve, reject) => {
		const socket = Net.connect(proxy.ports.http, '127.0.0.1', () => {
			socket.write('GET /live HTTP/1.1\r\nHost: ' + host + '\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
		});
		socket.once('error', reject);
		socket.once('data', data => {
			socket.destroy();
			resolve(data.toString());
		});
	});
	Assert.match(await ws('private.test'), /^HTTP\/1\.1 401 /);
	Assert.match(await ws('alias.test'), /^HTTP\/1\.1 403 /);
	Assert.throws(() => Routes.addresses(['10.0.0.0/8/24'], 'allow'), /not an address or a network/);
});
