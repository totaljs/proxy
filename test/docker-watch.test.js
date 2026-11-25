'use strict';

const Test = require('node:test');
const Assert = require('node:assert/strict');
const Fs = require('node:fs');
const Path = require('node:path');
const Child = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { tmpdir, edge: start, request } = require('./helpers');
const { snapshot, publish } = require('../scripts/docker-watch');

function container(id, host, network = 'network') {
	return {
		Id: id, Name: '/' + id, State: { Running: true },
		Config: { Labels: { 'edge.host': host, 'edge.port': '8000' } },
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
});

Test('Docker network events update Edge without overriding manual routes', { timeout: 26000 }, async function(t) {
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
	const edge = await start({ data: folder, routes_file: manual, docker_routes_file: generated });
	t.after(async () => {
		await edge.stop();
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
	const read = async () => (await request({ socketPath: edge.config.control, path: '/routes' })).json;
	Assert.deepEqual((await read()).map(route => route.id), ['manual']);

	setState(2, [manualCollision, wildcardCollision, container('shop', 'shop.test')]);
	await until(async () => (await read()).some(route => route.target === 'http://shop:8000'));
	let active = await read();
	Assert.equal(active.length, 2);
	Assert.equal(active.find(route => route.id === 'manual').target, 'http://manual:8000');
	Assert.equal(edge.routes.lookup('app.reserved.test').route.id, 'manual');

	setState(3, []);
	await until(async () => (await read()).length === 1);
	active = await read();
	Assert.equal(active[0].id, 'manual');
	Assert.equal(Fs.readFileSync(manual, 'utf8'), original);
	Assert.match(output, /Published 0 discovered routes/);
});
