'use strict';

// Preload this only in the benchmark proxy container. The backend and client
// are separate processes, so these counts describe Edge's upstream requests.
const Http = require('node:http');
const counts = Object.create(null);
const request = Http.request;

function count(key) {
	counts[key] = (counts[key] || 0) + 1;
}

Http.request = function(...args) {
	const outgoing = request.apply(this, args);
	outgoing.once('response', response => {
		count('http-' + response.statusCode);
		if (String(response.headers.connection || '').toLowerCase() === 'close')
			count('upstream-connection-close');
		count(outgoing.reusedSocket ? 'responses-reused' : 'responses-new');
	});
	outgoing.once('error', err => {
		const reason = err.code || (['full', 'timeout'].includes(err.message) ? err.message : 'unknown');
		count('error-' + reason + (outgoing.reusedSocket ? '-reused' : '-new'));
	});
	return outgoing;
};

process.once('SIGTERM', () => process.stderr.write('EDGE_UPSTREAM ' + JSON.stringify(counts) + '\n'));
