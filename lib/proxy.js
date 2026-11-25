'use strict';

// Forwards HTTP requests and WebSockets to the container of a route.

const Fs = require('node:fs');
const Path = require('node:path');
const Http = require('node:http');
const Zlib = require('node:zlib');
const Dns = require('node:dns');
const Net = require('node:net');
const Headers = require('./headers');
const Pages = require('./pages');

// Hop-by-hop headers belong to one connection and are never forwarded
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'expect']);

// The address of a container, by its name: IPv4 only, from the DNS of Docker (c-ares, not the 4 threads of libuv that
// dns.lookup uses), kept 30 seconds (a name that does not exist, 10 seconds). Docker answers the IPv4 of a container at
// once, but a lookup that also asks for IPv6 waits 5 seconds on a network without IPv6; with dns.lookup a few of those
// filled the threads and every site waited behind them (nginx-proxy wrote the addresses in its config, so it never asked).
const RESOLVER = new Dns.promises.Resolver({ timeout: 1500, tries: 2 });
const NAMES = new Map();
const ASKING = new Map();

// The names of /etc/hosts (localhost, extra_hosts of Docker), read again each minute: they never go to a DNS server
let HOSTS = null;
function hostsfile() {
	if (HOSTS && HOSTS.expire > Date.now())
		return HOSTS.names;
	const names = new Map();
	try {
		for (const line of Fs.readFileSync('/etc/hosts', 'utf8').split('\n')) {
			const parts = line.replace(/#.*/, '').trim().split(/\s+/);
			if (parts.length > 1 && Net.isIPv4(parts[0]))
				parts.slice(1).forEach(name => names.has(name.toLowerCase()) || names.set(name.toLowerCase(), parts[0]));
		}
	} catch {}
	names.has('localhost') || names.set('localhost', '127.0.0.1');
	HOSTS = { names, expire: Date.now() + 60000 };
	return names;
}

function resolve(hostname) {
	const name = hostname.toLowerCase();
	const local = hostsfile().get(name);
	if (local)
		return Promise.resolve(local);
	const hit = NAMES.get(name);
	if (hit && hit.expire > Date.now())
		return hit.error ? Promise.reject(hit.error) : Promise.resolve(hit.address);
	// One question for many requests of the same name
	if (ASKING.has(name))
		return ASKING.get(name);
	const question = RESOLVER.resolve4(name).then(function(list) {
		NAMES.size > 5000 && NAMES.clear();
		NAMES.set(name, { address: list[0], expire: Date.now() + 30000 });
		return list[0];
	}, function(err) {
		NAMES.set(name, { error: err, expire: Date.now() + 10000 });
		throw err;
	}).finally(() => ASKING.delete(name));
	ASKING.set(name, question);
	return question;
}

function lookup(hostname, options, callback) {
	if (typeof options === 'function') {
		callback = options;
		options = {};
	}
	const reply = address => options && options.all ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4);
	if (Net.isIPv4(hostname))
		return reply(hostname);
	if (Net.isIPv6(hostname))
		return options && options.all ? callback(null, [{ address: hostname, family: 6 }]) : callback(null, hostname, 6);
	resolve(hostname).then(reply, err => callback(err));
}

exports.lookup = lookup;

function createAgent(maxSockets, idleSockets) {
	return new Http.Agent({ keepAlive: true, maxSockets, maxFreeSockets: Math.min(maxSockets, idleSockets), timeout: 60000, lookup });
}

const IDLE = 120000;
// A request that waits this long for a free connection to its container gets 503: a site that is full answers so
const QUEUE = 30000;

const TUNNELS = new Set();

function clean(headers, upstream = false, protectedRoute = false) {
	const output = {};
	const connection = headers.connection;
	// The common single-token values are already in HOP.
	const listed = !connection || connection === 'keep-alive' || connection === 'close' ? null :
		String(connection).toLowerCase().split(',').map(value => value.trim());
	for (const key in headers) {
		if (HOP.has(key) || listed?.includes(key))
			continue;
		if (upstream && (key === 'forwarded' || key === 'x-real-ip' || key.startsWith('x-forwarded-') || (protectedRoute && key === 'authorization')))
			continue;
		output[key] = headers[key];
	}
	return output;
}

