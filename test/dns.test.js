'use strict';

const Test = require('node:test');
const Assert = require('node:assert/strict');
const Net = require('node:net');
const Resolver = require('node:dns').promises.Resolver;
const Dns = require('../lib/dns');

Test('DNS server for the ACME checks', async function(t) {

	const server = new Dns.Server({ zone: 'acme.code.test', ns: 'ns.code.test' });
	const port = await server.listen(0, '127.0.0.1');
	t.after(() => server.close());

	const resolver = new Resolver();
	resolver.setServers(['127.0.0.1:' + port]);

	server.add('abc123.acme.code.test', 'first');
	server.add('abc123.acme.code.test', 'second');
	server.add('long.acme.code.test', 'x'.repeat(300));

	const values = (await resolver.resolveTxt('ABC123.acme.code.test')).map(item => item.join('')).sort();
	Assert.deepEqual(values, ['first', 'second']);

	const long = await resolver.resolveTxt('long.acme.code.test');
	Assert.equal(long[0].join(''), 'x'.repeat(300));

	server.remove('abc123.acme.code.test', 'first');
	Assert.deepEqual(await resolver.resolveTxt('abc123.acme.code.test'), [['second']]);

	await Assert.rejects(resolver.resolveTxt('missing.acme.code.test'), err => err.code === 'ENOTFOUND');
	await Assert.rejects(resolver.resolveTxt('example.com'), err => err.code === 'EREFUSED');
	await Assert.rejects(resolver.resolve4('abc123.acme.code.test'), err => err.code === 'ENODATA');

	const soa = await resolver.resolveSoa('acme.code.test');
	Assert.equal(soa.nsname, 'ns.code.test');
	Assert.deepEqual(await resolver.resolveNs('acme.code.test'), ['ns.code.test']);

	// The same over TCP, with a length prefix
	const query = Buffer.concat([Buffer.from([0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]), Dns.writename('abc123.acme.code.test'), Buffer.from([0, 16, 0, 1])]);
	const answer = await new Promise((resolve, reject) => {
		const socket = Net.connect(port, '127.0.0.1', () => socket.write(Buffer.concat([Buffer.from([0, query.length]), query])));
		let buffer = Buffer.alloc(0);
		socket.on('data', chunk => {
			buffer = Buffer.concat([buffer, chunk]);
			if (buffer.length >= 2 && buffer.length >= 2 + buffer.readUInt16BE(0)) {
				socket.end();
				resolve(buffer.subarray(2));
			}
		});
		socket.on('error', reject);
	});
	Assert.equal(answer.readUInt16BE(0), 0x1234);
	Assert.equal(answer.readUInt16BE(6), 1);
	Assert.ok(answer.includes(Buffer.from('second')));

	// Garbage gets no answer
	Assert.equal(server.answer(Buffer.from([1, 2, 3])), null);
});
