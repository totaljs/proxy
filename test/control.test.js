'use strict';

const Test = require('node:test');
const Assert = require('node:assert/strict');
const Fs = require('node:fs');
const { proxy: start, backend: makebackend, request } = require('./helpers');

Test('control API', async function(t) {

	const backend = await makebackend();
	const proxy = await start({ dns_zone: 'acme.code.test', dns: 0 });
	proxy.manager.stop();

	t.after(async () => {
		await proxy.stop();
		backend.close();
	});

	const socketPath = proxy.config.control;
	const api = (method, path, body) => request({ socketPath, method, path, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json' } });

	Assert.equal(Fs.statSync(socketPath).mode & 0o777, 0o600);

	const put = await api('PUT', '/routes/shop', { hosts: ['shop.test'], target: 'http://127.0.0.1:' + backend.port, tls: 'off' });
	Assert.equal(put.status, 200);
	Assert.equal(put.json.id, 'shop');

	// Published right away
	Assert.equal((await request({ port: proxy.ports.http, host: 'shop.test' })).status, 200);

	Assert.equal((await api('GET', '/routes')).json.length, 1);
	Assert.equal((await api('GET', '/routes/shop')).json.target, 'http://127.0.0.1:' + backend.port);
	Assert.equal((await api('GET', '/routes/none')).status, 404);

	Assert.equal((await api('PUT', '/routes/bad', { hosts: ['localhost'], target: 'http://a:1' })).status, 400);
	Assert.equal((await api('PUT', '/routes/other', { hosts: ['shop.test'], target: 'http://a:1' })).status, 409);
	Assert.equal((await request({ socketPath, method: 'PUT', path: '/routes/x', body: '{nope' })).status, 400);

	const dns = await api('GET', '/dns/*.clientes.test');
	Assert.equal(dns.json.name, '_acme-challenge.clientes.test');
	Assert.equal(dns.json.type, 'CNAME');
	Assert.match(dns.json.value, /^[0-9a-f]{20}\.acme\.code\.test$/);
	Assert.equal((await api('GET', '/dns/clientes.test')).json.value, dns.json.value);

	const status = await api('GET', '/status');
	Assert.equal(status.json.dns_zone, 'acme.code.test');
	Assert.equal(status.json.ports.http, proxy.ports.http);

	Assert.equal((await api('POST', '/renew/shop.test')).status, 404);

	Assert.equal((await api('DELETE', '/routes/shop')).status, 200);
	Assert.equal((await request({ port: proxy.ports.http, host: 'shop.test' })).status, 404);
	Assert.equal((await api('DELETE', '/routes/shop')).status, 404);
});

Test('control API on the network needs a token', async function(t) {

	await Assert.rejects(start({ control: '127.0.0.1:0' }), /needs a token/);

	const proxy = await start({ control: '127.0.0.1:0', token: 'secret-token' });
	t.after(() => proxy.stop());

	const port = proxy.control.address().port;
	Assert.equal((await request({ port, path: '/routes' })).status, 401);
	Assert.equal((await request({ port, path: '/routes', headers: { authorization: 'Bearer wrong-token!' } })).status, 401);
	Assert.equal((await request({ port, path: '/routes', headers: { authorization: 'Bearer secret-token' } })).status, 200);
});

Test('file-managed routes reload atomically and reject API mutations', { timeout: 22000 }, async function(t) {
	const Path = require('node:path');
	const { tmpdir } = require('./helpers');
	const data = tmpdir();
	const backend = await makebackend();
	const routesFile = Path.join(data, 'standalone.json');
	const shop = { id: 'shop', hosts: ['shop.localhost'], tls: 'off', target: 'http://127.0.0.1:' + backend.port };
	Fs.writeFileSync(routesFile, JSON.stringify([shop]));
	const proxy = await start({ data, routes_file: routesFile });
	t.after(async () => {
		await proxy.stop();
		backend.close();
		Fs.rmSync(data, { recursive: true, force: true });
	});
	const socketPath = proxy.config.control;
	Assert.equal((await request({ port: proxy.ports.http, host: shop.hosts[0] })).status, 200);
	Assert.equal((await request({ socketPath, path: '/routes/shop' })).json.id, shop.id);
	Assert.equal((await request({ socketPath, method: 'DELETE', path: '/routes/shop' })).status, 409);
	Assert.equal((await request({ socketPath, method: 'PUT', path: '/routes/shop', body: JSON.stringify(shop) })).status, 409);
	Assert.deepEqual(JSON.parse(Fs.readFileSync(routesFile, 'utf8')), [shop]);

	const replacement = { ...shop, id: 'next', hosts: ['next.localhost'] };
	const writeRoutes = contents => {
		Fs.writeFileSync(routesFile + '.tmp', JSON.stringify(contents));
		Fs.renameSync(routesFile + '.tmp', routesFile);
	};
	const rejected = new Promise(resolve => {
		proxy.log = message => {
			if (message.includes('could not reload'))
				resolve(message);
		};
	});
	writeRoutes([replacement, { ...shop, id: 'duplicate', hosts: replacement.hosts }]);
	Assert.match(await rejected, /already belongs/);
	Assert.equal((await request({ port: proxy.ports.http, host: 'shop.localhost' })).status, 200);
	Assert.equal((await request({ port: proxy.ports.http, host: 'next.localhost' })).status, 404);

	const reloaded = new Promise(resolve => {
		proxy.log = message => {
			if (message.includes('reloaded'))
				resolve();
		};
	});
	writeRoutes([replacement]);
	await reloaded;
	Assert.equal((await request({ port: proxy.ports.http, host: 'next.localhost' })).status, 200);
	Assert.equal((await request({ port: proxy.ports.http, host: 'shop.localhost' })).status, 404);
	Assert.equal((await request({ socketPath, path: '/routes/next' })).json.id, 'next');

});

Test('shared control isolates route IDs, domains and global settings', async function(t) {
	const Path = require('node:path');
	const { tmpdir } = require('./helpers');
	const data = tmpdir();
	const filename = Path.join(data, 'clients.json');
	const alpha = 'a'.repeat(40);
	const beta = 'b'.repeat(40);
	const admin = 'admin-token';
	Fs.writeFileSync(filename, JSON.stringify({
		alpha: { token: alpha, domains: ['*.alpha.test'] },
		beta: { token: beta, domains: ['*.beta.test'] }
	}));
	const proxy = await start({ data, control_clients_file: filename, token: admin, dns_zone: 'acme.code.test' });
	proxy.manager.stop();
	t.after(async () => {
		await proxy.stop();
		Fs.rmSync(data, { recursive: true, force: true });
	});
	const api = (token, method, path, body) => request({
		socketPath: proxy.config.control, method, path, body: body && JSON.stringify(body),
		headers: { authorization: token ? 'Bearer ' + token : '', 'content-type': 'application/json' }
	});
	const route = host => ({ hosts: [host], target: 'http://app:8000', tls: 'off', stats: true });

	Assert.equal((await api(null, 'GET', '/routes')).status, 401);
	Assert.equal((await api(alpha, 'PUT', '/routes/code', route('code.alpha.test'))).json.id, 'code');
	Assert.equal((await api(beta, 'PUT', '/routes/code', route('code.beta.test'))).json.id, 'code');
	Assert.deepEqual((await api(admin, 'GET', '/routes')).json.map(item => item.id).sort(), ['alpha--code', 'beta--code']);
	Assert.deepEqual((await api(alpha, 'GET', '/routes')).json.map(item => item.hosts[0]), ['code.alpha.test']);
	Assert.equal((await api(alpha, 'GET', '/routes/beta--code')).status, 404);
	proxy.manager.status.set('code.alpha.test', { state: 'valid' });
	proxy.manager.status.set('code.beta.test', { state: 'valid' });
	Assert.deepEqual(Object.keys((await api(alpha, 'GET', '/status')).json.hosts), ['code.alpha.test']);
	Assert.deepEqual(Object.keys((await api(beta, 'GET', '/status')).json.hosts), ['code.beta.test']);

	for (const name of ['alpha', 'beta'])
		proxy.stats.record(proxy.routes.get(name + '--code'), { method: 'GET', path: '/' + name, status: 200 });
	Assert.equal((await api(alpha, 'GET', '/stats/code')).json.length, 1);
	Assert.equal((await api(beta, 'GET', '/stats/code')).json.length, 1);
	Assert.equal((await api(alpha, 'DELETE', '/stats/code')).status, 200);
	Assert.equal((await api(alpha, 'GET', '/stats/code')).json.length, 0);
	Assert.equal((await api(beta, 'GET', '/stats/code')).json.length, 1);

	Assert.equal((await api(alpha, 'PUT', '/routes/code', route('code.beta.test'))).status, 403);
	Assert.equal((await api(alpha, 'PUT', '/routes/code', { ...route('code.alpha.test'), tls: 'custom', cert_file: 'app.pem', key_file: 'app.key' })).status, 403);
	Assert.equal((await api(admin, 'PUT', '/routes/manual', { ...route('manual.test'), tls: 'custom', cert_file: '../app.pem', key_file: 'app.key' })).status, 400);
	Assert.equal((await api(alpha, 'PUT', '/routes/code', { ...route('code.alpha.test'), redirects: ['other.beta.test'] })).status, 403);
	Assert.equal((await api(alpha, 'GET', '/dns/code.beta.test')).status, 403);
	Assert.equal((await api(alpha, 'GET', '/dns/code.alpha.test')).status, 200);
	Assert.equal((await api(alpha, 'PUT', '/settings', {})).status, 403);
	Assert.equal((await api(admin, 'GET', '/settings')).status, 200);
	Assert.equal((await api(admin, 'PUT', '/routes/manual', route('other.alpha.test'))).status, 200);
	Assert.equal((await api(alpha, 'PUT', '/routes/wildcard', route('*.alpha.test'))).status, 409);
	Assert.equal((await api(alpha, 'DELETE', '/routes/code')).status, 200);
	Assert.deepEqual((await api(beta, 'GET', '/routes/code')).json.hosts, ['code.beta.test']);
});