function clientip(req) {
	const ip = req.socket.remoteAddress || '';
	return ip.startsWith('::ffff:') ? ip.substring(7) : ip;
}

// The headers sent to the container. Forwarding headers sent by the client are replaced:
// the edge is the first hop, so it never trusts them.
function forward(req, info, route) {
	const headers = clean(req.headers, true, !!route.auth);
	const ip = clientip(req);
	// The host the edge routed by, never the raw header of the client ("good.example.com:x@evil.com")
	headers.host = info.host + (info.port === (info.secure ? 443 : 80) ? '' : ':' + info.port);
	headers['x-forwarded-for'] = ip;
	headers['x-real-ip'] = ip;
	headers['x-forwarded-proto'] = info.secure ? 'https' : 'http';
	headers['x-forwarded-host'] = info.host;
	headers['x-forwarded-port'] = String(info.port);
	return headers;
}

// Own pages for the answers of the edge: <errors folder>/<status>.html (404, 401, 403, 413, 429, 502, 503, 504), read at
// start. 503.html is the page of every site while its app does not answer, under the one of the site and of the settings.
const PAGES = new Map();

function errorpages(folder) {
	PAGES.clear();
	if (!folder)
		return;
	for (const status of [401, 403, 404, 413, 429, 502, 503, 504]) {
		try {
			PAGES.set(status, Fs.readFileSync(Path.join(folder, status + '.html')));
		} catch {}
	}
}

function page(res, status, message, extra) {
	const body = PAGES.get(status) || Buffer.from('<!doctype html><meta charset="utf-8"><title>' + status + '</title><p style="font:16px system-ui,sans-serif;margin:40px">' + message + '</p>');
	res.writeHead(status, Object.assign({ 'content-type': 'text/html; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' }, extra));
	res.end(body);
}

// Compression of text answers that the app sent uncompressed: brotli when the browser takes it, else gzip
const COMPRESSIBLE = /^(text\/(?!event-stream)|application\/(json|javascript|xml|rss\+xml|atom\+xml|manifest\+json|ld\+json|wasm)|image\/svg\+xml|font\/(ttf|otf))/i;

function encoding(req, pres) {
	if (req.method === 'HEAD' || pres.statusCode < 200 || pres.statusCode === 204 || pres.statusCode === 206 || pres.statusCode === 304)
		return null;
	const headers = pres.headers;
	if (headers['content-encoding'] || /no-transform/i.test(headers['cache-control'] || '') || !COMPRESSIBLE.test(headers['content-type'] || ''))
		return null;
	if (headers['content-length'] != null && +headers['content-length'] < 1024)
		return null;
	const accept = String(req.headers['accept-encoding'] || '').toLowerCase();
	const takes = name => new RegExp('(^|,)\\s*' + name + '\\s*(;\\s*q=(?!0(\\.0*)?\\s*(,|$))[0-9.]+)?\\s*(,|$)').test(accept);
	return takes('br') ? 'br' : takes('gzip') ? 'gzip' : null;
}

// The page of a site while its app does not answer or is in maintenance: 503 with Retry-After, so search engines come
// back later and keep the site. The one of the site (info.page), else the one of the settings or of the errors folder,
// else the page of the edge in the language of the visitor.
function stopped(req, res, info) {
	if (res.headersSent) {
		res.destroy();
		return;
	}
	// 502.html: the own page of before for an app that does not answer
	const body = info.page || PAGES.get(503) || PAGES.get(502) || Pages.stopped(req.headers['accept-language']);
	res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store', 'retry-after': '60' });
	res.end(req.method === 'HEAD' ? undefined : body);
}

function close(res, status, message) {
	if (res.headersSent) {
		res.destroy();
		return;
	}
	res.setHeader('connection', 'close');
	page(res, status, message);
}

