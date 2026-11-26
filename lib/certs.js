'use strict';

// The certificates on disk and their TLS contexts for SNI.
// data/certs: the ones of Let's Encrypt (<host>.json: key and chain together), and the ones added by hand:
//   <host>.crt or <host>.pem (the certificate, with its chain) + <host>.key (its private key), both PEM.
// The ones added by hand are never renewed and win over the ones of Let's Encrypt. Which names one serves is read
// from the certificate itself, the file name is only for people. data/custom takes the same pairs (the folder of
// before). Both folders are watched: a pair that is added, replaced or removed is applied by itself.

const Fs = require('node:fs');
const Path = require('node:path');
const Tls = require('node:tls');
const Crypto = require('node:crypto');
const Hosts = require('./hosts');
const CertFiles = require('./cert-files');

function filename(host) {
	return host.replace(/^\*\./, '_wildcard.');
}

function write(file, content, mode) {
	const tmp = file + '.' + Crypto.randomUUID() + '.tmp';
	try {
		Fs.writeFileSync(tmp, content, { mode, flag: 'wx', flush: true });
		Fs.renameSync(tmp, file);
	} finally {
		Fs.rmSync(tmp, { force: true });
	}
}

class Certs {

	constructor(folder, custom, log) {
		this.folder = folder;
		this.custom = custom;
		this.log = log || (() => {});
		this.items = new Map();
		this.customErrors = new Map();
		this.customFiles = new Map();
		this.bindings = new Map();
	}

	load() {
		this.items = new Map();
		this.customErrors.clear();
		this.customFiles.clear();
		this.scan(this.folder, 'acme');
		this.scan(this.folder, 'custom');
		this.scan(this.custom, 'custom');
	}

	// What tells that a file of the two folders changed
	signature() {
		let output = '';
		for (const folder of [this.folder, this.custom]) {
			let files = [];
			try {
				files = Fs.readdirSync(folder).sort();
			} catch {}
			for (const file of files) {
				if (!/\.(json|crt|pem|key)$/.test(file))
					continue;
				try {
					const info = Fs.statSync(Path.join(folder, file));
					output += file + ':' + info.mtimeMs + ':' + info.size + ':' + info.ino + '\n';
				} catch {}
			}
		}
		return output;
	}

	bind(routes, directory, configured) {
		const pairs = new Map();
		const bindings = new Map();
		for (const route of routes) {
			const files = route.cert === 'custom' && (route.cert_file ? route : configured.get(route.id));
			if (!files)
				continue;
			const id = files.cert_file + '\0' + files.key_file;
			if (!pairs.has(id)) {
				let entry;
				try {
					const root = Fs.realpathSync(directory);
					const read = name => {
						const file = Fs.realpathSync(Path.join(root, name));
						if (!CertFiles.inside(root, file))
							throw new Error('Certificate files must stay inside custom_cert_dir');
						const info = Fs.statSync(file);
						if (!info.isFile() || info.size > 1024 * 1024)
							throw new Error('Certificate files must be regular files of at most 1 MB');
						return Fs.readFileSync(file);
					};
					const item = this.prepare(read(files.key_file), read(files.cert_file), 'custom');
					entry = { item };
				} catch (err) {
					const error = err.code === 'ENOENT' ? 'Configured certificate or key file is missing' :
						err.code === 'EACCES' || err.code === 'EPERM' ? 'Configured certificate or key file is unreadable' : err.message;
					entry = { error };
				}
				pairs.set(id, entry);
			}
			bindings.set(route.id, pairs.get(id));
		}
		this.bindings = bindings;
	}

	customFor(route, host, now) {
		const binding = this.bindings.get(route.id);
		if (!binding) {
			const item = this.find(host, cert => cert.source === 'custom' && cert.notBefore <= now && cert.notAfter > now);
			return item ? { item } : { error: this.customProblem(host, now) };
		}
		if (binding.error)
			return binding;
		const item = binding.item;
		if (!item.names.includes(host) && (host.startsWith('*.') || !item.names.includes(Hosts.wildcard(host))))
			return { error: 'Configured certificate does not cover this hostname in its DNS subject alternative names' };
		if (item.notAfter <= now)
			return { error: 'Custom certificate expired on ' + item.notAfter.toISOString() };
		if (item.notBefore > now)
			return { error: 'Custom certificate starts on ' + item.notBefore.toISOString() };
		return binding;
	}

