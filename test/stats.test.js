'use strict';

// The requests of each site are counted: how many, with which answer, how long. Nothing more.

const Test = require('node:test');
const Assert = require('node:assert/strict');
const Fs = require('node:fs');
const Path = require('node:path');
const Net = require('node:net');
const Stats = require('../lib/stats');
const { proxy: start, backend: makebackend, request, tmpdir } = require('./helpers');

Test('the counters of a site', function() {
	const folder = Path.join(tmpdir(), 'stats');
	const stats = new Stats(folder, 2);
	const noon = Date.parse('2026-11-26T12:30:00Z');

	stats.hit('totaljs.com', 200, 12);
	stats.hit('totaljs.com', 204, 3);
	stats.hit('totaljs.com', 301, 1);
	stats.hit('totaljs.com', 404, 2);
	stats.hit('totaljs.com', 503, 30);
	stats.failed('totaljs.com');
	stats.websocket('totaljs.com');
	stats.hit('other.test', 200, 5);
	// Nothing is written while requests are counted
	Assert.equal(Fs.existsSync(folder), false);

	stats.fold(noon);
	stats.save(noon);
	const read = id => JSON.parse(Fs.readFileSync(Path.join(folder, id + '.json'), 'utf8'));
	const site = read('totaljs.com');
	Assert.deepEqual(site.total, { requests: 5, '2xx': 2, '3xx': 1, '4xx': 1, '5xx': 1, ms: 48, failed: 1, websockets: 1 });
	const day = site.days['2026-11-26'];
	Assert.equal(day.requests, 5);
	Assert.equal(day['5xx'], 1);
	Assert.equal(day.hours.length, 24);
	Assert.equal(day.hours[12], 5);
	Assert.equal(day.hours.reduce((a, b) => a + b), 5);
	Assert.equal(read('other.test').total.requests, 1);

	// The next hour and the next days go on from the file; the days past "stats_days" go
	const again = new Stats(folder, 2);
	again.hit('totaljs.com', 200, 10);
	again.fold(noon + 3600000);
	again.hit('totaljs.com', 500, 10);
	again.fold(noon + 86400000);
	again.save(noon + 86400000);
	Assert.equal(read('totaljs.com').total.requests, 7);
	Assert.equal(read('totaljs.com').days['2026-11-26'].hours[13], 1);
	Assert.equal(read('totaljs.com').days['2026-11-27'].requests, 1);
	again.hit('totaljs.com', 200, 1);
	again.fold(noon + 4 * 86400000);
	again.save(noon + 4 * 86400000);
	Assert.deepEqual(Object.keys(read('totaljs.com').days), ['2026-11-30']);
	// The total is of all time
	Assert.equal(read('totaljs.com').total.requests, 8);

	// What a worker counted is added; what is not a count or not a site is left out
	const primary = new Stats(folder, 2);
	const sent = [];
	const worker = new Stats(folder, 2, { send: counted => sent.push(counted) });
	worker.hit('fresh.test', 200, 4);
	worker.hit('fresh.test', 200, 6);
	worker.fold();
	worker.fold();
	Assert.deepEqual(sent, [{ 'fresh.test': [2, 2, 0, 0, 0, 10, 0, 0] }]);
	primary.take(JSON.parse(JSON.stringify(sent[0])));
	primary.take({ '../outside': [9, 9, 9, 9, 9, 9, 9, 9], 'fresh.test': [-5, 'x', null, 1.5] });
	Assert.deepEqual(primary.get('fresh.test').total, { requests: 2, '2xx': 2, '3xx': 0, '4xx': 0, '5xx': 0, ms: 10, failed: 0, websockets: 0 });
	primary.save();
	Assert.equal(Fs.existsSync(Path.join(folder, '..', 'outside.json')), false);
});

Test('the proxy counts the requests of every site', async function(t) {
	const backend = await makebackend();
	const data = tmpdir();
	const proxy = await start({ data }, [
		{ id: 'app.test', hosts: ['app.test'], redirects: ['www.app.test'], target: '127.0.0.1:' + backend.port, deny: ['10.0.0.0/8'] },
		{ id: 'down.test', hosts: ['down.test'], target: '127.0.0.1:9', logs: false }
	]);
	proxy.manager.stop();
	t.after(() => backend.close());
	const get = (host, path) => request({ port: proxy.ports.http, host, path });

	for (let i = 0; i < 3; i++)
		Assert.equal((await get('app.test', '/page')).status, 200);
	Assert.equal((await get('app.test', '/app.js')).status, 200);
	Assert.equal((await get('www.app.test')).status, 301);
	Assert.equal((await get('down.test')).status, 503);
	Assert.equal((await get('nobody.test')).status, 404);

	// A WebSocket that is opened
	await new Promise((resolve, reject) => {
		const socket = Net.connect(proxy.ports.http, '127.0.0.1', () => socket.write('GET /live HTTP/1.1\r\nHost: app.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'));
		socket.once('data', chunk => {
			/^HTTP\/1\.1 101/.test(chunk) ? resolve() : reject(new Error(String(chunk)));
			socket.destroy();
		});
		socket.once('error', reject);
	});

	const app = proxy.stats.get('app.test').total;
	Assert.deepEqual([app.requests, app['2xx'], app['3xx'], app['4xx'], app['5xx'], app.failed, app.websockets], [5, 4, 1, 0, 0, 0, 1]);
	Assert.ok(app.ms >= 0);
	const down = proxy.stats.get('down.test').total;
	Assert.deepEqual([down.requests, down['5xx'], down.failed], [1, 1, 1]);

	// Written when the proxy stops; a host that no site has is not counted
	await proxy.stop();
	Assert.deepEqual(Fs.readdirSync(Path.join(data, 'stats')).sort(), ['app.test.json', 'down.test.json']);
	const saved = JSON.parse(Fs.readFileSync(Path.join(data, 'stats', 'app.test.json'), 'utf8'));
	Assert.equal(saved.total.requests, 5);
	Assert.equal(Object.values(saved.days)[0].requests, 5);
});
