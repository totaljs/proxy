require('total5');

ROUTE('GET /', function($) {
	$.plain('Hello from Total.js behind Total.js Proxy.');
});

Total.run({ ip: '0.0.0.0', port: 8000, release: true, watcher: false });
