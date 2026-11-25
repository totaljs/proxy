'use strict';

// The names of the containers are resolved without the threads of libuv (a slow DNS never holds the other sites), IPv4
// only, and kept a moment.

const Test = require('node:test');
const Assert = require('node:assert/strict');
const Proxy = require('../lib/proxy');

function lookup(name, options) {
	return new Promise((resolve, reject) => Proxy.lookup(name, options || {}, (err, address, family) => err ? reject(err) : resolve({ address, family })));
}

Test('lookup of the containers', async function(t) {

	await t.test('addresses pass as they are', async function() {
		Assert.deepEqual(await lookup('127.0.0.1'), { address: '127.0.0.1', family: 4 });
		Assert.deepEqual(await lookup('::1'), { address: '::1', family: 6 });
	});

	await t.test('names of the system, IPv4 only, and the form "all" of net.connect', async function() {
		Assert.deepEqual(await lookup('localhost'), { address: '127.0.0.1', family: 4 });
		const all = await new Promise((resolve, reject) => Proxy.lookup('localhost', { all: true }, (err, list) => err ? reject(err) : resolve(list)));
		Assert.deepEqual(all, [{ address: '127.0.0.1', family: 4 }]);
	});

	await t.test('a name that does not exist fails, and fails at once the next time', async function() {
		await Assert.rejects(lookup('no-such-container-of-code.invalid'));
		const started = Date.now();
		await Assert.rejects(lookup('no-such-container-of-code.invalid'));
		Assert.ok(Date.now() - started < 50, 'kept as not found');
	});
});
