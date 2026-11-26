'use strict';

// End to end against Pebble, the test ACME server of Let's Encrypt. Start it first with test/pebble.sh;
// without it this test is skipped.

const Test = require('node:test');
const Assert = require('node:assert/strict');
const Fs = require('node:fs');
const Path = require('node:path');
const Https = require('node:https');
const Dgram = require('node:dgram');
const Net = require('node:net');
const Tls = require('node:tls');
const Crypto = require('node:crypto');
const Resolver = require('node:dns').promises.Resolver;
const Dns = require('../lib/dns');
const { proxy: start, backend: makebackend, request, tmpdir } = require('./helpers');

const FOLDER = Path.join(__dirname, 'pebble');
const DIRECTORY = 'https://localhost:14000/dir';

function get(url, ca) {
	return new Promise((resolve, reject) => {
		Https.get(url, { ca, timeout: 3000, agent: false, headers: { 'user-agent': 'totaljs-proxy-test' } }, res => {
			const chunks = [];
			res.on('data', chunk => chunks.push(chunk));
			res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
		}).on('error', reject).on('timeout', function() {
			this.destroy(new Error('timeout'));
		});
	});
}

async function ready() {
	try {
		const ca = Fs.readFileSync(Path.join(FOLDER, 'minica.pem'));
		const host = Fs.readFileSync(Path.join(FOLDER, 'host'), 'utf8').trim();
		const res = await get(DIRECTORY, ca);
		return res.status === 200 ? { ca, host } : null;
	} catch {
		return null;
	}
}

// Stands in for the public DNS: every name points to this machine, and _acme-challenge
// names are a CNAME to the proxy zone, answered with what the proxy DNS server says.
function resolver(host, proxy) {
	const lookup = new Resolver();
	lookup.setServers(['127.0.0.1:' + proxy.ports.dns]);
	const answer = async function(message) {
		const query = Dns.parse(message);
		if (!query || query.error)
			return null;
		let answers = [];
		if (query.type === Dns.TYPE.A)
			answers.push(Dns.record(Dns.POINTER, Dns.TYPE.A, 0, Buffer.from(host.split('.').map(Number))));
		if (query.type === Dns.TYPE.TXT && query.name.startsWith('_acme-challenge.')) {
			const target = proxy.manager.record(query.name.substring(16)).value;
			answers.push(Dns.record(Dns.POINTER, Dns.TYPE.CNAME, 0, Dns.writename(target)));
			try {
				for (const value of await lookup.resolveTxt(target))
					answers.push(Dns.record(Dns.writename(target), Dns.TYPE.TXT, 0, Dns.txt(value.join(''))));
			} catch {}
		}
		return Dns.build(query, Dns.RCODE.NOERROR, answers, [], true);
	};

	const udp = Dgram.createSocket('udp4');
	udp.on('message', async (message, info) => {
		const output = await answer(message);
		output && udp.send(output, info.port, info.address);
	});

	const tcp = Net.createServer(socket => {
		let buffer = Buffer.alloc(0);
		socket.on('error', () => {});
		socket.on('data', async chunk => {
			buffer = Buffer.concat([buffer, chunk]);
			while (buffer.length >= 2 && buffer.length >= 2 + buffer.readUInt16BE(0)) {
				const message = buffer.subarray(2, 2 + buffer.readUInt16BE(0));
				buffer = buffer.subarray(2 + message.length);
				const output = await answer(message);
				if (output) {
					const size = Buffer.alloc(2);
					size.writeUInt16BE(output.length);
					socket.write(Buffer.concat([size, output]));
				}
			}
		});
	});

	return new Promise(resolve => udp.bind(8053, '0.0.0.0', () => tcp.listen(8053, '0.0.0.0', () => resolve({
		close() {
			udp.close();
			tcp.close();
		}
	}))));
}

