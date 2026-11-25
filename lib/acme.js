'use strict';

// An ACME v2 client (RFC 8555) for Let's Encrypt and other ACME authorities.
// Account and certificate keys are ECDSA P-256; requests are signed with ES256.

const Fs = require('node:fs');
const Path = require('node:path');
const Https = require('node:https');
const Crypto = require('node:crypto');
const X509 = require('./x509');

// RFC 8555 asks every ACME client to send one
const USERAGENT = 'totaljs-proxy/' + require('../package.json').version + ' node/' + process.versions.node;

const b64u = value => Buffer.from(value).toString('base64url');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function newkey() {
	return Crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
}

function problem(res, what) {
	let type = '';
	let detail = '';
	try {
		const body = JSON.parse(res.body.toString('utf8'));
		type = body.type || '';
		detail = body.detail || '';
		if (body.subproblems && body.subproblems.length)
			detail += ' (' + body.subproblems.map(item => item.detail).join('; ') + ')';
	} catch {
		detail = res.body.toString('utf8').substring(0, 200);
	}
	const err = new Error(what + ' failed with ' + res.status + ': ' + (detail || type));
	err.type = type;
	return err;
}

// The reason a failed authorization gives
function reason(authz) {
	for (const challenge of authz.challenges || []) {
		if (challenge.error)
			return challenge.error.detail || challenge.error.type;
	}
	return 'no reason given';
}

class Acme {

	// options: { directory, email, folder, ca (PEM of the authority's TLS root, only for test servers), log }
	constructor(options) {
		this.url = options.directory;
		this.email = options.email || '';
		this.folder = options.folder;
		this.ca = options.ca || null;
		this.log = options.log || (() => {});
		this.nonces = [];
		this.directory = null;
		this.kid = null;
		this.pending = null;
	}

	request(url, method, body, headers) {
		return new Promise((resolve, reject) => {
			const uri = new URL(url);
			if (uri.protocol !== 'https:') {
				reject(new Error('ACME addresses must use HTTPS: ' + url));
				return;
			}
			headers = Object.assign({ 'user-agent': USERAGENT, 'accept-language': 'en' }, headers);
			const req = Https.request(uri, { method, headers, ca: this.ca || undefined, timeout: 30000, agent: false }, function(res) {
				const chunks = [];
				res.on('data', chunk => chunks.push(chunk));
				res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
				res.on('error', reject);
			});
			req.on('timeout', () => req.destroy(new Error('The ACME server took too long to answer')));
			req.on('error', reject);
			req.end(body);
		});
	}

	init() {
		if (this.kid)
			return Promise.resolve();
		if (!this.pending)
			this.pending = this.account().finally(() => this.pending = null);
		return this.pending;
	}

