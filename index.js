'use strict';

// Total.js Proxy
// node index.js [config]

const Config = require('./lib/config');
const Edge = require('./lib/edge');

const edge = new Edge(Config.load(process.argv[2] || 'config'));

edge.start().catch(function(err) {
	console.error(err.message);
	process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.once(signal, function() {
		edge.stop().finally(() => process.exit(0));
	});
}
