'use strict';

// Docker discovery: the containers of the network write their own site files, and a container that stops removes its
// file. Docker is a stand-in here: the three questions of the Engine API that discovery asks, on a Unix socket.

const Test = require('node:test');
const Assert = require('node:assert/strict');
const Fs = require('node:fs');
const Path = require('node:path');
const Http = require('node:http');
const Child = require('node:child_process');
const Docker = require('../lib/docker');
const Routes = require('../lib/routes');
const { tmpdir, proxy: start, backend: makebackend, request } = require('./helpers');

const NETWORK = { Name: 'proxy', Id: 'net-proxy' };

function container(name, env, options) {
	options = options || {};
	return {
		Id: 'id-' + name, Name: '/' + name, State: { Running: options.running !== false },
		Config: { Env: ['PATH=/usr/bin', 'NODE_ENV=production'].concat(env || []), Labels: options.labels || {} },
		NetworkSettings: { Networks: { [options.network || 'proxy']: { NetworkID: options.networkId || NETWORK.Id, IPAddress: options.ip === undefined ? '127.0.0.1' : options.ip } } }
	};
}

// state.containers: the containers of the network; state.event(): what Docker says when one of them changes
async function engine(folder) {
	const state = { containers: [], listeners: new Set(), down: false };
	const server = Http.createServer(function(req, res) {
		const url = new URL(req.url, 'http://docker');
		if (state.down) {
			res.writeHead(500, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ message: 'the daemon is busy' }));
			return;
		}
		if (url.pathname === '/events') {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.write('\n');
			state.listeners.add(res);
			res.on('close', () => state.listeners.delete(res));
			return;
		}
		let body = null;
		if (url.pathname === '/networks/proxy')
			body = { Name: 'proxy', Id: NETWORK.Id, Containers: Object.fromEntries(state.containers.map(item => [item.Id, { Name: item.Name.substring(1) }])) };
		else if (url.pathname.startsWith('/containers/'))
			body = state.containers.find(item => item.Id === url.pathname.split('/')[2]) || null;
		res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
		res.end(JSON.stringify(body || { message: 'No such object' }));
	});
	state.event = function() {
		for (const res of state.listeners)
			res.write(JSON.stringify({ Type: 'network', Action: 'connect', Actor: { Attributes: { name: 'proxy' } } }) + '\n');
	};
	state.socket = Path.join(folder, 'docker.sock');
	state.close = () => new Promise(resolve => {
		for (const res of state.listeners)
			res.destroy();
		server.close(resolve);
		server.closeAllConnections();
	});
	await new Promise(resolve => server.listen(state.socket, resolve));
	return state;
}

async function until(check, message) {
	for (let i = 0; i < 200; i++) {
		if (await check())
			return;
		await new Promise(resolve => setTimeout(resolve, 25));
	}
	Assert.fail(message || 'Timed out');
}

