'use strict';

// Total.js Proxy
// node index.js [data]
//
// data: the folder with config.json and sites/*.json (default: data). Both are watched and applied by themselves.

const Runner = require('./lib/runner');

const runner = new Runner(process.argv[2] || 'data', {
	fatal: function(err) {
		console.error(err.message);
		process.exit(1);
	}
});

runner.start().catch(function(err) {
	console.error(err.message);
	process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.once(signal, function() {
		runner.stop().finally(() => process.exit(0));
	});
}
