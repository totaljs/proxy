'use strict';

// A tiny authoritative DNS server for one zone, only for the DNS checks of ACME.
//
// For a wildcard certificate of *.example.com, the owner of example.com creates once:
//     _acme-challenge.example.com  CNAME  <label>.<dns_zone>
// and delegates <dns_zone> to the proxy (an NS record). The proxy then answers the TXT values
// for <label>.<dns_zone> while Let's Encrypt checks, and nothing else.

const Dgram = require('node:dgram');
const Net = require('node:net');

const TYPE = { A: 1, NS: 2, CNAME: 5, SOA: 6, TXT: 16, AAAA: 28, ANY: 255 };
const RCODE = { NOERROR: 0, FORMERR: 1, NXDOMAIN: 3, NOTIMP: 4, REFUSED: 5 };

// Points to the name of the question, right after the 12-byte header
const POINTER = Buffer.from([0xc0, 0x0c]);

function u16(n) {
	const buffer = Buffer.alloc(2);
	buffer.writeUInt16BE(n);
	return buffer;
}

function u32(n) {
	const buffer = Buffer.alloc(4);
	buffer.writeUInt32BE(n >>> 0);
	return buffer;
}

function readname(buffer, offset) {
	const labels = [];
	let end = -1;
	let hops = 0;
	for (;;) {
		if (offset >= buffer.length)
			return null;
		const len = buffer[offset];
		if (len === 0) {
			if (end === -1)
				end = offset + 1;
			break;
		}
		if ((len & 0xc0) === 0xc0) {
			if (offset + 1 >= buffer.length || ++hops > 16)
				return null;
			if (end === -1)
				end = offset + 2;
			offset = ((len & 0x3f) << 8) | buffer[offset + 1];
			continue;
		}
		if (len > 63 || offset + 1 + len > buffer.length)
			return null;
		labels.push(buffer.toString('latin1', offset + 1, offset + 1 + len));
		offset += 1 + len;
	}
	return { name: labels.join('.'), end };
}

function writename(name) {
	const chunks = [];
	for (const label of name ? name.split('.') : []) {
		const bytes = Buffer.from(label, 'latin1');
		chunks.push(Buffer.from([bytes.length]), bytes);
	}
	chunks.push(Buffer.from([0]));
	return Buffer.concat(chunks);
}

function record(name, type, ttl, rdata) {
	return Buffer.concat([name, u16(type), u16(1), u32(ttl), u16(rdata.length), rdata]);
}

function txt(value) {
	const bytes = Buffer.from(value, 'utf8');
	const chunks = [];
	for (let i = 0; i < bytes.length || i === 0; i += 255) {
		const part = bytes.subarray(i, i + 255);
		chunks.push(Buffer.from([part.length]), part);
	}
	return Buffer.concat(chunks);
}

function parse(buffer) {
	if (buffer.length < 12)
		return null;
	const flags = buffer.readUInt16BE(2);
	if (flags & 0x8000)
		return null;
	const query = { id: buffer.readUInt16BE(0), flags, opcode: (flags >> 11) & 15, question: null };
	if (query.opcode !== 0) {
		query.error = RCODE.NOTIMP;
		return query;
	}
	if (buffer.readUInt16BE(4) !== 1) {
		query.error = RCODE.FORMERR;
		return query;
	}
	const name = readname(buffer, 12);
	if (!name || name.end + 4 > buffer.length) {
		query.error = RCODE.FORMERR;
		return query;
	}
	query.name = name.name.toLowerCase();
	query.type = buffer.readUInt16BE(name.end);
	query.class = buffer.readUInt16BE(name.end + 2);
	query.question = buffer.subarray(12, name.end + 4);
	return query;
}

function build(query, rcode, answers, authority, authoritative) {
	const header = Buffer.alloc(12);
	header.writeUInt16BE(query.id, 0);
	header.writeUInt16BE(0x8000 | (query.opcode << 11) | (authoritative ? 0x0400 : 0) | (query.flags & 0x0100) | rcode, 2);
	header.writeUInt16BE(query.question ? 1 : 0, 4);
	header.writeUInt16BE(answers.length, 6);
	header.writeUInt16BE(authority.length, 8);
	return Buffer.concat([header, query.question || Buffer.alloc(0)].concat(answers, authority));
}