Test('the site of a container', function() {
	const one = Docker.site(container('totaljs', ['PROXY_HOST=totaljs.com,www.totaljs.com', 'PROXY_PORT=8000', 'PROXY_LOGS=TRUE'], { ip: '172.18.0.5' }), NETWORK);
	Assert.equal(one.id, 'totaljs.com');
	Assert.deepEqual(one.data, { hosts: ['totaljs.com', 'www.totaljs.com'], target: '172.18.0.5:8000', logs: true, docker: 'totaljs' });

	// The port is 80 without PROXY_PORT; https:// asks for a certificate; the log is not said
	const two = Docker.site(container('shop', ['PROXY_HOST= https://Shop.test , https://www.shop.test,shop.test'], { ip: '172.18.0.6' }), NETWORK);
	// The names keep what they say: the proxy serves each one by it
	Assert.equal(two.id, 'shop.test');
	Assert.deepEqual(two.data, { hosts: ['https://shop.test', 'https://www.shop.test'], target: '172.18.0.6:80', docker: 'shop' });
	Assert.deepEqual(Docker.site(container('mixed', ['PROXY_HOST=https://a.test,http://b.test,c.test']), NETWORK).data.hosts, ['https://a.test', 'http://b.test', 'c.test']);

	const custom = Docker.site(container('portal', ['PROXY_HOST=portal.test', 'PROXY_CERT=shared/portal', 'PROXY_LOGS=false']), NETWORK);
	Assert.equal(custom.data.cert, 'custom');
	Assert.equal(custom.data.cert_file, 'shared/portal/fullchain.pem');
	Assert.equal(custom.data.logs, false);
	// With a certificate of your own, a name that says http:// stays HTTP
	const plain = Docker.site(container('plain', ['PROXY_HOST=http://plain.test', 'PROXY_CERT=shared/portal']), NETWORK).data;
	Assert.equal(Routes.mode(Routes.validate({ id: 'plain.test', ...plain }), 'plain.test'), 'off');

	// PROXY_CERT is "cert" of the site; another value is a folder with the files
	Assert.deepEqual(Docker.site(container('a', ['PROXY_HOST=a.test', 'PROXY_CERT=auto']), NETWORK).data, { hosts: ['a.test'], target: '127.0.0.1:80', cert: 'auto', docker: 'a' });
	Assert.deepEqual(Docker.site(container('a', ['PROXY_HOST=a.test', 'PROXY_CERT=CUSTOM']), NETWORK).data, { hosts: ['a.test'], target: '127.0.0.1:80', cert: 'custom', docker: 'a' });
	Assert.equal(Docker.site(container('a', ['PROXY_HOST=https://a.test', 'PROXY_CERT=off']), NETWORK).data.cert, 'off');

	// The labels say the same for one host
	const labelled = Docker.site(container('old', [], { labels: { 'proxy.host': 'old.test', 'proxy.port': '8000', 'proxy.cert': 'auto' } }), NETWORK);
	Assert.deepEqual(labelled.data, { hosts: ['old.test'], target: '127.0.0.1:8000', cert: 'auto', docker: 'old' });

	// Nothing to publish
	Assert.equal(Docker.site(container('db', []), NETWORK), null);
	Assert.equal(Docker.site(container('setup', ['PROXY_HOST=']), NETWORK), null);

	Assert.throws(() => Docker.site(container('a', ['PROXY_HOST=a.test:8000']), NETWORK), /PROXY_HOST needs host names/);
	Assert.throws(() => Docker.site(container('a', ['PROXY_HOST=a.test/path']), NETWORK), /PROXY_HOST needs host names/);
	Assert.throws(() => Docker.site(container('a', ['PROXY_HOST=a.test', 'PROXY_PORT=http']), NETWORK), /PROXY_PORT/);
	Assert.throws(() => Docker.site(container('a', ['PROXY_HOST=a.test', 'PROXY_LOGS=yes']), NETWORK), /PROXY_LOGS/);
	Assert.throws(() => Docker.site(container('a', ['PROXY_HOST=a.test', 'PROXY_CERT=../outside']), NETWORK));
	// Not on the network of the proxy (yet)
	Assert.throws(() => Docker.site(container('a', ['PROXY_HOST=a.test'], { network: 'other', networkId: 'net-other' }), NETWORK), /no address on the network proxy/);
	Assert.throws(() => Docker.site(container('a', ['PROXY_HOST=a.test'], { ip: '' }), NETWORK), /no address/);
});

