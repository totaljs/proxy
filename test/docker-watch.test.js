'use strict';

const Test = require('node:test');
const Assert = require('node:assert/strict');
const Fs = require('node:fs');
const Path = require('node:path');
const Child = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { tmpdir, proxy: start, request } = require('./helpers');
const { snapshot, publish } = require('../scripts/docker-watch');

function container(id, host, network = 'network') {
	return {
		Id: id, Name: '/' + id, State: { Running: true },
		Config: { Labels: { 'proxy.host': host, 'proxy.port': '8000' } },
		NetworkSettings: { Networks: { proxy: { NetworkID: network } } }
	};
}

async function until(check) {
	for (let i = 0; i < 100; i++) {
		if (await check())
			return;
		await delay(100);
	}
	Assert.fail('Timed out waiting for routes');
}

Test('Docker discovery excludes ambiguous hosts and ignores foreign networks', async function(t) {
	const containers = [
		container('one', 'duplicate.test'),
		container('two', 'duplicate.test'),
		container('foreign', 'foreign.test', 'another-network'),
		container('shop', 'shop.test')
	];
	const docker = async args => args[0] === 'network' ? [{ Name: 'proxy', Id: 'network', Containers: Object.fromEntries(containers.map(item => [item.Id, {}])) }] : containers;
	const logs = [];
	const routes = await snapshot('proxy', docker, message => logs.push(message));
	Assert.deepEqual(routes.map(route => [route.hosts[0], route.target]), [['shop.test', 'http://shop:8000']]);
	Assert.equal(routes[0].tls, 'off');
	Assert.match(logs.join('\n'), /duplicate Docker hostname/);

	const folder = tmpdir();
	t.after(() => Fs.rmSync(folder, { recursive: true, force: true }));
	const manual = Path.join(folder, 'routes.json');
	Fs.writeFileSync(manual, '[]\n');
	await Assert.rejects(publish(manual, routes), /Refusing to replace/);
	Assert.equal(Fs.readFileSync(manual, 'utf8'), '[]\n');

	const discovered = Path.join(folder, 'routes.docker.json');
	await publish(discovered, routes);
	Assert.equal(JSON.parse(Fs.readFileSync(discovered)).source, 'proxy-docker');
	Assert.equal(await publish(discovered, routes), false);
});

Test('Compose environment discovers multiple origins, a shared certificate and access logs', async function() {
	const app = container('totaljs-app', 'unused-label.test');
	app.Config.Env = [
		'PROXY_HOST=https://shop.test, https://www.shop.test, http://preview.test',
		'PROXY_PORT=80', 'PROXY_CERT=shared/shop', 'PROXY_LOGS=TRUE'
	];
	const auto = container('totaljs-auto', 'unused-label.test');
	auto.Config.Env = ['PROXY_HOST=https://auto.test,bare.test', 'PROXY_LOGS=false'];
	const invalid = container('totaljs-invalid', 'unused-label.test');
	invalid.Config.Env = ['PROXY_HOST=https://invalid.test', 'PROXY_CERT=../outside'];
	const temporary = container('flow-setup', 'unused-label.test');
	temporary.Config.Env = ['PROXY_HOST='];
	const containers = [app, auto, invalid, temporary];
	const docker = async args => args[0] === 'network' ? [{ Name: 'proxy', Id: 'network', Containers: Object.fromEntries(containers.map(item => [item.Id, {}])) }] : containers;
	const messages = [];
	const routes = await snapshot('proxy', docker, message => messages.push(message));
	const hosts = new Map(routes.map(route => [route.hosts[0], route]));
	Assert.equal(hosts.size, 5);
	for (const host of ['shop.test', 'www.shop.test']) {
		const item = hosts.get(host);
		Assert.equal(item.tls, 'custom');
		Assert.equal(item.cert_file, 'shared/shop/fullchain.pem');
		Assert.equal(item.key_file, 'shared/shop/privkey.pem');
		Assert.equal(item.accesslog, true);
		Assert.equal(new URL(item.target).hostname, 'totaljs-app');
		Assert.equal(new URL(item.target).port, '');
	}
	Assert.equal(hosts.get('preview.test').tls, 'off');
	Assert.equal(hosts.get('preview.test').cert_file, undefined);
	Assert.equal(hosts.get('auto.test').tls, 'auto');
	Assert.equal(hosts.get('auto.test').target, 'http://totaljs-auto');
	Assert.equal(hosts.get('auto.test').accesslog, false);
	Assert.equal(hosts.get('bare.test').tls, 'off');
	Assert.match(messages.join('\n'), /relative path inside custom_cert_dir/);
});

