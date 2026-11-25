'use strict';

const Test = require('node:test');
const Assert = require('node:assert/strict');
const Fs = require('node:fs');
const Path = require('node:path');
const Crypto = require('node:crypto');
const Child = require('node:child_process');
const X509 = require('../lib/x509');
const { tmpdir } = require('./helpers');

Test('certificate signing request checked by OpenSSL', function() {
	const key = Crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
	const hosts = ['eshop.totaljs.es', '*.clientes.totaljs.es'];
	const file = Path.join(tmpdir(), 'request.der');
	Fs.writeFileSync(file, X509.csr(hosts, key));

	const output = Child.spawnSync('openssl', ['req', '-in', file, '-inform', 'DER', '-noout', '-verify', '-text'], { encoding: 'utf8' });
	Assert.equal(output.status, 0, output.stderr);
	Assert.match(output.stdout + output.stderr, /verify OK/i);
	Assert.match(output.stdout, /CN\s*=\s*eshop\.totaljs\.es/);
	Assert.match(output.stdout, /DNS:eshop\.totaljs\.es, DNS:\*\.clientes\.totaljs\.es/);
	Assert.match(output.stdout, /ecdsa-with-SHA256/);
});

Test('a custom wildcard certificate wins over one of Let\'s Encrypt for its names', function() {
	const Certs = require('../lib/certs');
	const certs = new Certs('/nonexistent', '/nonexistent', () => {});
	const custom = { names: ['*.apps.test'], source: 'custom', notAfter: new Date(Date.now() + 86400000) };
	const acme = { names: ['a.apps.test'], source: 'acme', notAfter: new Date(Date.now() + 86400000) };
	certs.items.set('*.apps.test', custom);
	certs.items.set('a.apps.test', acme);
	Assert.equal(certs.find('a.apps.test'), custom);
	Assert.equal(certs.find('b.apps.test'), custom);
	certs.items.delete('*.apps.test');
	Assert.equal(certs.find('a.apps.test'), acme);
});

Test('ACME renewal publishes the complete pair before changing the active certificate', function(t) {
	const { selfsigned } = require('./helpers');
	const Certs = require('../lib/certs');
	const root = tmpdir();
	t.after(() => Fs.rmSync(root, { recursive: true, force: true }));
	const folder = Path.join(root, 'certs');
	const custom = Path.join(root, 'custom');
	const host = 'shop.example.test';
	const initial = selfsigned(Path.join(root, 'initial'), host, [host]);
	const renewed = selfsigned(Path.join(root, 'renewed'), host, [host]);
	const certs = new Certs(folder, custom);
	certs.save(host, initial.key, initial.cert);
	certs.load();
	const previous = certs.find(host);
	Assert.ok(previous);

	const file = Path.join(folder, host + '.json');
	Fs.unlinkSync(file);
	Fs.mkdirSync(file);
	Assert.throws(() => certs.save(host, renewed.key, renewed.cert));
	Assert.equal(certs.find(host), previous);
	Assert.equal(Fs.readdirSync(folder).some(name => name.endsWith('.tmp')), false);
	Fs.rmdirSync(file);

	certs.save(host, renewed.key, renewed.cert);
	Assert.equal(Fs.statSync(file).mode & 0o777, 0o600);
	const restarted = new Certs(folder, custom);
	restarted.load();
	Assert.deepEqual(restarted.find(host).context.context.getCertificate(), new Crypto.X509Certificate(renewed.cert).raw);
});