Test('containers that start and stop are sites that come and go', { timeout: 30000 }, async function(t) {

	const backend = await makebackend();
	const data = tmpdir();
	const docker = await engine(data);
	const sites = Path.join(data, 'sites');
	const file = name => Path.join(sites, name + '.json');
	const read = name => JSON.parse(Fs.readFileSync(file(name), 'utf8'));

	// A site written by hand, and a file that discovery left before the proxy started (its container is gone)
	Fs.mkdirSync(sites);
	Fs.writeFileSync(file('manual.test'), JSON.stringify({ hosts: ['manual.test'], target: '127.0.0.1:' + backend.port }));
	Fs.writeFileSync(file('stale.test'), JSON.stringify({ hosts: ['stale.test'], target: '127.0.0.1:9', docker: 'gone' }));

	const app = container('totaljs-app', ['PROXY_HOST=totaljs.test,www.totaljs.test', 'PROXY_PORT=' + backend.port, 'PROXY_LOGS=TRUE']);
	docker.containers = [app, container('database', ['POSTGRES_DB=app'])];

	const said = [];
	const proxy = await start({ data, docker: docker.socket }, null, { log: message => said.push(message) });
	proxy.manager.stop();
	t.after(async () => {
		await proxy.stop();
		await docker.close();
		backend.close();
		Fs.rmSync(data, { recursive: true, force: true });
	});

	const get = host => request({ port: proxy.ports.http, host });
	const errors = () => {
		try {
			return Fs.readFileSync(Path.join(data, 'logs', 'error.log'), 'utf8');
		} catch {
			return '';
		}
	};

	await t.test('the containers that run when the proxy starts', async function() {
		await until(async () => (await get('www.totaljs.test')).status === 200, 'The container was not published');
		// One file for the container, named after its first host name
		Assert.deepEqual(read('totaljs.test'), { hosts: ['totaljs.test', 'www.totaljs.test'], target: '127.0.0.1:' + backend.port, logs: true, docker: 'totaljs-app' });
		Assert.deepEqual(Fs.readdirSync(sites).sort(), ['manual.test.json', 'totaljs.test.json']);
		Assert.equal((await get('manual.test')).status, 200);
		Assert.equal((await get('stale.test')).status, 404);
		Assert.ok(said.some(message => /Docker: removed stale\.test\.json \(the container gone does not run\)/.test(message)));
		Assert.equal(proxy.routes.items.get('totaljs.test').docker, 'totaljs-app');
	});

	await t.test('a container that starts', async function() {
		docker.containers.push(container('blog', ['PROXY_HOST=blog.test', 'PROXY_PORT=' + backend.port, 'PROXY_LOGS=FALSE']));
		docker.event();
		await until(async () => (await get('blog.test')).status === 200, 'The new container was not published');
		Assert.equal(read('blog.test').logs, false);
	});

	await t.test('a container that comes back with other values', async function() {
		const before = Fs.statSync(file('totaljs.test')).ino;
		// The same again: nothing is written
		docker.event();
		await new Promise(resolve => setTimeout(resolve, 150));
		Assert.equal(Fs.statSync(file('totaljs.test')).ino, before);

		app.Config.Env = ['PROXY_HOST=totaljs.test', 'PROXY_PORT=' + backend.port];
		docker.event();
		await until(async () => (await get('www.totaljs.test')).status === 404, 'The changed container was not applied');
		Assert.deepEqual(read('totaljs.test'), { hosts: ['totaljs.test'], target: '127.0.0.1:' + backend.port, docker: 'totaljs-app' });
		Assert.equal((await get('totaljs.test')).status, 200);
	});

	await t.test('a container that stops', async function() {
		docker.containers = docker.containers.filter(item => item.Name !== '/blog');
		docker.event();
		await until(() => !Fs.existsSync(file('blog.test')), 'The file of the stopped container stayed');
		await until(async () => (await get('blog.test')).status === 404, 'The stopped container is still published');
		Assert.equal((await get('totaljs.test')).status, 200);
	});

	await t.test('a file written by hand is never touched', async function() {
		const original = Fs.readFileSync(file('manual.test'), 'utf8');
		const taker = container('taker', ['PROXY_HOST=manual.test', 'PROXY_PORT=9']);
		docker.containers.push(taker);
		docker.event();
		await until(() => /Docker: the container taker is not published: manual\.test\.json was written by hand/.test(errors()), 'The refusal is not in error.log');
		Assert.equal(Fs.readFileSync(file('manual.test'), 'utf8'), original);
		Assert.equal((await get('manual.test')).status, 200);
		// And it stays when that container stops
		docker.containers = docker.containers.filter(item => item !== taker);
		docker.event();
		await new Promise(resolve => setTimeout(resolve, 150));
		Assert.equal(Fs.readFileSync(file('manual.test'), 'utf8'), original);
	});

	await t.test('containers with a mistake or the same name', async function() {
		docker.containers.push(container('broken', ['PROXY_HOST=broken.test', 'PROXY_PORT=abc']));
		docker.containers.push(container('twin-a', ['PROXY_HOST=twin.test', 'PROXY_PORT=' + backend.port]));
		docker.containers.push(container('twin-b', ['PROXY_HOST=twin.test', 'PROXY_PORT=9']));
		docker.containers.push(container('stopped', ['PROXY_HOST=stopped.test'], { running: false }));
		docker.event();
		await until(() => /the container broken is not published: PROXY_PORT needs a port number/.test(errors()), 'The mistake is not in error.log');
		await until(() => /twin-a and twin-b both publish twin\.test: twin-b is not published/.test(errors()), 'The duplicate is not in error.log');
		Assert.equal(read('twin.test').docker, 'twin-a');
		Assert.equal(Fs.existsSync(file('broken.test')), false);
		Assert.equal(Fs.existsSync(file('stopped.test')), false);
		// Said once, not at every sync
		docker.event();
		await new Promise(resolve => setTimeout(resolve, 150));
		Assert.equal(errors().match(/the container broken is not published/g).length, 1);
	});

	await t.test('a container that says the name of one that is published does not take it', async function() {
		// It sorts before the one that has the name
		Assert.equal(read('totaljs.test').docker, 'totaljs-app');
		const thief = container('a-thief', ['PROXY_HOST=totaljs.test', 'PROXY_PORT=9']);
		docker.containers.push(thief);
		await proxy.docker.reconcile();
		Assert.equal(read('totaljs.test').docker, 'totaljs-app');
		Assert.equal((await get('totaljs.test')).status, 200);
		await until(() => /a-thief and totaljs-app both publish totaljs\.test: a-thief is not published/.test(errors()), 'The refusal is not in error.log');
		docker.containers = docker.containers.filter(item => item !== thief);
		await proxy.docker.reconcile();
	});

	await t.test('what a container says is one short line in the logs', async function() {
		docker.containers.push(container('noisy', ['PROXY_HOST=a' + ' '.repeat(50000) + 'b\ninjected line']));
		const started = Date.now();
		await proxy.docker.reconcile();
		Assert.ok(Date.now() - started < 1000);
		await until(() => /the container noisy is not published: PROXY_HOST needs host names/.test(errors()), 'The mistake is not in error.log');
		Assert.doesNotMatch(errors(), /^injected line/m);
		Assert.ok(errors().split('\n').every(line => line.length < 400));
		docker.containers = docker.containers.filter(item => item.Name !== '/noisy');
	});

	await t.test('a Docker that does not answer removes nothing', async function() {
		const before = Fs.readdirSync(sites).sort();
		docker.down = true;
		docker.containers = [];
		await proxy.docker.reconcile();
		await until(() => /Docker: .*docker\.sock: the daemon is busy/.test(errors()), 'The failure is not in error.log');
		Assert.deepEqual(Fs.readdirSync(sites).sort(), before);
		Assert.equal((await get('totaljs.test')).status, 200);
		// It answers again, and now nothing runs: only the file written by hand stays
		docker.down = false;
		await proxy.docker.reconcile();
		Assert.deepEqual(Fs.readdirSync(sites), ['manual.test.json']);
		await until(async () => (await get('totaljs.test')).status === 404, 'The sites of the stopped containers are still published');
	});
});

