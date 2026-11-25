'use strict';

const Test = require('node:test');
const Assert = require('node:assert/strict');
const Fs = require('node:fs');
const Path = require('node:path');
const { edge: start, tmpdir } = require('./helpers');

Test('certificate states', async function(t) {

	const edge = await start({ dns_zone: 'acme.code.test', precheck: true }, [
		{ id: 'clients', hosts: ['*.clientes.invalid'], target: 'http://127.0.0.1:9', tls: 'auto' },
		{ id: 'shop', hosts: ['shop.invalid'], target: 'http://127.0.0.1:9', tls: 'auto' },
		{ id: 'plain', hosts: ['plain.invalid'], target: 'http://127.0.0.1:9' }
	]);
	edge.manager.stop();
	t.after(() => edge.stop());

	await edge.manager.sync();

	// A wildcard waits for its CNAME before anything is asked of Let's Encrypt
	const wildcard = edge.manager.status.get('*.clientes.invalid');
	Assert.equal(wildcard.state, 'waiting-dns');
	Assert.equal(wildcard.failures, 0);
	Assert.deepEqual(wildcard.record, edge.manager.record('*.clientes.invalid'));
	Assert.equal(wildcard.record.name, '_acme-challenge.clientes.invalid');

	// A failed request waits before the next try (the ACME server of the tests does not exist)
	const shop = edge.manager.status.get('shop.invalid');
	Assert.equal(shop.state, 'error');
	Assert.equal(shop.failures, 1);
	Assert.ok(shop.next - Date.now() > 4 * 60000);

	// Nothing is tried again before its time
	await edge.manager.sync();
	Assert.equal(edge.manager.status.get('shop.invalid').failures, 1);

	// Routes without TLS have no state
	Assert.equal(edge.manager.status.has('plain.invalid'), false);

	// Code reads the same states from the disk
	const saved = JSON.parse(Fs.readFileSync(Path.join(edge.config.data, 'status.json'), 'utf8'));
	Assert.equal(saved['*.clientes.invalid'].state, 'waiting-dns');
	Assert.equal(typeof saved['shop.invalid'].next, 'string');
});

// From --staging to --production: the test certificates go at once, the real ones stay until their renewal
Test('staging certificates are replaced on the real server', async function(t) {

	const Child = require('node:child_process');
	const data = tmpdir();
	const folder = Path.join(data, 'certs');
	Fs.mkdirSync(folder, { recursive: true });
	const make = function(host, issuer) {
		Child.execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', Path.join(folder, host + '.key'), '-out', Path.join(folder, host + '.crt'), '-days', '80', '-subj', '/CN=' + issuer, '-addext', 'subjectAltName=DNS:' + host], { stdio: 'ignore' });
	};
	make('test.invalid', '(STAGING) Fake Bulgur');
	make('real.invalid', 'Fake Real CA');

	const routes = [{ id: 'a', hosts: ['test.invalid'], target: 'http://127.0.0.1:9', tls: 'auto' }, { id: 'b', hosts: ['real.invalid'], target: 'http://127.0.0.1:9', tls: 'auto' }];

	const staging = await start({ data, acme: 'https://acme-staging-v02.api.letsencrypt.org/directory' }, routes);
	staging.manager.stop();
	Assert.equal(staging.certs.items.get('test.invalid').staging, true);
	Assert.equal(staging.certs.items.get('real.invalid').staging, false);
	await staging.manager.sync();
	Assert.equal(staging.manager.status.get('test.invalid').state, 'valid');
	await staging.stop();

	// The ACME server of the helper is the "real" one here; it does not exist, so the request fails
	const real = await start({ data }, routes);
	real.manager.stop();
	t.after(() => real.stop());
	await real.manager.sync();
	Assert.equal(real.manager.status.get('test.invalid').state, 'error');
	Assert.equal(real.manager.status.get('real.invalid').state, 'valid');
});

Test('certificate retry deadlines survive a restart', async function(t) {
	const data = tmpdir();
	const routes = [{ id: 'shop', hosts: ['shop.invalid'], target: 'http://127.0.0.1:9', tls: 'auto' }];
	const first = await start({ data }, routes);
	first.manager.stop();
	await first.manager.sync();
	const previous = first.manager.status.get('shop.invalid');
	Assert.equal(previous.failures, 1);
	await first.stop();

	const restarted = await start({ data });
	t.after(async () => {
		await restarted.stop();
		Fs.rmSync(data, { recursive: true, force: true });
	});
	restarted.manager.stop();
	await restarted.manager.sync();
	Assert.equal(restarted.manager.status.get('shop.invalid').next, previous.next);
	Assert.equal(restarted.manager.status.get('shop.invalid').failures, previous.failures);
});