// Answers 413 and reads the rest of the body for a moment, so the client gets the answer
// instead of a reset connection
// (Node closes the connection when it answers before the body is read, so the answer waits
// for the end of the body, at most 5 seconds.)
function toolarge(req, res) {
	if (res.headersSent) {
		res.destroy();
		return;
	}
	let sent = false;
	const send = function(last) {
		if (sent)
			return;
		sent = true;
		clearTimeout(timer);
		if (last)
			res.setHeader('connection', 'close');
		page(res, 413, 'The upload is too large.');
	};
	const timer = setTimeout(() => send(true), 5000);
	req.removeAllListeners('data');
	req.on('data', () => {});
	req.once('end', () => send(false));
	req.once('error', () => clearTimeout(timer));
	req.resume();
}

// For clients that ask first (Expect: 100-continue): an upload over the limit is refused before it is sent
function checkcontinue(req, res, maxupload) {
	const length = req.headers['content-length'];
	if (length && +length > maxupload * 1024 * 1024) {
		res.setHeader('connection', 'close');
		page(res, 413, 'The upload is too large.');
		return false;
	}
	res.writeContinue();
	return true;
}

function connectionDeadline(preq) {
	const queued = setTimeout(() => preq.destroy(new Error('full')), QUEUE);
	preq.once('socket', socket => {
		if (socket.connecting)
			socket.once('connect', () => clearTimeout(queued));
		else
			clearTimeout(queued);
	});
	preq.once('close', () => clearTimeout(queued));
}

// info: { secure, host, port, maxupload, hsts, headers (of every site), compress }
function web(req, res, route, info, retried) {

	const limit = info.maxupload * 1024 * 1024;
	const length = req.headers['content-length'];
	const bodyless = (!length || length === '0') && !req.headers['transfer-encoding'];

	if (length && +length > limit) {
		toolarge(req, res);
		return;
	}

	const headers = forward(req, info, route);
	// A body without a length (chunked by the client) goes chunked to the container too: written without framing, its
	// bytes would be read by the container as another request
	if (req.headers['transfer-encoding'] && !length)
		headers['transfer-encoding'] = 'chunked';

	const preq = Http.request({
		hostname: route.$target.hostname,
		port: route.$target.port,
		lookup: lookup,
		method: req.method,
		path: pathof(req.url),
		headers: headers,
		agent: info.agent
	});

	let size = 0;
	let done = false;

	preq.setTimeout(IDLE, () => preq.destroy(new Error('timeout')));
	connectionDeadline(preq);

	preq.on('response', function(pres) {
		const headers = clean(pres.headers);
		// The app first, then the headers of the site, then those of every site, then HSTS if the site wants it
		Headers.fill(headers, route.$headers, info.secure);
		Headers.fill(headers, info.headers, info.secure);
		if (route.hsts && info.secure && !headers['strict-transport-security'])
			headers['strict-transport-security'] = info.hsts;

		const coding = info.compress ? encoding(req, pres) : null;
		if (coding) {
			delete headers['content-length'];
			headers['content-encoding'] = coding;
			headers.vary = headers.vary ? headers.vary + ', Accept-Encoding' : 'Accept-Encoding';
		}

		pres.on('error', () => res.destroy());
		try {
			res.writeHead(pres.statusCode, pres.statusMessage, headers);
		} catch {
			// writeHead can leave some headers staged before throwing.
			for (const name of res.getHeaderNames())
				res.removeHeader(name);
			close(res, 502, 'The site returned an invalid response.');
			pres.destroy();
			return;
		}

		if (coding) {
			const zip = coding === 'br' ? Zlib.createBrotliCompress({ params: { [Zlib.constants.BROTLI_PARAM_QUALITY]: 4 } }) : Zlib.createGzip({ level: 6 });
			zip.on('error', () => res.destroy());
			res.once('close', () => zip.destroy());
			pres.pipe(zip).pipe(res);
		} else
			pres.pipe(res);
		pres.on('aborted', () => res.destroy());
	});

	preq.on('error', function(err) {
		if (done)
			return;
		done = true;
		// A kept-alive socket the container already closed: try once more for a bodyless GET or HEAD
		if (!retried && preq.reusedSocket && err.code === 'ECONNRESET' && bodyless && !res.headersSent && (req.method === 'GET' || req.method === 'HEAD')) {
			web(req, res, route, info, true);
			return;
		}
		if (err.message === 'timeout')
			close(res, 504, 'The site took too long to answer.');
		else if (err.message === 'full')
			close(res, 503, 'The site is busy right now. Try again in a moment.');
		else {
			// The app does not answer (stopped, starting or not there): the page of the site
			res.headersSent || res.setHeader('connection', 'close');
			stopped(req, res, info);
		}
	});

	res.on('close', function() {
		if (!res.writableFinished && !done)
			preq.destroy();
	});

	if (!retried)
		req.on('error', () => preq.destroy());
	if (retried || bodyless) {
		preq.end();
		return;
	}

	req.on('data', function(chunk) {
		size += chunk.length;
		if (size > limit) {
			done = true;
			preq.destroy();
			toolarge(req, res);
			return;
		}
		if (!preq.write(chunk)) {
			req.pause();
			preq.once('drain', () => req.resume());
		}
	});

	req.on('end', () => preq.end());
}

