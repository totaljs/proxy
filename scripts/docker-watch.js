'use strict';

// Docker discovery outside the proxy, for a proxy that may not reach Docker itself (config: "docker": ""). It writes
// the same site files as the proxy would (lib/docker.js) into the sites folder of the proxy, which applies them.
//
//   node scripts/docker-watch.js <data/sites> [network] [socket] [--once]

const Path = require('node:path');
const Docker = require('../lib/docker');

function main() {
	const args = process.argv.slice(2);
	const once = args.includes('--once');
	const [folder, network, socket, ...extra] = args.filter(arg => arg !== '--once');
	if (!folder || extra.length)
		throw new Error('Usage: node scripts/docker-watch.js <data/sites> [network] [socket] [--once]');

	const say = message => console.error(new Date().toISOString() + '  ' + message);
	const docker = new Docker({ socket: socket || '/var/run/docker.sock', network: network || 'proxy', folder: Path.resolve(folder), log: say, error: say });

	if (once) {
		docker.stopped = false;
		return docker.sync();
	}

	docker.start();
	for (const signal of ['SIGINT', 'SIGTERM'])
		process.once(signal, () => process.exit(0));
	// The timers of discovery do not keep a process alive by themselves
	setInterval(() => {}, 60000);
}

Promise.resolve().then(main).catch(err => {
	console.error('Docker: ' + err.message);
	process.exitCode = 1;
});
