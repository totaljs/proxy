'use strict';

const Fs = require('node:fs');
const Path = require('node:path');
const folder = process.argv[2];
const MiB = 1024 ** 2;
const lines = file => Fs.readFileSync(Path.join(folder, file), 'utf8').trim().split('\n').filter(Boolean);
const jsonl = file => lines(file).map(line => JSON.parse(line));
const max = values => values.length ? Math.max(...values) : null;
const avg = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const fmt = value => Number.isFinite(value) ? value.toFixed(1) : '—';
const bytes = value => typeof value === 'number' ? value / MiB : null;
const dockerMiB = value => {
	const [, amount, unit] = /^(\d+(?:\.\d+)?)\s*([A-Za-z]+)/.exec(value) || [];
	const scale = { B: 1, kB: 1000, MB: 1e6, GB: 1e9, KiB: 1024, MiB, GiB: 1024 ** 3 }[unit];
	return scale ? amount * scale / MiB : null;
};
const samples = jsonl('edge-node.jsonl');
if (!samples.some(row => row.kind === 'forced-gc'))
	throw new Error('Missing the final Node memory sample');

console.log('# Proxy and NGINX memory across two load cycles');
console.log('\nThe container column is the peak sampled by Docker. Node columns use the **last sample** of each interval, so recovery values can be compared directly. External includes ArrayBuffers. These columns overlap and should not be added.\n');
console.log('| Proxy | Phase | OK req/s | Errors | CPU avg % | Container peak MiB | Node RSS MiB | Anonymous RSS MiB | Heap used MiB | External MiB | ArrayBuffers MiB | Active / idle / queued sockets |');
console.log('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|');
for (const line of lines('memory-phases.tsv')) {
	const [proxy, label, from, to] = line.split('\t');
	const base = proxy + '-' + label;
	const docker = jsonl(base + '.stats.jsonl');
	if (!docker.length)
		throw new Error('Missing Docker samples for ' + base);
	const node = proxy === 'edge' ? samples.filter(sample => sample.kind === 'periodic' && sample.at >= +from && sample.at < +to).at(-1) : null;
	if (proxy === 'edge' && !node)
		throw new Error('Missing Node samples for ' + base);
	const load = label.startsWith('load') ? JSON.parse(Fs.readFileSync(Path.join(folder, base + '.json'), 'utf8')) : null;
	console.log('| ' + [proxy, label, fmt(load?.rps), load?.errors ?? '—',
		fmt(avg(docker.map(row => parseFloat(row.CPUPerc)).filter(Number.isFinite))),
		fmt(max(docker.map(row => dockerMiB(row.MemUsage)).filter(Number.isFinite))),
		...['rss', 'anonymous', 'heapUsed', 'external', 'arrayBuffers'].map(key => fmt(bytes(node?.[key]))),
		node ? [node.upstreamActive, node.upstreamIdle, node.upstreamWaiting].join(' / ') : '—'].join(' | ') + ' |');
}
const gc = samples.find(row => row.kind === 'forced-gc');
console.log('\nAfter a single diagnostic garbage collection at the end, Node reported ' + fmt(bytes(gc.rss)) +
	' MiB RSS, ' + fmt(bytes(gc.anonymous)) + ' MiB anonymous RSS, ' + fmt(bytes(gc.heapUsed)) +
	' MiB used heap and ' + fmt(bytes(gc.external)) + ' MiB external. No forced GC runs during the load cycles.');
