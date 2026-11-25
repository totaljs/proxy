'use strict';

// Total.js Proxy
// node index.js [config]

const Config = require('./lib/config');
const ProxyServer = require('./lib/server');

const proxy = new ProxyServer(Config.load(process.argv[2] || 'config'));

proxy.start().catch(function(err) {
	console.error(err.message);
	process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.once(signal, function() {
		proxy.stop().finally(() => process.exit(0));
	});
}