Test('certificates from Pebble over HTTP and DNS', { timeout: 180000 }, async function(t) {

	const pebble = await ready();
	if (!pebble) {
		if (process.env.PEBBLE_REQUIRED === '1')
			Assert.fail('Pebble must be available for the release test');
		t.skip('Pebble is not running: start it with test/pebble.sh');
		return;
	}

	const ca = Path.join(FOLDER, 'minica.pem');
	const backend = await makebackend();
	const proxy = await start({ http: 5002, dns: 0, dns_zone: 'acme.proxy.test', acme: DIRECTORY, acme_ca: ca }, [
		{ id: 'shop', hosts: ['shop.proxy.test', '*.clientes.proxy.test'], target: 'http://127.0.0.1:' + backend.port, cert: 'auto' },
		{ id: 'local', hosts: ['local.proxy.test'], target: 'http://127.0.0.1:' + backend.port, cert: 'off' }
	]);
	const dns = await resolver(pebble.host, proxy);

	t.after(async () => {
		dns.close();
		await proxy.stop();
		backend.close();
	});

	const valid = async function(host, previous) {
		for (let i = 0; i < 120; i++) {
			const status = proxy.manager.status.get(host);
			const item = proxy.certs.items.get(host);
			if (status && status.state === 'valid' && item && item !== previous)
				return item;
			if (status && status.state === 'error' && !previous)
				throw new Error(host + ': ' + status.error);
			await new Promise(resolve => setTimeout(resolve, 500));
		}
		throw new Error(host + ' took too long');
	};

	Assert.equal((await request({ port: proxy.ports.http, host: 'local.proxy.test' })).status, 200);
	Assert.equal(proxy.manager.status.has('local.proxy.test'), false);
	const shop = await valid('shop.proxy.test');
	await valid('*.clientes.proxy.test');

	// The certificates chain to the root of Pebble, and the proxy serves them by SNI
	const root = (await get('https://localhost:15000/roots/0', pebble.ca)).body;

	for (const name of ['shop.proxy.test', 'ana.clientes.proxy.test']) {
		const res = await request({ port: proxy.ports.https, secure: true, servername: name, host: name, ca: root, path: '/hello' });
		Assert.equal(res.status, 200, name);
		Assert.equal(res.json.url, '/hello');
		Assert.equal(res.json.headers['x-forwarded-proto'], 'https');
	}

	// Saved on disk, the key readable only by the owner
	const bundle = Path.join(proxy.config.data, 'certs', '_wildcard.clientes.proxy.test.json');
	Assert.equal(Fs.statSync(bundle).mode & 0o777, 0o600);
	Assert.equal(Fs.statSync(Path.join(proxy.config.data, 'acme', 'account.key')).mode & 0o777, 0o600);

	// HTTP now goes to HTTPS
	const redirect = await request({ port: proxy.ports.http, host: 'shop.proxy.test', path: '/x' });
	Assert.equal(redirect.status, 301);

	// Renewing on request gives a new certificate, served right away
	proxy.manager.renew('shop.proxy.test');
	const renewed = await valid('shop.proxy.test', shop);
	Assert.notEqual(renewed, shop);
	Assert.equal((await request({ port: proxy.ports.https, secure: true, servername: 'shop.proxy.test', host: 'shop.proxy.test', ca: root })).status, 200);

	// The challenges are cleaned up
	Assert.equal(proxy.challenges.size, 0);
	Assert.equal(proxy.dns.records.size, 0);

	// Restore a stopped instance's data under a different path and start a fresh process state.
	const account = { kid: proxy.acme.kid, thumbprint: proxy.acme.thumbprint };
	const bundleFile = Path.join(proxy.config.data, 'certs', 'shop.proxy.test.json');
	const fingerprint = new Crypto.X509Certificate(JSON.parse(Fs.readFileSync(bundleFile, 'utf8')).cert).fingerprint256;
	await proxy.manager.running;
	await proxy.stop();
	const restoredData = tmpdir();
	let restored;
	t.after(async () => {
		if (restored)
			await restored.stop();
		Fs.rmSync(restoredData, { recursive: true, force: true });
	});
	Fs.cpSync(proxy.config.data, restoredData, { recursive: true });
	restored = await start({ data: restoredData, acme: DIRECTORY, acme_ca: ca });

	Assert.deepEqual(restored.routes.list(), proxy.routes.list());
	await restored.acme.init();
	Assert.equal(restored.acme.kid, account.kid);
	Assert.equal(restored.acme.thumbprint, account.thumbprint);
	Assert.equal(Fs.statSync(Path.join(restoredData, 'acme', 'account.key')).mode & 0o777, 0o600);

	const restoredFingerprint = await new Promise((resolve, reject) => {
		const socket = Tls.connect({ host: '127.0.0.1', port: restored.ports.https, servername: 'shop.proxy.test', ca: root }, () => {
			resolve(socket.getPeerCertificate().fingerprint256);
			socket.end();
		});
		socket.on('error', reject);
	});
	Assert.equal(restoredFingerprint, fingerprint);
});
