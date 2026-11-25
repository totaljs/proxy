'use strict';

// Just enough ASN.1 DER to write a certificate signing request (PKCS #10) for ACME.

const Crypto = require('node:crypto');

function length(n) {
	if (n < 128)
		return Buffer.from([n]);
	const bytes = [];
	while (n > 0) {
		bytes.unshift(n & 255);
		n = Math.floor(n / 256);
	}
	return Buffer.from([0x80 | bytes.length].concat(bytes));
}

function tlv(tag, body) {
	return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}

const seq = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));
const utf8 = value => tlv(0x0c, Buffer.from(value, 'utf8'));
const octet = value => tlv(0x04, value);
const bits = value => tlv(0x03, Buffer.concat([Buffer.from([0]), value]));

// [n] context tag: constructed (explicit or a SET/SEQUENCE) or primitive (implicit)
const context = (n, body, constructed) => tlv((constructed ? 0xa0 : 0x80) | n, body);

function integer(value) {
	let bytes = [];
	if (value === 0)
		bytes = [0];
	while (value > 0) {
		bytes.unshift(value & 255);
		value = Math.floor(value / 256);
	}
	if (bytes[0] & 0x80)
		bytes.unshift(0);
	return tlv(0x02, Buffer.from(bytes));
}

function oid(value) {
	const parts = value.split('.').map(Number);
	const bytes = [parts[0] * 40 + parts[1]];
	for (let i = 2; i < parts.length; i++) {
		let n = parts[i];
		const chunk = [n & 0x7f];
		n = Math.floor(n / 128);
		while (n > 0) {
			chunk.unshift((n & 0x7f) | 0x80);
			n = Math.floor(n / 128);
		}
		bytes.push(...chunk);
	}
	return tlv(0x06, Buffer.from(bytes));
}

const OID = {
	commonName: '2.5.4.3',
	subjectAltName: '2.5.29.17',
	extensionRequest: '1.2.840.113549.1.9.14',
	ecdsaWithSHA256: '1.2.840.10045.4.3.2'
};

// hosts: the names of the certificate; key: an ECDSA P-256 private KeyObject. Returns the DER bytes.
function csr(hosts, key) {

	const spki = Crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
	const cn = hosts.find(host => host.length <= 64);
	const subject = cn ? seq(set(seq(oid(OID.commonName), utf8(cn)))) : seq();

	// GeneralNames with dNSName ([2] IA5String, implicit)
	const names = seq(...hosts.map(host => context(2, Buffer.from(host, 'ascii'), false)));
	const extensions = seq(seq(oid(OID.subjectAltName), octet(names)));
	const attributes = context(0, seq(oid(OID.extensionRequest), set(extensions)), true);

	const info = seq(integer(0), subject, spki, attributes);
	const signature = Crypto.sign('sha256', info, key);

	return seq(info, seq(oid(OID.ecdsaWithSHA256)), bits(signature));
}

exports.csr = csr;