Test('an invalid custom certificate is diagnosed without disabling another site', async function(t) {
	const { backend: makebackend, request, selfsigned } = require('./helpers');
	const data = tmpdir();
	const backend = await makebackend();
	const custom = Path.join(data, 'custom');
	const cert = selfsigned(custom, 'good', ['good.test']);
	Fs.renameSync(Path.join(custom, 'good.crt'), Path.join(custom, 'good.pem'));
	Fs.writeFileSync(Path.join(custom, 'bad.test.crt'), cert.cert);
	Fs.writeFileSync(Path.join(custom, 'wrong-name.test.crt'), cert.cert);
	Fs.writeFileSync(Path.join(custom, 'wrong-name.test.key'), cert.key);
	selfsigned(custom, 'plain', ['plain.test']);
	const target = 'http://127.0.0.1:' + backend.port;
	const edge = await start({ data }, [
		{ id: 'good', hosts: ['good.test'], target, tls: 'custom' },
		{ id: 'bad', hosts: ['bad.test'], target, tls: 'custom' },
		{ id: 'wrong-name', hosts: ['wrong-name.test'], target, tls: 'custom' },
		{ id: 'plain', hosts: ['plain.test'], target, tls: 'off' }
	]);
	t.after(async () => {
		await edge.stop();
		backend.close();
		Fs.rmSync(data, { recursive: true, force: true });
	});
	edge.manager.stop();
	const events = [];
	edge.log = message => events.push(message);
	await edge.manager.sync();
	await edge.manager.sync();
	const status = await request({ socketPath: edge.config.control, path: '/status' });
	Assert.equal(status.json.hosts['good.test'].state, 'valid');
	Assert.equal(status.json.hosts['bad.test'].state, 'error');
	Assert.match(status.json.hosts['bad.test'].error, /matching .key/);
	Assert.match(status.json.hosts['wrong-name.test'].error, /wrong-name\.test\.crt does not cover this hostname/);
	Assert.equal(status.json.hosts['plain.test'], undefined);
	Assert.equal((await request({ port: edge.ports.http, host: 'plain.test' })).status, 200);
	await Assert.rejects(request({ port: edge.ports.https, secure: true, host: 'plain.test', servername: 'plain.test' }));
	Assert.equal(events.filter(message => message.includes('bad.test')).length, 1);
	Assert.equal((await request({ port: edge.ports.http, host: 'bad.test' })).status, 503);
	Assert.equal((await request({ port: edge.ports.https, secure: true, host: 'good.test', servername: 'good.test', ca: cert.cert })).status, 200);
});

Test('operational events can be written to their own daily file', async function(t) {
	const AccessLog = require('../lib/accesslog');
	const folder = tmpdir();
	t.after(() => Fs.rmSync(folder, { recursive: true, force: true }));
	const events = new AccessLog.Events(folder);
	events.write('Certificates: sample.test needs a custom certificate');
	await events.close();
	const [file] = Fs.readdirSync(folder);
	Assert.match(file, /^edge-\d{4}-\d{2}-\d{2}\.log$/);
	Assert.match(Fs.readFileSync(Path.join(folder, file), 'utf8'), /sample\.test needs a custom certificate/);
});

Test('explicit TLS paths share a wildcard without changing other routes', async function(t) {
	const { backend: makebackend, request, selfsigned } = require('./helpers');
	const data = tmpdir();
	const backend = await makebackend();
	let edge;
	t.after(async () => {
		await edge?.stop();
		backend.close();
		Fs.rmSync(data, { recursive: true, force: true });
	});
	const root = Path.join(data, 'operator-tls');
	const wildcard = selfsigned(Path.join(root, 'shared'), 'wildcard', ['*.apps.test']);
	selfsigned(root, 'other', ['outside.test']);
	const legacy = selfsigned(Path.join(data, 'custom'), 'legacy', ['broken.apps.test', 'legacy.apps.test']);
	Fs.renameSync(Path.join(root, 'shared', 'wildcard.key'), Path.join(root, 'shared', 'private-key.pem'));
	Fs.symlinkSync(Path.join(data, 'custom', 'legacy.key'), Path.join(root, 'escaped.key'));

	const files = { cert_file: 'shared/wildcard.crt', key_file: 'shared/private-key.pem' };
	const target = 'http://127.0.0.1:' + backend.port;
	const route = (id, host, paths) => ({ id, hosts: [host], tls: 'custom', target, ...paths });
	const previous = process.env.EDGE_CUSTOM_CERTS;
	process.env.EDGE_CUSTOM_CERTS = JSON.stringify({ beta: files, alpha: { ...files, key_file: 'unset.key' } });
	try {
		edge = await start({ data, custom_cert_dir: root }, [
			route('alpha', 'alpha.apps.test', files),
			route('beta', 'beta.apps.test'),
			route('broken', 'broken.apps.test', { ...files, key_file: 'missing.key' }),
			route('wrong', 'wrong.test', files),
			route('mismatch', 'mismatch.apps.test', { ...files, key_file: 'other.key' }),
			route('escaped', 'escaped.apps.test', { ...files, key_file: 'escaped.key' }),
			route('legacy', 'legacy.apps.test')
		]);
	} finally {
		if (previous === undefined)
			delete process.env.EDGE_CUSTOM_CERTS;
		else
			process.env.EDGE_CUSTOM_CERTS = previous;
	}
	edge.manager.stop();
	await edge.manager.sync();
	const { hosts } = (await request({ socketPath: edge.config.control, path: '/status' })).json;
	for (const host of ['alpha.apps.test', 'beta.apps.test', 'legacy.apps.test']) {
		Assert.equal(hosts[host].state, 'valid');
		const ca = host.startsWith('legacy') ? legacy.cert : wildcard.cert;
		Assert.equal((await request({ port: edge.ports.https, secure: true, host, servername: host, ca })).status, 200);
	}
	Assert.match(hosts['broken.apps.test'].error, /file is missing/);
	Assert.match(hosts['wrong.test'].error, /does not cover/);
	Assert.match(hosts['mismatch.apps.test'].error, /key does not match/);
	Assert.match(hosts['escaped.apps.test'].error, /stay inside/);
	Assert.equal((await request({ port: edge.ports.http, host: 'broken.apps.test' })).status, 503);

	const update = await request({
		socketPath: edge.config.control, method: 'PUT', path: '/routes/broken',
		body: JSON.stringify(route('broken', 'broken.apps.test', files))
	});
	Assert.equal(update.status, 200);
	Assert.equal((await request({
		port: edge.ports.https, secure: true, host: 'broken.apps.test', servername: 'broken.apps.test', ca: wildcard.cert
	})).status, 200);
});