class Server {

	// options: { zone, ns }
	constructor(options) {
		this.zone = options.zone;
		this.ns = options.ns || '';
		this.records = new Map();
		this.udp = null;
		this.tcp = null;
	}

	add(name, value) {
		name = name.toLowerCase();
		let values = this.records.get(name);
		if (!values)
			this.records.set(name, values = new Set());
		values.add(value);
	}

	remove(name, value) {
		name = name.toLowerCase();
		const values = this.records.get(name);
		if (!values)
			return;
		values.delete(value);
		if (!values.size)
			this.records.delete(name);
	}

	soa() {
		const rdata = Buffer.concat([writename(this.ns || this.zone), writename('hostmaster.' + this.zone), u32(Math.floor(Date.now() / 1000)), u32(3600), u32(600), u32(86400), u32(0)]);
		return { rdata, record: record(writename(this.zone), TYPE.SOA, 0, rdata) };
	}

	answer(buffer) {

		const query = parse(buffer);
		if (!query)
			return null;

		if (query.error)
			return build(query, query.error, [], [], false);

		const zone = this.zone;

		if (query.class !== 1 || (query.name !== zone && !query.name.endsWith('.' + zone)))
			return build(query, RCODE.REFUSED, [], [], false);

		const soa = this.soa();

		if (query.name === zone) {
			if (query.type === TYPE.SOA)
				return build(query, RCODE.NOERROR, [record(POINTER, TYPE.SOA, 60, soa.rdata)], [], true);
			if (query.type === TYPE.NS && this.ns)
				return build(query, RCODE.NOERROR, [record(POINTER, TYPE.NS, 60, writename(this.ns))], [], true);
			return build(query, RCODE.NOERROR, [], [soa.record], true);
		}

		const values = this.records.get(query.name);
		if (!values)
			return build(query, RCODE.NXDOMAIN, [], [soa.record], true);

		if (query.type === TYPE.TXT || query.type === TYPE.ANY)
			return build(query, RCODE.NOERROR, [...values].map(value => record(POINTER, TYPE.TXT, 0, txt(value))), [], true);

		return build(query, RCODE.NOERROR, [], [soa.record], true);
	}

	// Listens on UDP and TCP on the same port; returns the port
	listen(port, host) {
		host = host || '0.0.0.0';
		return new Promise((resolve, reject) => {
			const udp = Dgram.createSocket('udp4');
			udp.on('message', (message, info) => {
				const output = this.answer(message);
				if (output)
					udp.send(output, info.port, info.address);
			});
			udp.once('error', reject);
			udp.bind(port, host, () => {
				udp.removeListener('error', reject);
				udp.on('error', () => {});
				const actual = udp.address().port;
				const tcp = Net.createServer(socket => this.stream(socket));
				tcp.once('error', err => {
					udp.close();
					reject(err);
				});
				tcp.listen(actual, host, () => {
					this.udp = udp;
					this.tcp = tcp;
					resolve(actual);
				});
			});
		});
	}

	stream(socket) {
		let buffer = Buffer.alloc(0);
		socket.setTimeout(10000, () => socket.destroy());
		socket.on('error', () => {});
		socket.on('data', chunk => {
			buffer = Buffer.concat([buffer, chunk]);
			if (buffer.length > 65537) {
				socket.destroy();
				return;
			}
			while (buffer.length >= 2) {
				const len = buffer.readUInt16BE(0);
				if (buffer.length < 2 + len)
					break;
				const message = buffer.subarray(2, 2 + len);
				buffer = buffer.subarray(2 + len);
				const output = this.answer(message);
				if (output)
					socket.write(Buffer.concat([u16(output.length), output]));
			}
		});
	}

	close() {
		this.udp && this.udp.close();
		this.tcp && this.tcp.close();
		this.udp = this.tcp = null;
	}
}

exports.Server = Server;
exports.TYPE = TYPE;
exports.RCODE = RCODE;
exports.parse = parse;
exports.build = build;
exports.record = record;
exports.writename = writename;
exports.txt = txt;
exports.POINTER = POINTER;