Test('Docker network events update Proxy without overriding manual routes', { timeout: 26000 }, async function(t) {
	const folder = tmpdir();
	const manual = Path.join(folder, 'routes.json');
	const generated = Path.join(folder, 'routes.docker.json');
	const fixture = Path.join(folder, 'state.json');
	const script = Path.join(folder, 'docker');
	const routes = [
		{ id: 'manual', hosts: ['manual.test', '*.reserved.test'], target: 'http://manual:8000', tls: 'off' }
	];
	const original = JSON.stringify(routes);
	Fs.writeFileSync(manual, original);
	Fs.writeFileSync(script, `#!/usr/bin/env node
const fs = require('node:fs');
const read = () => JSON.parse(fs.readFileSync(process.env.DOCKER_FIXTURE));
const args = process.argv.slice(2);
const state = read();
if (args[0] === 'events') {
	let revision = state.revision;
	setInterval(() => {
		const next = read().revision;
		if (next !== revision) {
			revision = next;
			console.log(JSON.stringify({ Actor: { Attributes: { name: 'proxy' } } }));
		}
	}, 50);
} else if (args[0] === 'network') {
	console.log(JSON.stringify([{ Name: 'proxy', Id: 'network', Containers: Object.fromEntries(state.containers.map(item => [item.Id, {}])) }]));
} else {
	console.log(JSON.stringify(state.containers));
}
`, { mode: 0o700 });
	const setState = (revision, containers) => {
		Fs.writeFileSync(fixture + '.tmp', JSON.stringify({ revision, containers }));
		Fs.renameSync(fixture + '.tmp', fixture);
	};
	const manualCollision = container('collision', 'manual.test');
	const wildcardCollision = container('wildcard', 'app.reserved.test');
	setState(1, [manualCollision, wildcardCollision]);
	const proxy = await start({ data: folder, routes_file: manual, docker_routes_file: generated });
	t.after(async () => {
		await proxy.stop();
		Fs.rmSync(folder, { recursive: true, force: true });
	});
	const child = Child.spawn(process.execPath, [Path.join(__dirname, '../scripts/docker-watch.js'), 'proxy', generated], {
		env: { ...process.env, PATH: folder + Path.delimiter + process.env.PATH, DOCKER_FIXTURE: fixture },
		stdio: ['ignore', 'ignore', 'pipe']
	});
	let output = '';
	child.stderr.on('data', chunk => output += chunk);
	const exited = new Promise(resolve => child.once('exit', resolve));
	t.after(async () => {
		child.kill();
		await exited;
	});
	await until(() => Fs.existsSync(generated));
	const read = async () => (await request({ socketPath: proxy.config.control, path: '/routes' })).json;
	Assert.deepEqual((await read()).map(route => route.id), ['manual']);

	const shop = container('shop', 'unused-label.test');
	shop.Config.Env = ['PROXY_HOST=http://shop.test', 'PROXY_PORT=8000', 'PROXY_LOGS=true'];
	setState(2, [manualCollision, wildcardCollision, shop]);
	await until(async () => (await read()).some(route => route.target === 'http://shop:8000'));
	let active = await read();
	Assert.equal(active.length, 2);
	Assert.equal(active.find(route => route.hosts.includes('shop.test')).accesslog, true);
	Assert.equal(active.find(route => route.id === 'manual').target, 'http://manual:8000');
	Assert.equal(proxy.routes.lookup('app.reserved.test').route.id, 'manual');

	setState(3, []);
	await until(async () => (await read()).length === 1);
	active = await read();
	Assert.equal(active[0].id, 'manual');
	Assert.equal(Fs.readFileSync(manual, 'utf8'), original);
	Assert.match(output, /Published 0 discovered routes/);
});
