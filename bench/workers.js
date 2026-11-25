'use strict';

const Cluster = require('node:cluster');
const Path = require('node:path');
const Config = require('../lib/config');
const Edge = require('../lib/edge');

const workers = Number(process.env.BENCH_EDGE_WORKERS || 1);
if (![1, 2].includes(workers))
	throw new Error('Expected one or two Edge benchmark workers');

if (workers === 2 && Cluster.isPrimary) {
	Cluster.schedulingPolicy = Cluster.SCHED_RR;
	let stopping = false;
	function stop(code) {
		if (stopping)
			return;
		stopping = true;
		process.exitCode = code;
		for (const worker of Object.values(Cluster.workers))
			worker.process.kill('SIGTERM');
	}
	process.once('SIGTERM', () => stop(0));
	process.once('SIGINT', () => stop(0));
	Cluster.on('exit', () => stop(1));
	for (let i = 0; i < workers; i++)
		Cluster.fork();
} else {
	const config = Config.load(process.argv[2]);
	if (!config.routes_file || config.control || config.dns_zone)
		throw new Error('Benchmark workers require file-managed routes and disabled control and DNS listeners');
	config.upstream_connections = Math.floor(config.upstream_connections / workers);
	config.upstream_idle_connections = Math.floor(config.upstream_idle_connections / workers);
	config.http_active = Math.floor(config.http_active / workers);
	config.http_active_per_route = Math.floor(config.http_active_per_route / workers);
	// The benchmark uses a fixed custom certificate. Each worker has its own
	// transient status files, while both read the same routes and certificate.
	const id = Cluster.worker?.id || 1;
	config.data = Path.join(config.data, 'bench-worker-' + id);
	const edge = new Edge(config);
	let requests = 0;
	for (const signal of ['SIGTERM', 'SIGINT']) {
		process.once(signal, async () => {
			await edge.stop();
			console.log('EDGE_WORKER ' + JSON.stringify({ id, requests, upstreamConnections: config.upstream_connections }));
			if (Cluster.worker?.isConnected())
				Cluster.worker.disconnect();
		});
	}
	edge.start().then(() => {
		for (const server of [edge.http, edge.https])
			server.on('request', () => requests++);
	}).catch(err => {
		console.error(err.message);
		process.exit(1);
	});
}
