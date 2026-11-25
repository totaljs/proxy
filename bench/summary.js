'use strict';

const Fs = require('node:fs');

const units = { B: 1, kB: 1000, MB: 1e6, GB: 1e9, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 };
const memory = value => {
	const match = /^([\d.]+)\s*(\w+)/.exec(value);
	return match && units[match[2]] ? +match[1] * units[match[2]] / units.MiB : null;
};
const median = values => {
	const items = values.filter(Number.isFinite).sort((a, b) => a - b);
	const mid = Math.floor(items.length / 2);
	return items.length ? (items[mid] + items[Math.floor((items.length - 1) / 2)]) / 2 : null;
};
const fmt = (value, places = 2) => Number.isFinite(value) ? value.toFixed(places) : '—';

const rows = Fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map(line => {
	const [round, proxy, protocol, base] = line.split('\t');
	const data = JSON.parse(Fs.readFileSync(base + '.json', 'utf8'));
	const stats = Fs.readFileSync(base + '.stats.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
	const cpu = stats.map(sample => parseFloat(sample.CPUPerc)).filter(Number.isFinite);
	const mem = stats.map(sample => memory(sample.MemUsage)).filter(Number.isFinite);
	return { ...data, round, proxy, protocol, cpu: cpu.length ? cpu.reduce((sum, item) => sum + item, 0) / cpu.length : null,
		memory: mem.length ? Math.max(...mem) : null };
});

if (process.argv[3] === 'diagnose') {
	console.log('# Edge 503 diagnostics');
	console.log('\nUpstream events include the warm-up of each Edge container. The measured response counts exclude warm-up.\n');
	console.log('| Target | Protocol | Clients | Seconds | OK req/s | p95 ms | p99 ms | Client failures | Edge upstream events |');
	console.log('|---|---|---:|---:|---:|---:|---:|---|---|');
	for (const row of rows) {
		const base = process.argv[2].replace(/index\.tsv$/, row.round + '-' + row.proxy + '-' + row.protocol);
		const upstream = row.proxy !== 'direct' ? JSON.parse(Fs.readFileSync(base + '.upstream.jsonl', 'utf8').trim()) : {};
		const counts = entries => Object.entries(entries).map(([key, count]) => key + ': ' + count).join(', ') || '—';
		console.log('| ' + [row.proxy, row.protocol, row.concurrency, fmt(row.seconds, 1), fmt(row.rps, 0), fmt(row.p95), fmt(row.p99),
			counts(row.failures), counts(upstream)].join(' | ') + ' |');
	}
	process.exit(0);
}

if (process.argv[3] === 'capacity') {
	console.log('# Edge capacity');
	console.log('\nEach row is one load interval. CPU and RAM are sampled for Edge alone. Latencies include successful responses only.\n');
	console.log('| Config | Protocol | Clients | Seconds | OK req/s | p95 ms | p99 ms | Errors | HTTP status / transport | CPU % | Peak RAM MiB |');
	console.log('|---|---|---:|---:|---:|---:|---:|---:|---|---:|---:|');
	for (const row of rows) {
		const statuses = Object.entries(row.statuses).map(([status, count]) => status + ': ' + count).join(', ');
		console.log('| ' + [row.proxy, row.protocol, row.concurrency, fmt(row.seconds, 1), fmt(row.rps, 0), fmt(row.p95), fmt(row.p99),
			row.errors, statuses, fmt(row.cpu), fmt(row.memory)].join(' | ') + ' |');
	}
	process.exit(0);
}

const ab = process.argv[3] === 'ab';
const nginx = process.argv[3] === 'nginx';
const workers = process.argv[3] === 'workers';
console.log(workers ? '# Edge workers vs NGINX' : ab ? '# Edge A/B' : nginx ? '# Edge vs NGINX' : '# Edge vs NGINX vs Caddy');
if (ab || nginx || workers) {
	console.log('\nMedians across short rounds, plus one 60-second HTTPS interval per version. Edge used a per-route active-request limit of 1,024. Latency covers successful responses. CPU is the average per interval in Docker percent, where 100% is one core. RAM is the sampled peak.\n');
	console.log('| Version | Protocol | Clients | Rounds | OK req/s | p95 ms | p99 ms | Errors | HTTP 503 | Transport | Error % | CPU % | Peak RAM MiB |');
	console.log('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
	for (const group of ['64', '256', '512', '1000', 'sustained']) {
		for (const protocol of ['http', 'https']) {
			for (const variant of (workers ? ['edge-1', 'edge-2', 'nginx'] : nginx ? ['edge', 'nginx'] : ['baseline', 'candidate'])) {
				const cases = rows.filter(row => row.proxy === variant + '-' + group && row.protocol === protocol);
				if (!cases.length)
					continue;
				const sum = key => cases.reduce((total, row) => total + key(row), 0);
				const middle = key => fmt(median(cases.map(row => row[key])));
				const errors = sum(row => row.errors);
				const attempts = sum(row => row.requests + row.errors);
				console.log('| ' + [variant + (group === 'sustained' ? ' (60 s)' : ''), protocol, cases[0].concurrency,
					cases.length, middle('rps'), middle('p95'), middle('p99'), errors, sum(row => row.statuses['503'] || 0),
					sum(row => row.statuses.transport || 0), fmt(100 * errors / attempts), middle('cpu'), middle('memory')].join(' | ') + ' |');
			}
		}
	}
	process.exit(0);
}

console.log('\nMedians across rounds. The range shows min–max throughput. CPU and RAM describe the measured container. Direct HTTP measures the backend without a proxy.\n');
console.log('| Proxy | Protocol | Rounds | Requests/s | Range | p50 ms | p95 ms | p99 ms | Errors | CPU % | Peak RAM MiB |');
console.log('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
const variants = ['direct', 'edge', 'nginx', 'caddy'];
for (const proxy of variants) {
	for (const protocol of ['http', 'https']) {
		const cases = rows.filter(row => row.proxy === proxy && row.protocol === protocol);
		if (!cases.length)
			continue;
		const mid = key => fmt(median(cases.map(row => row[key])));
		const rates = cases.map(row => row.rps);
		const errors = cases.reduce((sum, row) => sum + row.errors, 0);
		console.log('| ' + [proxy, protocol, cases.length, mid('rps'), fmt(Math.min(...rates), 0) + '–' + fmt(Math.max(...rates), 0),
			mid('p50'), mid('p95'), mid('p99'), errors, mid('cpu'), mid('memory')].join(' | ') + ' |');
	}
}