	async account() {

		Fs.mkdirSync(this.folder, { recursive: true, mode: 0o700 });

		const keyfile = Path.join(this.folder, 'account.key');
		const accountfile = Path.join(this.folder, 'account.json');

		let pem;
		try {
			pem = Fs.readFileSync(keyfile, 'utf8');
		} catch {
			pem = newkey().export({ type: 'pkcs8', format: 'pem' });
			Fs.writeFileSync(keyfile, pem, { mode: 0o600 });
		}

		this.key = Crypto.createPrivateKey(pem);

		const jwk = Crypto.createPublicKey(this.key).export({ format: 'jwk' });
		this.jwk = { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
		this.thumbprint = b64u(Crypto.createHash('sha256').update(JSON.stringify(this.jwk)).digest());

		const res = await this.request(this.url, 'GET');
		if (res.status !== 200)
			throw problem(res, 'Reading the ACME directory');

		this.directory = JSON.parse(res.body.toString('utf8'));

		if (this.directory.meta && this.directory.meta.externalAccountRequired)
			throw new Error('This ACME server needs an external account binding, which Proxy does not support yet');

		let saved = {};
		try {
			saved = JSON.parse(Fs.readFileSync(accountfile, 'utf8'));
		} catch {}

		if (saved.directory === this.url && saved.kid) {
			this.kid = saved.kid;
			return;
		}

		// Setting an ACME server in the config means accepting its terms of service
		const payload = { termsOfServiceAgreed: true };
		if (this.email)
			payload.contact = ['mailto:' + this.email];

		const account = await this.post(this.directory.newAccount, payload, true);
		if (!account.headers.location)
			throw new Error('The ACME server returned no account address');

		Fs.writeFileSync(accountfile, JSON.stringify({ directory: this.url, kid: account.headers.location }, null, '\t'), { mode: 0o600 });
		this.kid = account.headers.location;
		this.log('ACME: account ready at ' + new URL(this.url).host);
	}

	async nonce() {
		if (this.nonces.length)
			return this.nonces.pop();
		const res = await this.request(this.directory.newNonce, 'HEAD');
		const nonce = res.headers['replay-nonce'];
		if (!nonce)
			throw new Error('The ACME server sent no nonce');
		return nonce;
	}

	// payload null: POST-as-GET
	async post(url, payload, usejwk) {
		for (let attempt = 0; ; attempt++) {

			const header = { alg: 'ES256', nonce: await this.nonce(), url };
			if (usejwk)
				header.jwk = this.jwk;
			else
				header.kid = this.kid;

			const protect = b64u(JSON.stringify(header));
			const data = payload == null ? '' : b64u(JSON.stringify(payload));
			const signature = b64u(Crypto.sign('sha256', Buffer.from(protect + '.' + data), { key: this.key, dsaEncoding: 'ieee-p1363' }));
			const res = await this.request(url, 'POST', JSON.stringify({ protected: protect, payload: data, signature }), { 'content-type': 'application/jose+json' });

			if (res.headers['replay-nonce'])
				this.nonces.push(res.headers['replay-nonce']);

			if (res.status < 400)
				return res;

			const err = problem(res, 'The ACME request');
			if (err.type === 'urn:ietf:params:acme:error:badNonce' && attempt < 3)
				continue;
			throw err;
		}
	}

	async poll(url, ready, what, describe) {
		for (let i = 0; i < 90; i++) {
			const res = await this.post(url, null);
			const body = JSON.parse(res.body.toString('utf8'));
			if (ready(body))
				return body;
			if (body.status === 'invalid')
				throw new Error(what + ' was refused: ' + (describe ? describe(body) : (body.error && body.error.detail) || 'no reason given'));
			const after = parseInt(res.headers['retry-after'], 10);
			await wait(after > 0 && after <= 30 ? after * 1000 : 2000);
		}
		throw new Error(what + ' took too long');
	}

	// hosts: the names of one certificate.
	// handlers: { type(host) -> 'http-01' | 'dns-01', http: { set(token, keyauth), remove(token) }, dns: { set(name, value), remove(name, value) } }
	// For DNS, "name" is the identifier without "*.". Returns { key, cert } in PEM.
	async issue(hosts, handlers) {

		await this.init();

		const created = await this.post(this.directory.newOrder, { identifiers: hosts.map(value => ({ type: 'dns', value })) });
		const orderurl = created.headers.location;
		let order = JSON.parse(created.body.toString('utf8'));

		if (order.status === 'valid')
			throw new Error('The ACME server returned an order that was already finalized');

		const cleanup = [];

		try {
			for (const url of order.authorizations) {

				const authz = JSON.parse((await this.post(url, null)).body.toString('utf8'));
				if (authz.status === 'valid')
					continue;

				const name = authz.identifier.value;
				const host = (authz.wildcard ? '*.' : '') + name;
				const type = handlers.type(host);
				const challenge = authz.challenges.find(item => item.type === type);

				if (!challenge)
					throw new Error('The ACME server offers no ' + type + ' check for ' + host);

				const keyauth = challenge.token + '.' + this.thumbprint;

				if (type === 'http-01') {
					handlers.http.set(challenge.token, keyauth);
					cleanup.push(() => handlers.http.remove(challenge.token));
				} else {
					const value = b64u(Crypto.createHash('sha256').update(keyauth).digest());
					handlers.dns.set(name, value);
					cleanup.push(() => handlers.dns.remove(name, value));
				}

				await this.post(challenge.url, {});
				await this.poll(url, body => body.status === 'valid', 'The check of ' + host, reason);
			}

			order = await this.poll(orderurl, body => body.status === 'ready' || body.status === 'valid', 'The order');

			const key = newkey();

			if (order.status === 'ready') {
				await this.post(order.finalize, { csr: b64u(X509.csr(hosts, key)) });
				order = await this.poll(orderurl, body => body.status === 'valid', 'The order');
			}

			const cert = (await this.post(order.certificate, null)).body.toString('utf8');
			return { key: key.export({ type: 'pkcs8', format: 'pem' }), cert };

		} finally {
			for (const fn of cleanup) {
				try {
					fn();
				} catch {}
			}
		}
	}
}

module.exports = Acme;