// "http://evil.com/x" (absolute form) reaches the container as "/x": the edge chose the route by its Host
function pathof(url) {
	if (url.startsWith('/') || url === '*')
		return url;
	try {
		const parsed = new URL(url);
		return parsed.pathname + parsed.search;
	} catch {
		return '/';
	}
}

function raw(socket, status, headers) {
	if (!socket.writable)
		return;
	if (!socket.listenerCount('error'))
		socket.on('error', () => socket.destroy());
	let output = 'HTTP/1.1 ' + status + ' ' + Http.STATUS_CODES[status] + '\r\n';
	for (const key in headers)
		output += key + ': ' + headers[key] + '\r\n';
	socket.end(output + 'connection: close\r\ncontent-length: 0\r\n\r\n');
}

function ws(req, socket, head, route, info) {

	const headers = forward(req, info, route);
	headers.connection = 'Upgrade';
	headers.upgrade = req.headers.upgrade;

	const preq = Http.request({
		hostname: route.$target.hostname,
		port: route.$target.port,
		lookup: lookup,
		method: req.method,
		path: pathof(req.url),
		headers: headers,
		agent: false
	});

	socket.on('error', () => preq.destroy());
	// A client that goes before the container answers takes the request to the container with it
	const early = () => preq.destroy();
	socket.once('close', early);
	preq.setTimeout(IDLE, () => preq.destroy());
	connectionDeadline(preq);

	preq.on('upgrade', function(pres, psocket, phead) {

		socket.removeListener('close', early);
		if (socket.destroyed) {
			psocket.destroy();
			return;
		}
		preq.setTimeout(0);
		socket.setTimeout(0);
		socket.setNoDelay(true);
		psocket.setNoDelay(true);

		let output = 'HTTP/1.1 101 Switching Protocols\r\n';
		for (let i = 0; i < pres.rawHeaders.length; i += 2)
			output += pres.rawHeaders[i] + ': ' + pres.rawHeaders[i + 1] + '\r\n';

		socket.write(output + '\r\n');

		if (phead && phead.length)
			socket.write(phead);

		if (head && head.length)
			psocket.write(head);

		psocket.pipe(socket);
		socket.pipe(psocket);

		// Upgraded sockets leave the HTTP server: the edge closes them itself when it stops
		TUNNELS.add(socket);
		TUNNELS.add(psocket);
		socket.once('close', () => TUNNELS.delete(socket));
		psocket.once('close', () => TUNNELS.delete(psocket));

		psocket.on('error', () => socket.destroy());
		socket.on('error', () => psocket.destroy());
		psocket.on('close', () => socket.destroy());
		socket.on('close', () => psocket.destroy());
	});

	// The container answered without switching protocols
	preq.on('response', function(pres) {
		pres.resume();
		raw(socket, pres.statusCode, {});
	});

	preq.on('error', () => raw(socket, 503, { 'retry-after': '60' }));
	preq.end();
}

exports.web = web;
exports.stopped = stopped;
exports.checkcontinue = checkcontinue;
exports.ws = ws;
exports.page = page;
exports.errorpages = errorpages;
exports.raw = raw;
exports.createAgent = createAgent;

exports.closeall = function() {
	for (const socket of TUNNELS)
		socket.destroy();
	TUNNELS.clear();
};
