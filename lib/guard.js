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

// Wrong passwords: an address may be wrong a few times (a typo, an old password in the browser), then it waits before
// each next try, longer every time, up to 5 minutes. A right password or 15 minutes without a try forget it.
// And scrypt, which is slow on purpose, runs for a few requests at once: a flood of wrong passwords does not take the
// threads that compress and write for every site.
const FAILED = new Map();
const FAILEDMAX = 20000;
const FREE = 5;
const FORGET = 15 * 60 * 1000;
const LIMITS = { verifying: 8 };
let verifying = 0;

// Seconds an address has to wait before its next try (0: it may try)
function waiting(ip, now) {
	const item = FAILED.get(ip);
	if (!item)
		return 0;
	now = now || Date.now();
	if (now - item.last > FORGET) {
		FAILED.delete(ip);
		return 0;
	}
	return item.until > now ? Math.ceil((item.until - now) / 1000) : 0;
}

function failed(ip, now) {
	if (!ip)
		return;
	now = now || Date.now();
	let item = FAILED.get(ip);
	if (!item || now - item.last > FORGET) {
		if (FAILED.size >= FAILEDMAX)
			FAILED.delete(FAILED.keys().next().value);
		item = { count: 0, until: 0, last: now };
		FAILED.set(ip, item);
	}
	item.count++;
	item.last = now;
	if (item.count > FREE)
		item.until = now + Math.min(2 ** (item.count - FREE), 300) * 1000;
}

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
// ip: who asks. With it the answer can also be a number: the seconds that address has to wait (too many wrong
// passwords, or too many being checked right now).
async function authorized(route, header, ip) {
	if (!route.auth)
		return true;
	header = String(header || '');
	if (!header.startsWith('Basic ') || header.length > 1024)
		return false;

	const memo = route.id + ' ' + Crypto.createHash('sha256').update(header).digest('hex');
	const known = KNOWN.get(memo);
	if (known && known.expire > Date.now() && known.hashes === route.$authkey) {
		ip && FAILED.size && FAILED.delete(ip);
		return true;
	}

	// A right password that is remembered above costs nothing; a new one is checked only when the address may try
	if (ip) {
		const wait = waiting(ip);
		if (wait)
			return wait;
		if (verifying >= LIMITS.verifying)
			return 1;
	}

	const text = Buffer.from(header.substring(6), 'base64').toString('utf8');
	const index = text.indexOf(':');
	if (index === -1) {
		failed(ip);
		return false;
	}
	const user = route.auth.find(item => item.user === text.substring(0, index));
	verifying++;
	let right = false;
	try {
		right = await verify(user ? user.hash : DUMMY, text.substring(index + 1));
	} finally {
		verifying--;
	}
	if (!user || !right) {
		failed(ip);
		return false;
	}
	ip && FAILED.delete(ip);

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
exports.waiting = waiting;
exports.failed = failed;
exports.limits = LIMITS;
exports.forget = () => FAILED.clear();
