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
	Assert.equal(route.cert, 'off');

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
		{ cert: 'yes' },
		{ cert: 'acme' }
	];

	for (const item of bad)
		Assert.throws(() => Routes.validate(Object.assign({}, base, item)), err => err.status === 400, JSON.stringify(item));
});

Test('sites folder', function() {
	const folder = Path.join(tmpdir(), 'sites');
	const routes = new Routes(folder);
	// No folder yet: no sites
	routes.load();
	Assert.equal(routes.items.size, 0);

	Fs.mkdirSync(folder);
	Fs.writeFileSync(Path.join(folder, 'eshop.es.json'), JSON.stringify({ hosts: ['eshop.es', '*.clientes.eshop.es'], redirects: ['www.eshop.es'], target: 'eshop:8000', cert: 'auto' }));
	Assert.equal(routes.scan(), true);

	Assert.equal(routes.lookup('eshop.es').route.id, 'eshop.es');
	Assert.equal(routes.lookup('www.eshop.es').redirect, true);
	Assert.equal(routes.lookup('ana.clientes.eshop.es').route.id, 'eshop.es');
	Assert.equal(routes.lookup('a.ana.clientes.eshop.es'), null);
	Assert.equal(routes.lookup('clientes.eshop.es'), null);
	Assert.deepEqual(routes.tlshosts().map(item => item.host), ['eshop.es', '*.clientes.eshop.es', 'www.eshop.es']);
	Assert.equal(routes.lookup('eshop.es').route.$target.port, 8000);

	// As the workers get them: without the runtime fields, and the same sites again
	const list = routes.list();
	Assert.equal(list[0].$target, undefined);
	Assert.equal(list[0].target, 'http://eshop:8000');
	const worker = new Routes(folder);
	worker.assign(list);
	Assert.equal(worker.lookup('ana.clientes.eshop.es').route.id, 'eshop.es');

	Assert.equal(routes.scan(), false);
	Fs.rmSync(Path.join(folder, 'eshop.es.json'));
	Assert.equal(routes.scan(), true);
	Assert.equal(routes.lookup('eshop.es'), null);
});

Test('site files: the simple form, mistakes and conflicts', function() {
	const folder = Path.join(tmpdir(), 'sites');
	Fs.mkdirSync(folder);
	const write = (name, value) => {
		// Another file each time, as an editor that saves: the size alone may stay the same
		Fs.writeFileSync(Path.join(folder, name + '.tmp'), typeof value === 'string' ? value : JSON.stringify(value));
		Fs.renameSync(Path.join(folder, name + '.tmp'), Path.join(folder, name));
	};
	const errors = [];
	const onError = (err, filename) => errors.push(Path.basename(filename) + ': ' + err.message);
	const routes = new Routes(folder);

	write('totaljs.com.json', { hosts: ['totaljs.com', 'www.totaljs.com'], target: '172.18.0.5:8000', logs: true });
	routes.load(onError);
	const site = routes.lookup('www.totaljs.com').route;
	Assert.equal(site.id, 'totaljs.com');
	Assert.equal(site.target, 'http://172.18.0.5:8000');
	Assert.deepEqual(site.$target, { hostname: '172.18.0.5', port: 8000 });
	Assert.equal(site.logs, true);
	Assert.equal(routes.scan(onError), false);

	// A file with a mistake: reported once, and the site keeps what it had
	write('totaljs.com.json', '{ "hosts": ["totaljs.com"], ');
	Assert.equal(routes.scan(onError), true);
	Assert.match(errors.pop(), /^totaljs\.com\.json: Not valid JSON/);
	Assert.equal(routes.lookup('www.totaljs.com').route.id, 'totaljs.com');
	Assert.equal(routes.scan(onError), false);
	Assert.equal(errors.length, 0);

	write('totaljs.com.json', { hosts: ['totaljs.com'], target: 'http://172.18.0.5:9000', logs: 'yes' });
	routes.scan(onError);
	Assert.match(errors.pop(), /logs must be true or false/);
	Assert.equal(routes.lookup('totaljs.com').route.$target.port, 8000);

	write('totaljs.com.json', { hosts: ['totaljs.com'], target: 'http://172.18.0.5:9000' });
	Assert.equal(routes.scan(onError), true);
	Assert.equal(routes.lookup('totaljs.com').route.$target.port, 9000);
	Assert.equal(routes.lookup('www.totaljs.com'), null);

	// A host name belongs to one site: the other file is refused, the rest of it too
	write('other.json', { hosts: ['other.test', 'totaljs.com'], target: 'other:80' });
	routes.scan(onError);
	Assert.match(errors.pop(), /^other\.json: totaljs\.com already belongs to the site totaljs\.com/);
	Assert.equal(routes.lookup('other.test'), null);
	Assert.equal(routes.lookup('totaljs.com').route.id, 'totaljs.com');

	// Not sites: other files of the folder
	write('notes.txt', 'x');
	write('.hidden.json', '{}');
	Assert.equal(routes.scan(onError), false);
	Assert.equal(errors.length, 0);

	Fs.rmSync(Path.join(folder, 'totaljs.com.json'));
	Assert.equal(routes.scan(onError), true);
	// The name is free now: the other site takes it
	Assert.equal(routes.lookup('totaljs.com').route.id, 'other');
	Assert.equal(routes.lookup('other.test').route.id, 'other');
});

