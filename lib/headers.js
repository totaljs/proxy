'use strict';

const { validateHeaderValue } = require('node:http');

// Extra response headers: for every site (the "headers" key of the config) and for one route (its "headers").
// They are added only when the app did not send the same header, so an app can always set its own.

const NAME = /^[a-z0-9!#$%&'*+.^_`|~-]{1,64}$/i;

// Headers that belong to the connection or to the body: never set by hand
const BLOCKED = new Set(['connection', 'content-length', 'content-encoding', 'transfer-encoding', 'keep-alive', 'upgrade', 'trailer', 'te', 'set-cookie', 'host', 'date']);

function fail(message) {
	const err = new Error(message);
	err.status = 400;
	return err;
}

function validvalue(name, value) {
	try {
		validateHeaderValue(name, value);
		return true;
	} catch {
		return false;
	}
}

// [[name, value], ...] from an object { name: value } or a text "Name: value | Name: value"
function parse(input, where) {

	if (input == null || input === '')
		return [];

	let pairs;

	if (typeof input === 'string') {
		pairs = input.split('|').map(item => item.trim()).filter(Boolean).map(function(item) {
			const index = item.indexOf(':');
			if (index === -1)
				throw fail(where + ': "' + item + '" needs "Name: value"');
			return [item.substring(0, index).trim(), item.substring(index + 1).trim()];
		});
	} else if (typeof input === 'object' && !Array.isArray(input))
		pairs = Object.keys(input).map(key => [key, input[key]]);
	else
		throw fail(where + ' must be an object of headers');

	if (pairs.length > 30)
		throw fail(where + ': at most 30 headers');

	const output = [];
	for (const [name, value] of pairs) {
		const key = String(name).toLowerCase();
		const text = String(value == null ? '' : value);
		if (!NAME.test(key) || BLOCKED.has(key))
			throw fail(where + ': the header "' + name + '" cannot be set');
		if (!text || text.length > 4096 || !validvalue(key, text))
			throw fail(where + ': the value of "' + name + '" is not valid');
		if (!output.some(item => item[0] === key))
			output.push([key, text]);
	}
	return output;
}

// Adds the headers that the response does not have. HSTS goes only over HTTPS.
function fill(headers, list, secure) {
	for (const [name, value] of list) {
		if (name === 'strict-transport-security' && !secure)
			continue;
		if (headers[name] == null)
			headers[name] = value;
	}
}

exports.parse = parse;
exports.fill = fill;
exports.validvalue = validvalue;
