'use strict';

// Benchmark entry point for one Edge process with separate RSS and heap samples.
const Fs = require('node:fs');
const V8 = require('node:v8');
const Config = require('../lib/config');
const Edge = require('../lib/server');

const edge = new Edge(Config.load(process.argv[2]));
const count = entries => Object.values(entries).reduce((sum, list) => sum + list.length, 0);

function sample(kind) {
	const memory = process.memoryUsage();
	let anonymous = null;
	try {
		const match = /^RssAnon:\s+(\d+)\s+kB$/m.exec(Fs.readFileSync('/proc/self/status', 'utf8'));
		if (match)
			anonymous = Number(match[1]) * 1024;
	} catch {}
	const agent = edge.upstreamAgent;
	console.log('EDGE_MEMORY ' + JSON.stringify({
		at: Date.now(), kind,
		...memory,
		heapPhysical: V8.getHeapStatistics().total_physical_size,
		anonymous,
		upstreamActive: count(agent.sockets),
		upstreamIdle: count(agent.freeSockets),
		upstreamWaiting: count(agent.requests),
		requestsActive: edge.httpCapacity.active
	}));
}

let timer;
process.once('SIGUSR2', () => {
	global.gc();
	sample('forced-gc');
});
for (const signal of ['SIGTERM', 'SIGINT']) {
	process.once(signal, async () => {
		clearInterval(timer);
		await edge.stop();
		process.exit(0);
	});
}
edge.start().then(() => {
	sample('periodic');
	timer = setInterval(() => sample('periodic'), 1000).unref();
}).catch(err => {
	console.error(err.message);
	process.exit(1);
});