Test('without Docker the proxy runs as before', async function(t) {
	const data = tmpdir();
	const proxy = await start({ data, docker: Path.join(data, 'no-docker.sock') });
	t.after(() => proxy.stop());
	await proxy.docker.reconcile();
	// No socket is not a mistake
	Assert.equal(Fs.existsSync(Path.join(data, 'logs', 'error.log')), false);
});

Test('the script writes the same files without the proxy', async function(t) {
	const data = tmpdir();
	const docker = await engine(data);
	const sites = Path.join(data, 'sites');
	t.after(async () => {
		await docker.close();
		Fs.rmSync(data, { recursive: true, force: true });
	});
	docker.containers = [container('totaljs-app', ['PROXY_HOST=totaljs.test', 'PROXY_PORT=8000'], { ip: '172.18.0.5' })];
	const run = () => new Promise(resolve => Child.execFile(process.execPath, [Path.join(__dirname, '../scripts/docker-watch.js'), sites, 'proxy', docker.socket, '--once'], (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stderr })));
	const first = await run();
	Assert.equal(first.code, 0, first.stderr);
	Assert.deepEqual(JSON.parse(Fs.readFileSync(Path.join(sites, 'totaljs.test.json'), 'utf8')), { hosts: ['totaljs.test'], target: '172.18.0.5:8000', docker: 'totaljs-app' });
	docker.containers = [];
	Assert.equal((await run()).code, 0);
	Assert.deepEqual(Fs.readdirSync(sites), []);
});
