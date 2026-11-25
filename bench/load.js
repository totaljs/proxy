'use strict';

const Fs = require('node:fs');
const Http = require('node:http');
const Https = require('node:https');
const { performance } = require('node:perf_hooks');

const BODY = 'Hello from Total.js behind Total.js Edge.';

async function run(protocol, port, seconds, concurrency, certificate) {
	const secure = protocol === 'https';
	const client = secure ? Https : Http;
	const agent = new client.Agent({ keepAlive: true, maxSockets: concurrency });
	const latencies = [];
	let errors = 0;
	const statuses = {};
	const failures = {};
	let invalidBody = 0;
	const started = performance.now();
	const deadline = started + seconds * 1000;

	function request() {
		const start = performance.now();
		return new Promise(resolve => {
			const req = client.get({
				host: '127.0.0.1', port, path: '/', agent, servername: 'bench.test', ca: certificate,
				headers: { host: 'bench.test', 'accept-encoding': 'identity' }
			}, res => {
				let body = '';
				res.setEncoding('utf8');
				res.on('data', chunk => body += chunk);
				res.once('error', () => resolve({ status: 'transport', reason: 'response-aborted', ok: false }));
				res.once('end', () => {
					if (res.statusCode === 200 && body !== BODY)
						invalidBody++;
					resolve({ status: res.statusCode, ok: res.statusCode === 200 && body === BODY,
						reason: res.statusCode === 503 ? '503-retry-after-' + (res.headers['retry-after'] || 'absent') : 'http-' + res.statusCode });
				});
			});
			req.setTimeout(3000, () => req.destroy(Object.assign(new Error('request timeout'), { code: 'BENCH_TIMEOUT' })));
			req.once('error', err => resolve({ status: 'transport', reason: err.code || 'request-error', ok: false }));
		}).then(result => ({ ...result, ms: performance.now() - start }));
	}

	// Capture completion times before sorting, and count requests that are still in flight at the deadline.
	await Promise.all(Array.from({ length: concurrency }, async () => {
		while (performance.now() < deadline) {
			const { ok, status, reason, ms } = await request();
			statuses[status] = (statuses[status] || 0) + 1;
			if (ok)
				latencies.push(ms);
			else {
				errors++;
				failures[reason] = (failures[reason] || 0) + 1;
			}
		}
	}));
	const elapsed = (performance.now() - started) / 1000;
	agent.destroy();
	latencies.sort((a, b) => a - b);
	const percentile = p => latencies.length ? latencies[Math.ceil(p * latencies.length) - 1] : null;
	return { seconds: elapsed, concurrency, requests: latencies.length, errors, rps: latencies.length / elapsed, statuses, failures, invalidBody,
		p50: percentile(0.50), p95: percentile(0.95), p99: percentile(0.99) };
}

if (require.main === module) {
	const [protocol, port, seconds, concurrency] = process.argv.slice(2);
	const valid = value => Number.isInteger(+value) && +value > 0;
	if (!['http', 'https'].includes(protocol) || !valid(port) || !valid(seconds) || !valid(concurrency))
		throw new Error('Usage: node bench/load.js <http|https> <port> <seconds> <concurrency>');
	const ca = protocol === 'https' ? Fs.readFileSync(process.env.BENCH_CERT) : undefined;
	run(protocol, +port, +seconds, +concurrency, ca).then(result => {
		console.log(JSON.stringify(result));
		if (!result.requests || result.errors)
			process.exitCode = 1;
	}).catch(err => {
		console.error(err);
		process.exitCode = 1;
	});
}

module.exports = run;
