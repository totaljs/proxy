'use strict';

const Test = require('node:test');
const Assert = require('node:assert/strict');
const Cluster = require('node:cluster');
const Path = require('node:path');
const Net = require('node:net');
const Fs = require('node:fs');
const Config = require('../lib/config');
const { proxy: start, backend: makebackend, request, selfsigned, tmpdir } = require('./helpers');

// What the primary changes reaches the workers a moment later
async function until(check, message) {
	for (let i = 0; i < 100; i++) {
		if (await check())
			return;
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	Assert.fail(message);
}

Test('workers in the config', function() {
	Assert.equal(Config.load(null, {}).workers, 1);
	Assert.equal(Config.load(null, { workers: '4' }).workers, 4);
	Assert.ok(Config.load(null, { workers: 0 }).workers >= 1);
	Assert.throws(() => Config.load(null, { workers: -1 }), /workers/);
	Assert.throws(() => Config.load(null, { workers: 65 }), /workers/);
});

Test('workers serve the sites of the primary', async function(t) {

	const backend = await makebackend();
	const data = tmpdir();
	selfsigned(Path.join(data, 'custom'), 'secure.test', ['secure.test']);
	const proxy = await start({ data, workers: 2 }, [
		{ id: 'secure', hosts: ['secure.test'], target: 'http://127.0.0.1:' + backend.port, cert: 'custom', https: false }
	]);
	proxy.manager.stop();

	t.after(async () => {
		await proxy.stop();
		backend.close();
	});

	const { site, settings } = require('./helpers');
	const get = (host, path) => request({ port: proxy.ports.http, host, path });

	Assert.equal(proxy.role, 'primary');
	Assert.equal(Object.keys(Cluster.workers).length, 2);
	Assert.ok(proxy.ports.http && proxy.ports.https);

	// Every connection goes to the next worker: both answer, over HTTP and HTTPS
	for (let i = 0; i < 4; i++)
		Assert.equal((await get('secure.test')).status, 200);
	Assert.equal((await request({ port: proxy.ports.https, host: 'secure.test', secure: true, servername: 'secure.test', ca: Fs.readFileSync(Path.join(data, 'custom', 'secure.test.crt')) })).status, 200);

	// The limits of the config are split among the workers
	Assert.equal(proxy.config.http_active, 2048);

	await t.test('a site file that is added and removed', async function() {
		Assert.equal((await get('shop.test')).status, 404);
		site(proxy, 'shop', { hosts: ['shop.test'], target: '127.0.0.1:' + backend.port });
		await until(async () => (await get('shop.test')).status === 200 && (await get('shop.test')).status === 200, 'The workers did not get the site');
		site(proxy, 'shop', null);
		await until(async () => (await get('shop.test')).status === 404 && (await get('shop.test')).status === 404, 'The workers kept the site');
	});

	await t.test('the answer of an ACME check', async function() {
		proxy.challenges.set('token-1', 'token-1.thumbprint');
		for (let i = 0; i < 2; i++) {
			const res = await get('secure.test', '/.well-known/acme-challenge/token-1');
			Assert.equal(res.status, 200);
			Assert.equal(res.text, 'token-1.thumbprint');
		}
		proxy.challenges.delete('token-1');
	});

	await t.test('the requests are counted by the workers and added up in the primary', async function() {
		// What the workers counted before has arrived by now
		await new Promise(resolve => setTimeout(resolve, 400));
		const before = proxy.stats.get('secure').total.requests;
		Assert.ok(before >= 5);
		for (let i = 0; i < 6; i++)
			await get('secure.test', '/page');
		// Each worker sends what it counted a few times a minute (here: every 100 ms)
		await until(() => proxy.stats.get('secure').total.requests === before + 6, 'The primary did not get the counters');
		Assert.equal(proxy.stats.get('secure').total['2xx'], before + 6);
	});

	await t.test('the settings', async function() {
		await settings(proxy, { deny: ['127.0.0.1'] });
		await until(async () => (await get('secure.test')).status === 403 && (await get('secure.test')).status === 403, 'The workers did not get the settings');
		await settings(proxy, {});
		await until(async () => (await get('secure.test')).status === 200 && (await get('secure.test')).status === 200, 'The workers kept the settings');
	});

	await t.test('a worker that ends is started again', async function() {
		const before = Object.keys(Cluster.workers);
		Cluster.workers[before[0]].process.kill('SIGKILL');
		await until(() => {
			const now = Object.keys(Cluster.workers);
			return now.length === 2 && !now.includes(before[0]) && proxy.workers.items.size === 2;
		}, 'The worker was not started again');
		await until(async () => {
			try {
				return (await get('secure.test')).status === 200 && (await get('secure.test')).status === 200;
			} catch {
				return false;
			}
		}, 'The new worker does not answer');
	});

	// What the workers counted last is written when the proxy stops
	await new Promise(resolve => setTimeout(resolve, 400));
	const counted = proxy.stats.get('secure').total.requests;
	for (let i = 0; i < 4; i++)
		await get('secure.test', '/last');
	await proxy.stop();
	Assert.equal(Object.keys(Cluster.workers).length, 0);
	Assert.equal(JSON.parse(Fs.readFileSync(Path.join(data, 'stats', 'secure.json'), 'utf8')).total.requests, counted + 4);
});

Test('workers that cannot listen fail the start', async function() {
	const taken = Net.createServer();
	await new Promise(resolve => taken.listen(0, resolve));
	await Assert.rejects(start({ workers: 2, http: taken.address().port }), /EADDRINUSE/);
	taken.close();
	Assert.equal(Object.keys(Cluster.workers).length, 0);
});
