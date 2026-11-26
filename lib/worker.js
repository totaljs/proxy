'use strict';

// One worker of the proxy: started by the primary (lib/workers.js), it serves HTTP, HTTPS and WebSockets on the ports
// that all the workers share. The sites and the config come from the primary; certificates are read from the disk,
// again when the primary says so. Its log lines go to the primary, which writes the files.

const ProxyServer = require('./server');

// The limits of the config are for the whole proxy: each worker takes its part
const SHARED = ['http_active', 'http_active_per_route', 'http_active_per_ip', 'ws_active', 'ws_active_per_route', 'ws_active_per_ip', 'upstream_connections', 'upstream_idle_connections'];

let proxy = null;
let stopping = false;
let counter = 0;
const asked = new Map();

function send(message, callback) {
	if (!process.connected) {
		callback && callback();
		return;
	}
	try {
		process.send(message, callback && (() => callback()));
	} catch {
		callback && callback();
	}
}

// The answer of an ACME check is in the primary: without an answer in 3 seconds, there is none
function challenge(token) {
	return new Promise(resolve => {
		const id = ++counter;
		const done = value => {
			clearTimeout(timer);
			asked.delete(id);
			resolve(value);
		};
		const timer = setTimeout(done, 3000);
		asked.set(id, done);
		send({ type: 'challenge', id, token });
	});
}

async function stop() {
	if (stopping)
		return;
	stopping = true;
	setTimeout(() => process.exit(0), 5000);
	try {
		proxy && await proxy.stop();
	} catch {}
	// After the last lines of the log reached the primary
	send({ type: 'bye' }, () => process.exit(0));
}

// The config of the primary, with the part of this worker of every limit
function share(message) {
	const config = message.config;
	config.custom_certs = new Map(message.custom_certs);
	for (const key of SHARED)
		config[key] = Math.max(1, Math.ceil(config[key] / config.workers));
	return config;
}

function init(message) {
	proxy = new ProxyServer(share(message), {
		role: 'worker',
		routes: message.routes,
		log: text => send({ type: 'log', message: text }),
		logs: lines => send({ type: 'logs', lines }),
		challenge,
		ticketKeys: Buffer.from(message.tickets, 'base64'),
		stats: counted => send({ type: 'stats', counted }),
		fold: message.fold
	});
	proxy.start().then(() => send({ type: 'ready', ports: proxy.ports }), err => send({ type: 'failed', message: err.message }, () => process.exit(1)));
}

process.on('message', function(message) {
	switch (message && message.type) {
		case 'init':
			proxy || init(message);
			break;
		case 'reload':
			proxy && proxy.reload(message.what, message.data);
			break;
		case 'config':
			proxy && proxy.reconfigure(share(message));
			break;
		case 'challenge':
			asked.get(message.id)?.(message.value);
			break;
		case 'stop':
			stop();
			break;
	}
});

// Ctrl+C reaches every process of the terminal: the primary stops its workers itself
process.on('SIGINT', () => {});
process.on('SIGTERM', stop);
// Without the primary there is nothing to serve for
process.on('disconnect', stop);