	scan(folder, source) {
		let files;
		try {
			files = Fs.readdirSync(folder);
		} catch {
			return;
		}
		for (const file of files) {
			if (source === 'acme') {
				if (!file.endsWith('.json'))
					continue;
				try {
					const { key, cert } = JSON.parse(Fs.readFileSync(Path.join(folder, file), 'utf8'));
					this.add(key, cert, source);
				} catch (e) {
					this.log('Certificates: skipped ' + Path.join(folder, file) + ': ' + e.message);
				}
				continue;
			}
			if (!file.endsWith('.crt') && !file.endsWith('.pem'))
				continue;
			const name = file.substring(0, file.length - 4);
			try {
				const cert = Fs.readFileSync(Path.join(folder, file));
				const key = Fs.readFileSync(Path.join(folder, name + '.key'));
				const item = this.prepare(key, cert, source);
				if (!item.names.length)
					throw new Error('the certificate has no DNS subject alternative name');
				this.customFiles.set(name, file);
				this.install(item);
			} catch (e) {
				this.customErrors.set(name, e.code === 'ENOENT' ? 'Missing certificate or matching .key file' : e.message);
				this.log('Certificates: skipped ' + Path.join(folder, file) + ': ' + e.message);
			}
		}
	}

	prepare(key, cert, source) {
		const x509 = new Crypto.X509Certificate(cert);
		if (!x509.checkPrivateKey(Crypto.createPrivateKey(key)))
			throw new Error('the key does not match the certificate');

		const names = (x509.subjectAltName || '').split(',').map(value => value.trim()).filter(value => value.startsWith('DNS:')).map(value => Hosts.normalize(value.substring(4)));
		// A test certificate of Let's Encrypt staging: replaced as soon as the proxy uses the real server
		const staging = (/\(STAGING\)/).test(x509.issuer || '');
		return { names, source, staging, notBefore: new Date(x509.validFrom), notAfter: new Date(x509.validTo), context: Tls.createSecureContext({ key, cert }) };
	}

	add(key, cert, source) {
		return this.install(this.prepare(key, cert, source));
	}

	install(item) {

		for (const name of item.names) {
			const current = this.items.get(name);
			if (current && current.source === 'custom' && item.source !== 'custom')
				continue;
			this.items.set(name, item);
		}

		return item;
	}

	// The certificate that serves a host name: its own or a wildcard one
	find(host, accept = () => true) {
		let exact = this.items.get(host);
		let wild = this.items.get(Hosts.wildcard(host));
		if (exact && !accept(exact))
			exact = null;
		if (wild && !accept(wild))
			wild = null;
		// A custom one wins over one of Let's Encrypt, a wildcard too
		if (wild && wild.source === 'custom' && (!exact || exact.source !== 'custom'))
			return wild;
		return exact || wild || null;
	}

	customProblem(host, now) {
		const item = this.find(host, certificate => certificate.source === 'custom');
		if (item)
			return item.notAfter <= now ? 'Custom certificate expired on ' + item.notAfter.toISOString() : 'Custom certificate starts on ' + item.notBefore.toISOString();
		const candidates = [filename(host), filename(Hosts.wildcard(host) || host)];
		for (const name of candidates) {
			const file = this.customFiles.get(name);
			if (file)
				return file + ' does not cover this hostname in its DNS subject alternative names';
			const reason = this.customErrors.get(name);
			if (reason)
				return reason;
		}
		return 'No custom certificate covers this hostname';
	}

	save(host, key, cert) {
		// Checked before it touches the disk
		const item = this.prepare(key, cert, 'acme');
		Fs.mkdirSync(this.folder, { recursive: true, mode: 0o700 });
		const file = Path.join(this.folder, filename(host) + '.json');
		write(file, JSON.stringify({ key: key.toString(), cert: cert.toString() }), 0o600);
		return this.install(item);
	}
}

module.exports = Certs;
