'use strict';

const Test = require('node:test');
const Assert = require('node:assert/strict');
const Fs = require('node:fs');
const Path = require('node:path');
const Hosts = require('../lib/hosts');
const Routes = require('../lib/routes');
const Config = require('../lib/config');
const { tmpdir } = require('./helpers');

Test('host names', function() {
	Assert.equal(Hosts.valid('eshop.totaljs.es'), true);
	Assert.equal(Hosts.valid('*.clientes.totaljs.es', true), true);
	Assert.equal(Hosts.valid('*.clientes.totaljs.es', false), false);
	Assert.equal(Hosts.valid('*.es', true), false);
	Assert.equal(Hosts.valid('a.*.es', true), false);
	Assert.equal(Hosts.valid('-eshop.es'), false);
	Assert.equal(Hosts.valid('eshop-.es'), false);
	Assert.equal(Hosts.valid('localhost'), false);
	Assert.equal(Hosts.valid('10.0.0.1'), false);
	Assert.equal(Hosts.valid('a_b.es'), false);
	Assert.equal(Hosts.valid('x'.repeat(64) + '.es'), false);
	Assert.equal(Hosts.fromheader('Eshop.Totaljs.ES:8443'), 'eshop.totaljs.es');
	Assert.equal(Hosts.fromheader('eshop.totaljs.es.'), 'eshop.totaljs.es');
	Assert.equal(Hosts.fromheader('[::1]:80'), '');
	Assert.equal(Hosts.fromheader('bad host.es'), '');
	Assert.equal(Hosts.wildcard('a.b.es'), '*.b.es');
	Assert.equal(Hosts.base('*.b.es'), 'b.es');
});

Test('route checks', function() {
	const base = { id: 'eshop', hosts: ['eshop.es'], target: 'http://eshop:8000' };
	const route = Routes.validate(Object.assign({}, base, { hosts: 'Eshop.es, www2.eshop.es', redirects: ['www.eshop.es'] }));
	Assert.deepEqual(route.hosts, ['eshop.es', 'www2.eshop.es']);
	Assert.equal(route.target, 'http://eshop:8000');
	Assert.equal(route.https, true);
	Assert.equal(route.hsts, false);
	// Without its own upload limit the route takes the one of the config
	Assert.equal(route.maxupload, undefined);
	Assert.equal(route.tls, 'off');

	const bad = [
		{ id: '../x' },
		{ hosts: [] },
		{ hosts: ['localhost'] },
		{ target: 'https://eshop:8000' },
		{ target: 'http://eshop:8000/path' },
		{ target: 'http://user:pass@eshop:8000' },
		{ target: 'file:///etc/passwd' },
		{ redirects: ['eshop.es'] },
		{ redirects: ['*.eshop.es'] },
		{ hosts: ['*.app.eshop.es'], redirects: ['www.eshop.es'] },
		{ maxupload: 0 },
		{ tls: 'yes' },
		{ tls: 'acme' }
	];

	for (const item of bad)
		Assert.throws(() => Routes.validate(Object.assign({}, base, item)), err => err.status === 400, JSON.stringify(item));
});

Test('route table', function() {
	const folder = tmpdir();
	const routes = new Routes(Path.join(folder, 'routes.json'));
	routes.load();

	routes.set({ id: 'eshop', hosts: ['eshop.es', '*.clientes.eshop.es'], redirects: ['www.eshop.es'], target: 'http://eshop:8000', tls: 'auto' });

	Assert.equal(routes.lookup('eshop.es').route.id, 'eshop');
	Assert.equal(routes.lookup('www.eshop.es').redirect, true);
	Assert.equal(routes.lookup('ana.clientes.eshop.es').route.id, 'eshop');
	Assert.equal(routes.lookup('a.ana.clientes.eshop.es'), null);
	Assert.equal(routes.lookup('clientes.eshop.es'), null);
	Assert.deepEqual(routes.tlshosts().map(item => item.host), ['eshop.es', '*.clientes.eshop.es', 'www.eshop.es']);

	Assert.throws(() => routes.set({ id: 'other', hosts: ['www.eshop.es'], target: 'http://other:8000' }), err => err.status === 409);

	// Stored without the runtime fields, and loaded again
	const stored = JSON.parse(Fs.readFileSync(Path.join(folder, 'routes.json'), 'utf8'));
	Assert.equal(stored[0].$target, undefined);
	const again = new Routes(Path.join(folder, 'routes.json'));
	again.load();
	Assert.equal(again.lookup('eshop.es').route.$target.port, 8000);

	Assert.equal(routes.remove('eshop'), true);
	Assert.equal(routes.lookup('eshop.es'), null);
	Assert.equal(routes.remove('eshop'), false);
});

Test('config file', function() {
	const folder = tmpdir();
	const file = Path.join(folder, 'config');
	Fs.writeFileSync(file, '// comment\nemail : a@b.es\nacme : https://acme.example.com/dir\nhttp : 8080\nprecheck : false\ndns_zone : ACME.Example.com\ndata : store\n');
	const config = Config.load(file);
	Assert.equal(config.email, 'a@b.es');
	Assert.equal(config.acme, 'https://acme.example.com/dir');
	Assert.equal(config.http, 8080);
	Assert.equal(config.precheck, false);
	Assert.equal(config.dns_zone, 'acme.example.com');
	Assert.equal(config.data, Path.join(folder, 'store'));
	Assert.equal(config.control, Path.join(folder, 'control/proxy.sock'));

	Fs.writeFileSync(file, 'emial : a@b.es\n');
	Assert.throws(() => Config.load(file), /Unknown key/);
});
