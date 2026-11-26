'use strict';

// The files of the data folder are watched: config.json and sites/*.json are applied by themselves, and a file with
// a mistake changes nothing but logs/error.log.

const Test = require('node:test');
const Assert = require('node:assert/strict');
const Fs = require('node:fs');
const Path = require('node:path');
const Net = require('node:net');
const Runner = require('../lib/runner');
const { backend: makebackend, request, tmpdir } = require('./helpers');

async function until(check, message) {
	for (let i = 0; i < 200; i++) {
		if (await check())
			return;
		await new Promise(resolve => setTimeout(resolve, 25));
	}
	Assert.fail(message);
}

// A port that is free now
async function freeport() {
	const server = Net.createServer();
	await new Promise(resolve => server.listen(0, resolve));
	const port = server.address().port;
	await new Promise(resolve => server.close(resolve));
	return port;
}

function write(file, value) {
	Fs.writeFileSync(file + '.tmp', typeof value === 'string' ? value : JSON.stringify(value));
	Fs.renameSync(file + '.tmp', file);
}

Test('config.json and the sites are applied when they change', { timeout: 30000 }, async function(t) {

	const backend = await makebackend();
	const root = tmpdir();
	const data = Path.join(root, 'data');
	const logs = Path.join(root, 'logs');
	const config = Path.join(data, 'config.json');
	const site = name => Path.join(data, 'sites', name + '.json');
	Fs.mkdirSync(Path.join(data, 'sites'), { recursive: true });

	const [http, other] = [await freeport(), await freeport()];
	const base = { http, https: 0, docker: '', acme: 'https://127.0.0.1:9/directory' };
	write(config, base);
	write(site('app.test'), { hosts: ['app.test', 'www.app.test'], target: '127.0.0.1:' + backend.port, logs: true });

	const said = [];
	const runner = new Runner(data, { interval: 40, log: message => said.push(message) });
	await runner.start();
	t.after(async () => {
		await runner.stop();
		backend.close();
		Fs.rmSync(root, { recursive: true, force: true });
	});

	const get = (host, port) => request({ port: port || http, host });
	const errors = () => {
		try {
			return Fs.readFileSync(Path.join(logs, 'error.log'), 'utf8');
		} catch {
			return '';
		}
	};

	// The folder of the logs is made at the start, next to the data folder
	Assert.equal(Fs.statSync(logs).isDirectory(), true);
	Assert.equal((await get('www.app.test')).status, 200);

	await t.test('a new site, a changed one and a removed one', async function() {
		Assert.equal((await get('blog.test')).status, 404);
		write(site('blog.test'), { hosts: ['blog.test'], target: '127.0.0.1:' + backend.port });
		await until(async () => (await get('blog.test')).status === 200, 'The new site was not applied');

		write(site('blog.test'), { hosts: ['blog.test'], target: '127.0.0.1:9' });
		await until(async () => (await get('blog.test')).status === 503, 'The changed site was not applied');

		Fs.rmSync(site('blog.test'));
		await until(async () => (await get('blog.test')).status === 404, 'The removed site stayed');
	});

	await t.test('a site file with a mistake keeps the site and says why', async function() {
		write(site('app.test'), '{ "hosts": ["app.test"], "target": ');
		await until(() => /Sites: .*app\.test\.json was not applied: Not valid JSON/.test(errors()), 'The mistake is not in error.log');
		Assert.equal((await get('www.app.test')).status, 200);
		write(site('app.test'), { hosts: ['app.test', 'www.app.test'], target: '127.0.0.1:' + backend.port });
		await new Promise(resolve => setTimeout(resolve, 150));
		Assert.equal((await get('app.test')).status, 200);
	});

	await t.test('a setting that needs no restart', async function() {
		const proxy = runner.proxy;
		write(config, { ...base, maxupload: 3, logs_maxsize: 7, headers: { 'X-Test': 'live' } });
		await until(async () => (await get('app.test')).headers['x-test'] === 'live', 'The headers were not applied');
		Assert.equal(runner.proxy, proxy);
		Assert.equal(proxy.config.maxupload, 3);
		Assert.equal(proxy.logs.maxsize, 7 * 1024 * 1024);
		Assert.ok(said.some(message => /Config: applied .*maxupload/.test(message)));
	});

	await t.test('what applies to every site is in config.json too', async function() {
		const proxy = runner.proxy;
		write(config, { ...base, deny: ['127.0.0.1'], page: '<h1>Resting</h1>' });
		await until(async () => (await get('app.test')).status === 403, 'The denied address was not applied');
		write(config, { ...base, maxupload: 3, logs_maxsize: 7, headers: { 'X-Test': 'live' }, page: '<h1>Resting</h1>' });
		await until(async () => (await get('app.test')).status === 200, 'The address stayed denied');
		Assert.equal(runner.proxy, proxy);
		Assert.equal(String(proxy.page), '<h1>Resting</h1>');
	});

	await t.test('a config with a mistake changes nothing', async function() {
		const proxy = runner.proxy;
		write(config, '{ "http": ' + http + ', "maxupload": }');
		await until(() => /Config: .*config\.json was not applied: config\.json is not valid JSON/.test(errors()), 'The mistake is not in error.log');
		write(config, { ...base, maxuploda: 9 });
		await until(() => /Unknown key in config\.json: maxuploda/.test(errors()), 'The unknown key is not in error.log');
		Assert.equal(runner.proxy, proxy);
		Assert.equal(proxy.config.maxupload, 3);
		Assert.equal((await get('app.test')).status, 200);
		// Said once, not at every look
		await new Promise(resolve => setTimeout(resolve, 200));
		Assert.equal(errors().match(/maxuploda/g).length, 1);
	});

	await t.test('another port starts the proxy again', async function() {
		const proxy = runner.proxy;
		write(config, { ...base, http: other });
		await until(async () => runner.proxy !== proxy && !runner.busy, 'The proxy did not start again');
		Assert.equal((await get('app.test', other)).status, 200);
		await Assert.rejects(get('app.test', http));
	});

	await t.test('a config that cannot start brings the one of before back', async function() {
		const taken = Net.createServer();
		await new Promise(resolve => taken.listen(0, resolve));
		write(config, { ...base, http: taken.address().port });
		await until(() => /was not applied, the config of before runs: .*EADDRINUSE/.test(errors()), 'The failed start is not in error.log');
		taken.close();
		Assert.equal(runner.proxy.config.http, other);
		Assert.equal((await get('app.test', other)).status, 200);
	});

	await t.test('more workers', async function() {
		write(config, { ...base, http: other, workers: 2 });
		await until(() => runner.proxy.role === 'primary' && !runner.busy, 'The workers did not start');
		Assert.equal((await get('app.test', other)).status, 200);
		Assert.equal((await get('app.test', other)).status, 200);
		// A setting that needs no restart reaches the workers
		write(config, { ...base, http: other, workers: 2, headers: { 'X-Test': 'workers' } });
		await until(async () => (await get('app.test', other)).headers['x-test'] === 'workers' && (await get('app.test', other)).headers['x-test'] === 'workers', 'The workers did not get the config');
		// And a new site too
		write(site('late.test'), { hosts: ['late.test'], target: '127.0.0.1:' + backend.port });
		await until(async () => (await get('late.test', other)).status === 200 && (await get('late.test', other)).status === 200, 'The workers did not get the site');
		// The requests of the workers are written by the primary
		await until(() => Fs.existsSync(Path.join(logs, 'late.test.log')), 'The log of the site is not there');
	});

	await runner.stop();
	Assert.match(Fs.readFileSync(Path.join(logs, 'app.test.log'), 'utf8'), / www\.app\.test GET "\/" 200 /);
	Assert.match(Fs.readFileSync(Path.join(logs, 'late.test.log'), 'utf8'), / late\.test GET "\/" 200 /);
});

