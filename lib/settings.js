'use strict';

// Settings shared by every site, managed through the control API and stored in
// data/settings.json: addresses that never come in, the limit of requests of each address, the headers and HSTS of
// every site (they win over the config file), and the page shown while an app does not answer.

const Fs = require('node:fs');
const Routes = require('./routes');
const Headers = require('./headers');

// The largest page, as the one of a site
const PAGE = 512 * 1024;

function fail(message) {
	const err = new Error(message);
	err.status = 400;
	return err;
}

function validate(input) {
	if (!input || typeof input !== 'object' || Array.isArray(input))
		throw fail('The settings must be an object');

	const output = {};

	const deny = Routes.addresses(input.deny, 'deny');
	if (deny.length)
		output.deny = deny;

	// Requests a second of each address, and how many may come at once (a page with its images, styles and scripts)
	if (input.ratelimit) {
		const rate = Number(input.ratelimit.rate);
		const burst = Number(input.ratelimit.burst);
		if (!Number.isInteger(rate) || rate < 1 || rate > 100000)
			throw fail('ratelimit.rate must be a whole number of requests a second, from 1');
		if (!Number.isInteger(burst) || burst < rate || burst > 1000000)
			throw fail('ratelimit.burst must be a whole number, at least the rate');
		output.ratelimit = { rate, burst };
	}

	if (input.headers != null && input.headers !== '') {
		const headers = Headers.parse(Array.isArray(input.headers) ? input.headers.join(' | ') : input.headers, 'headers');
		if (headers.length)
			output.headers = Object.fromEntries(headers);
	}

	if (input.hsts != null && input.hsts !== '') {
		const hsts = String(input.hsts).trim();
		if (!Headers.validvalue('strict-transport-security', hsts) || !(/max-age=\d+/).test(hsts) || hsts.length > 200)
			throw fail('hsts needs max-age=<seconds>');
		output.hsts = hsts;
	}

	if (input.page != null && input.page !== '') {
		if (typeof input.page !== 'string' || Buffer.byteLength(input.page) > PAGE)
			throw fail('page must be HTML of at most 512 KB');
		output.page = input.page;
	}

	return output;
}

class Settings {

	constructor(filename) {
		this.filename = filename;
		this.apply({});
	}

	load() {
		let data = {};
		try {
			data = JSON.parse(Fs.readFileSync(this.filename, 'utf8'));
		} catch (e) {
			if (e.code !== 'ENOENT')
				throw e;
		}
		this.apply(validate(data));
	}

	apply(values) {
		this.values = values;
		this.$deny = values.deny ? Routes.blocklist(values.deny) : null;
		this.$headers = values.headers ? Object.entries(values.headers) : null;
		this.$page = values.page ? Buffer.from(values.page) : null;
	}

	get() {
		return this.values;
	}

	set(input) {
		const values = validate(input);
		const tmp = this.filename + '.tmp';
		Fs.writeFileSync(tmp, JSON.stringify(values, null, '\t'), { mode: 0o600 });
		Fs.renameSync(tmp, this.filename);
		this.apply(values);
		return values;
	}

	// true when the address never comes in
	denied(ip) {
		if (!this.$deny || !ip)
			return false;
		try {
			return this.$deny.check(ip, ip.includes(':') ? 'ipv6' : 'ipv4');
		} catch {
			return false;
		}
	}
}

Settings.validate = validate;

module.exports = Settings;