Test('config file', function() {
	const folder = tmpdir();
	const data = Path.join(folder, 'store');
	Fs.mkdirSync(data);

	// Without a file: the defaults, and the folders next to the data folder
	const defaults = Config.load(data);
	Assert.equal(defaults.http, 80);
	Assert.equal(defaults.workers, 1);
	Assert.equal(defaults.data, data);
	Assert.equal(defaults.sites, Path.join(data, 'sites'));
	Assert.equal(defaults.logs, Path.join(folder, 'logs'));
	Assert.equal(defaults.logs_maxsize, 100);
	Assert.equal(defaults.errors, Path.join(data, 'errors'));

	const file = Path.join(data, 'config.json');
	Fs.writeFileSync(file, JSON.stringify({ email: 'a@b.es', acme: 'https://acme.example.com/dir', http: 8080, precheck: false, dns_zone: 'ACME.Example.com', logs: 'store/logs', logs_maxsize: 5, headers: { 'X-Frame-Options': 'DENY' } }));
	const config = Config.load(data);
	Assert.equal(config.email, 'a@b.es');
	Assert.equal(config.acme, 'https://acme.example.com/dir');
	Assert.equal(config.http, 8080);
	Assert.equal(config.precheck, false);
	Assert.equal(config.dns_zone, 'acme.example.com');
	Assert.equal(config.logs, Path.join(data, 'logs'));
	Assert.equal(config.logs_maxsize, 5);
	Assert.deepEqual(config.headers, [['x-frame-options', 'DENY']]);
	Assert.deepEqual(Config.changed(defaults, config).sort(), ['acme', 'dns_zone', 'email', 'headers', 'http', 'logs', 'logs_maxsize', 'precheck']);

	// The control socket is gone: its keys are not taken in silence
	Fs.writeFileSync(file, JSON.stringify({ control: 'control/proxy.sock' }));
	Assert.throws(() => Config.load(data), /Unknown key in config\.json: control/);
	Fs.writeFileSync(file, JSON.stringify({ emial: 'a@b.es' }));
	Assert.throws(() => Config.load(data), /Unknown key in config\.json: emial/);
	Fs.writeFileSync(file, '{ "http": 80, }');
	Assert.throws(() => Config.load(data), /not valid JSON/);
	Fs.writeFileSync(file, JSON.stringify({ http: 'eighty' }));
	Assert.throws(() => Config.load(data), /"http" needs a number/);
	Fs.writeFileSync(file, JSON.stringify({ compress: 'yes' }));
	Assert.throws(() => Config.load(data), /"compress" needs true or false/);
	Fs.writeFileSync(file, JSON.stringify({ logs_maxsize: 0 }));
	Assert.throws(() => Config.load(data), /logs_maxsize/);
});

Test('host names that say http:// or https://', function() {
	const route = Routes.validate({ id: 'totaljs.com', hosts: ['https://Totaljs.com/', 'http://www.totaljs.com', 'api.totaljs.com', 'https://totaljs.com'], redirects: ['https://old.totaljs.com'], target: 'app:8000' });
	// The names without it, everywhere a name is used
	Assert.deepEqual(route.hosts, ['totaljs.com', 'www.totaljs.com', 'api.totaljs.com']);
	Assert.deepEqual(route.redirects, ['old.totaljs.com']);
	// https:// asks for a certificate, http:// never does, a name alone follows "cert" of the site (off)
	Assert.deepEqual(route.hosts.map(host => Routes.mode(route, host)), ['auto', 'off', 'off']);
	Assert.equal(Routes.mode(route, 'old.totaljs.com'), 'auto');
	// Written back as they were
	Assert.deepEqual(Routes.clean(route).hosts, ['https://totaljs.com', 'http://www.totaljs.com', 'api.totaljs.com']);
	Assert.deepEqual(Routes.clean(route).redirects, ['https://old.totaljs.com']);
	Assert.deepEqual(Routes.validate(Routes.clean(route)).$schemes, route.$schemes);

	// With "cert" of the site: the names alone follow it, http:// stays out, https:// uses the same certificate
	const custom = Routes.validate({ id: 'x', hosts: ['a.test', 'http://b.test', 'https://c.test'], target: 'app:8000', cert: 'custom' });
	Assert.deepEqual(custom.hosts.map(host => Routes.mode(custom, host)), ['custom', 'off', 'custom']);
	const auto = Routes.validate({ id: 'x', hosts: ['a.test', 'http://b.test'], target: 'app:8000', cert: 'auto' });
	Assert.deepEqual(auto.hosts.map(host => Routes.mode(auto, host)), ['auto', 'off']);

	const folder = Path.join(tmpdir(), 'sites');
	const routes = new Routes(folder);
	Fs.mkdirSync(folder);
	Fs.writeFileSync(Path.join(folder, 'totaljs.com.json'), JSON.stringify({ hosts: ['https://totaljs.com', 'http://www.totaljs.com'], target: 'app:8000' }));
	routes.load();
	Assert.equal(routes.lookup('totaljs.com').cert, 'auto');
	Assert.equal(routes.lookup('www.totaljs.com').cert, 'off');
	// Only the names that are served over HTTPS get a certificate
	Assert.deepEqual(routes.tlshosts().map(item => item.host), ['totaljs.com']);
	// A name belongs to one site, with or without a scheme
	const errors = [];
	Fs.writeFileSync(Path.join(folder, 'other.json'), JSON.stringify({ hosts: ['http://totaljs.com'], target: 'other:80' }));
	routes.scan(err => errors.push(err.message));
	Assert.match(errors.join(), /totaljs\.com already belongs to the site totaljs\.com/);
	Assert.equal(routes.lookup('totaljs.com').route.id, 'totaljs.com');

	for (const host of ['https://a.test:8443', 'https://a.test/path', 'ftp://a.test', 'https://'])
		Assert.throws(() => Routes.validate({ id: 'x', hosts: [host], target: 'app:8000' }), /Invalid host name|at least one host/, host);
});

