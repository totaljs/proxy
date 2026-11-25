'use strict';

// The visits of a site (route option "stats"): pages, visitors without personal data, search engines and AI agents,
// 404 and 5xx, files per day, and the control API.

const Test = require('node:test');
const Assert = require('node:assert/strict');
const Fs = require('node:fs');
const Path = require('node:path');
const Http = require('node:http');
const Stats = require('../lib/stats');
const { proxy: start, request, tmpdir } = require('./helpers');

async function backend() {
	const server = Http.createServer(function(req, res) {
		req.resume();
		const code = req.url.startsWith('/missing') ? 404 : req.url.startsWith('/broken') ? 500 : req.url.startsWith('/old') ? 301 : 200;
		res.writeHead(code, code === 301 ? { location: '/new' } : { 'content-type': 'text/html' });
		res.end('ok');
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	server.port = server.address().port;
	return server;
}

const PERSON = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15';
const OTHER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36';

Test('the visits of a site', async function(t) {

	const app = await backend();
	const data = tmpdir();
	const routes = [
		{ id: 'shop', hosts: ['shop.test'], target: 'http://127.0.0.1:' + app.port, https: false, tls: 'off', stats: true },
		{ id: 'blog', hosts: ['blog.test'], target: 'http://127.0.0.1:' + app.port, https: false, tls: 'off' }
	];
	const proxy = await start({ data }, routes);
	t.after(async () => {
		await proxy.stop();
		app.close();
		Fs.rmSync(data, { recursive: true, force: true });
	});

	const visit = (host, path, ua, headers) => request({ port: proxy.ports.http, host, path, headers: Object.assign({ 'user-agent': ua }, headers) });
	const control = (path, method) => request({ socketPath: proxy.config.control, path, method });

	await t.test('who asked: a person, a search engine, an AI agent or another bot', function() {
		Assert.deepEqual(Stats.client(PERSON), { kind: 'person', name: '' });
		Assert.deepEqual(Stats.client('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), { kind: 'search', name: 'Googlebot' });
		Assert.deepEqual(Stats.client('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)'), { kind: 'ai', name: 'ClaudeBot' });
		Assert.deepEqual(Stats.client('Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)'), { kind: 'ai', name: 'GPTBot' });
		Assert.equal(Stats.client('curl/8.4.0').kind, 'bot');
		// The own name of a robot, not "Mozilla"
		Assert.deepEqual(Stats.client('Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)'), { kind: 'bot', name: 'SemrushBot' });
		Assert.deepEqual(Stats.client('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/120.0 Safari/537.36'), { kind: 'bot', name: 'HeadlessChrome' });
		Assert.equal(Stats.client('curl/8.4.0').name, 'curl');
		Assert.equal(Stats.client('').kind, 'bot');
	});

	await t.test('pages, visitors, referrers, errors and agents of a site that asks for them', async function() {
		await visit('shop.test', '/', PERSON, { referer: 'https://www.google.com/search?q=shop' });
		await visit('shop.test', '/products?page=2', PERSON);
		await visit('shop.test', '/products', OTHER, { 'x-forwarded-for': '10.0.0.9' });
		await visit('shop.test', '/js/app.js', PERSON);
		await visit('shop.test', '/media/intro.en.vtt', PERSON);
		await visit('shop.test', '/missing', PERSON);
		await visit('shop.test', '/broken', PERSON);
		await visit('shop.test', '/old', PERSON);
		await visit('shop.test', '/', 'Mozilla/5.0 (compatible; Googlebot/2.1)');
		await visit('shop.test', '/products', 'Mozilla/5.0 (compatible; ClaudeBot/1.0)');
		await visit('shop.test', '/', PERSON, { referer: 'http://shop.test/products' });
		// Blog does not ask: nothing counted
		await visit('blog.test', '/', PERSON);

		const days = (await control('/stats/shop')).json;
		Assert.equal(days.length, 1);
		const day = days[0];
		// Pages of people: /, /products, /products, /missing (404), /broken (500), / again; not the script, not the redirect
		Assert.equal(day.views, 6);
		// Two people (two browsers); the same person again is not a new visitor
		Assert.equal(day.visitors, 2);
		Assert.equal(day.paths['/products'].views, 2);
		Assert.ok(!day.paths['/js/app.js']);
		Assert.equal(day.search, 1);
		Assert.equal(day.ai, 1);
		Assert.deepEqual(day.referrers, { 'google.com': 1 });
		Assert.deepEqual(day.notfound, { '/missing': 1 });
		Assert.deepEqual(day.errors, { '/broken': 1 });
		Assert.equal(day.agents.Googlebot.kind, 'search');
		Assert.deepEqual(day.agents.ClaudeBot.paths, { '/products': 1 });
		Assert.equal(day.hours.reduce((sum, hour) => sum + hour.views, 0), 6);
		// No address and no user agent of a person is kept
		const text = JSON.stringify(day);
		Assert.ok(!text.includes('127.0.0.1') && !text.includes('Safari'));
		Assert.deepEqual((await control('/stats/blog')).json, []);
	});

	await t.test('the days go to a file, and DELETE removes them', async function() {
		proxy.stats.flush();
		const day = new Date().toISOString().substring(0, 10);
		const file = Path.join(data, 'stats', 'shop', day + '.json');
		Assert.equal(JSON.parse(Fs.readFileSync(file, 'utf8')).views, 6);
		Assert.equal((await control('/stats/../x')).status === 200, false);
		Assert.equal((await control('/stats/shop', 'DELETE')).status, 200);
		Assert.ok(!Fs.existsSync(file));
	});
});

Test('the unique visitor cap preserves page counts and is reset each UTC day', function(t) {
	const data = tmpdir();
	t.after(() => Fs.rmSync(data, { recursive: true, force: true }));
	const stats = new Stats(data, 10);
	const route = { id: 'shop', stats: true };
	const time = Date.UTC(2026, 0, 1);
	const info = { method: 'GET', path: '/', status: 200, ip: '127.0.0.1', time };
	for (let i = 0; i < 50001; i++) {
		info.ua = 'Mozilla/' + i;
		stats.record(route, info);
	}
	const day = stats.get('shop', '2026-01-01', '2026-01-01')[0];
	Assert.equal(day.views, 50001);
	Assert.equal(day.visitors, 50000);
	Assert.equal(day.visitors_capped, true);
	Assert.equal(stats.seenCount, 50000);

	info.time += 86400000;
	stats.record(route, info);
	const next = stats.get('shop', '2026-01-02', '2026-01-02')[0];
	Assert.equal(next.visitors, 1);
	Assert.equal(next.visitors_capped, undefined);
	Assert.equal(stats.seenCount, 1);
});