Test('a certificate put in data/certs is used without a restart', { timeout: 20000 }, async function(t) {
	const { proxy: start, selfsigned } = require('./helpers');
	const backend = await makebackend();
	const data = tmpdir();
	const proxy = await start({ data }, [
		{ id: 'secure.test', hosts: ['https://secure.test'], target: '127.0.0.1:' + backend.port, cert: 'custom' }
	]);
	t.after(async () => {
		await proxy.stop();
		backend.close();
		Fs.rmSync(data, { recursive: true, force: true });
	});
	const certs = Path.join(data, 'certs');
	const http = () => request({ port: proxy.ports.http, host: 'secure.test' });
	const https = ca => request({ port: proxy.ports.https, secure: true, host: 'secure.test', servername: 'secure.test', ca });

	// Without its certificate the site waits
	Assert.equal((await http()).status, 503);

	// secure.test.crt + secure.test.key, made elsewhere and copied in
	const made = selfsigned(Path.join(data, 'made'), 'secure.test', ['secure.test']);
	Fs.mkdirSync(certs, { recursive: true });
	Fs.copyFileSync(Path.join(data, 'made', 'secure.test.key'), Path.join(certs, 'secure.test.key'));
	Fs.copyFileSync(Path.join(data, 'made', 'secure.test.crt'), Path.join(certs, 'secure.test.crt'));
	await until(async () => (await http()).status === 301, 'The certificate was not picked up');
	Assert.equal((await https(made.cert)).status, 200);

	// Replaced by another one (.pem is the same as .crt)
	const next = selfsigned(Path.join(data, 'next'), 'secure.test', ['secure.test']);
	Fs.rmSync(Path.join(certs, 'secure.test.crt'));
	Fs.copyFileSync(Path.join(data, 'next', 'secure.test.key'), Path.join(certs, 'secure.test.key'));
	Fs.copyFileSync(Path.join(data, 'next', 'secure.test.crt'), Path.join(certs, 'secure.test.pem'));
	await until(async () => {
		try {
			return (await https(next.cert)).status === 200;
		} catch {
			return false;
		}
	}, 'The new certificate was not picked up');
	await Assert.rejects(https(made.cert));

	// Removed: the site waits again
	Fs.rmSync(Path.join(certs, 'secure.test.pem'));
	Fs.rmSync(Path.join(certs, 'secure.test.key'));
	await until(async () => (await http()).status === 503, 'The removed certificate is still used');
});