Test('the certificate of a site is "cert"', function() {
	const base = { id: 'x', hosts: ['x.test'], target: 'app:8000' };
	Assert.equal(Routes.validate(base).cert, 'off');
	Assert.equal(Routes.validate({ ...base, cert: 'auto' }).cert, 'auto');
	Assert.equal(Routes.clean(Routes.validate({ ...base, cert: 'custom' })).cert, 'custom');
	Assert.throws(() => Routes.validate({ ...base, cert: 'yes' }), /cert must be one of: off, custom, auto/);
	// The name of before is not taken for "off" in silence
	Assert.throws(() => Routes.validate({ ...base, tls: 'auto' }), /"tls" is now "cert"/);
});

Test('a site that a container wrote never takes a name of another site', function() {
	const folder = Path.join(tmpdir(), 'sites');
	Fs.mkdirSync(folder);
	const write = (name, value) => Fs.writeFileSync(Path.join(folder, name + '.json'), JSON.stringify(value));
	const load = () => {
		const errors = [];
		const routes = new Routes(folder);
		routes.load((err, filename) => errors.push(Path.basename(filename) + ': ' + err.message));
		return { routes, errors };
	};

	// Written by hand, with a name that sorts last; a container whose file sorts first says the same names
	write('mysite', { hosts: ['example.com', 'www.example.com', '*.shop.example.com'], target: 'app:8000' });
	write('a.evil.test', { hosts: ['a.evil.test', 'example.com'], target: '172.18.0.9:80', docker: 'evil' });
	let { routes, errors } = load();
	Assert.equal(routes.lookup('example.com').route.id, 'mysite');
	Assert.equal(routes.lookup('www.example.com').route.id, 'mysite');
	// The whole site of the container is refused, not only the name
	Assert.equal(routes.lookup('a.evil.test'), null);
	Assert.match(errors.join('\n'), /a\.evil\.test\.json: example\.com already belongs to the site mysite/);

	// A name under the wildcard of a site written by hand
	write('a.evil.test', { hosts: ['admin.shop.example.com'], target: '172.18.0.9:80', docker: 'evil' });
	({ routes, errors } = load());
	Assert.equal(routes.lookup('admin.shop.example.com').route.id, 'mysite');
	Assert.match(errors.join('\n'), /admin\.shop\.example\.com is under \*\.shop\.example\.com of the site mysite/);

	// Between two containers: the first name of one is never one more name of the other
	write('a.evil.test', { hosts: ['a.evil.test', 'blog.test'], target: '172.18.0.9:80', docker: 'evil' });
	write('blog.test', { hosts: ['blog.test'], target: '172.18.0.5:80', docker: 'blog' });
	({ routes, errors } = load());
	Assert.equal(routes.lookup('blog.test').route.docker, 'blog');
	Assert.equal(routes.lookup('a.evil.test'), null);
	Assert.match(errors.join('\n'), /a\.evil\.test\.json: blog\.test already belongs to the site blog\.test/);

	// A site written by hand may have a name under its own or another wildcard, as before
	write('a.evil.test', { hosts: ['api.shop.example.com'], target: 'api:8000' });
	({ routes, errors } = load());
	Assert.equal(routes.lookup('api.shop.example.com').route.id, 'a.evil.test');
});
