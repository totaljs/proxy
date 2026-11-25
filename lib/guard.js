'use strict';

// Who may reach a site: its allowed and blocked addresses, and its users (HTTP Basic).
// Passwords are kept as scrypt hashes; a right "Authorization" header is remembered for 10 minutes, so scrypt runs
// once per person and not on every request. scrypt runs off the main thread, so wrong passwords never stop the other
// sites, and an unknown user costs the same as a known one, so names cannot be found by timing.

const Crypto = require('node:crypto');
const Net = require('node:net');

const KNOWN = new Map();
const KNOWNMAX = 2000;
const KNOWNTIME = 10 * 60 * 1000;

function family(ip) {
	return Net.isIP(ip) === 4 ? 'ipv4' : 'ipv6';
}

// true when the address may come
function allowed(route, ip) {
	if (!ip)
		return false;
	if (route.$deny && route.$deny.check(ip, family(ip)))
		return false;
	if (route.$allow && !route.$allow.check(ip, family(ip)))
		return false;
	return true;
}

function verify(hash, password) {
	const [, salt, key] = hash.split('$');
	const expected = Buffer.from(key || '', 'base64');
	return new Promise(function(resolve) {
		Crypto.scrypt(password, Buffer.from(salt || '', 'base64'), expected.length || 32, function(err, given) {
			resolve(!err && given.length === expected.length && Crypto.timingSafeEqual(given, expected));
		});
	});
}

// What an unknown user is checked against
const DUMMY = 'scrypt$' + Crypto.randomBytes(16).toString('base64') + '$' + Crypto.randomBytes(32).toString('base64');

// true when the site has no users, or the request brings a right user and password (a promise when scrypt has to run)
async function authorized(route, header) {
	if (!route.auth)
		return true;
	header = String(header || '');
	if (!header.startsWith('Basic ') || header.length > 1024)
		return false;

	const memo = route.id + ' ' + Crypto.createHash('sha256').update(header).digest('hex');
	const known = KNOWN.get(memo);
	if (known && known.expire > Date.now() && known.hashes === route.$authkey)
		return true;

	const text = Buffer.from(header.substring(6), 'base64').toString('utf8');
	const index = text.indexOf(':');
	if (index === -1)
		return false;
	const user = route.auth.find(item => item.user === text.substring(0, index));
	const right = await verify(user ? user.hash : DUMMY, text.substring(index + 1));
	if (!user || !right)
		return false;

	if (KNOWN.size >= KNOWNMAX)
		KNOWN.delete(KNOWN.keys().next().value);
	KNOWN.set(memo, { expire: Date.now() + KNOWNTIME, hashes: route.$authkey });
	return true;
}

// Makes a hash for the tests and for anyone who writes routes by hand: node -e "console.log(require('./lib/guard').hash('pass'))"
function hash(password) {
	const salt = Crypto.randomBytes(16);
	return 'scrypt$' + salt.toString('base64') + '$' + Crypto.scryptSync(password, salt, 32).toString('base64');
}

exports.allowed = allowed;
exports.authorized = authorized;
exports.hash = hash;
