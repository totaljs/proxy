'use strict';

// Host names: checking, normalizing and wildcard matching.
// Only ASCII names are accepted: international names come already in punycode (xn--).

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function normalize(host) {
	if (typeof host !== 'string')
		return '';
	host = host.trim().toLowerCase();
	if (host.endsWith('.'))
		host = host.substring(0, host.length - 1);
	return host;
}

// wildcard: true accepts "*.example.com" (one label only, at least three labels in total)
function valid(host, wildcard) {

	if (!host || host.length > 253)
		return false;

	const labels = host.split('.');

	if (labels[0] === '*') {
		if (!wildcard || labels.length < 3)
			return false;
		labels.shift();
	}

	if (labels.length < 2)
		return false;

	// The top-level label is never all digits (that would be an IP address)
	if (/^[0-9]+$/.test(labels[labels.length - 1]))
		return false;

	return labels.every(label => LABEL.test(label));
}

// The host of a "Host" header, without its port. Empty when it is not a valid name.
function fromheader(value) {

	if (!value || typeof value !== 'string' || value[0] === '[')
		return '';

	const index = value.indexOf(':');
	if (index !== -1)
		value = value.substring(0, index);

	value = normalize(value);
	return valid(value, false) ? value : '';
}

// "a.b.example.com" -> "*.b.example.com"
function wildcard(host) {
	const index = host.indexOf('.');
	return index === -1 ? '' : '*' + host.substring(index);
}

// "*.example.com" -> "example.com"
function base(host) {
	return host.startsWith('*.') ? host.substring(2) : host;
}

exports.normalize = normalize;
exports.valid = valid;
exports.fromheader = fromheader;
exports.wildcard = wildcard;
exports.base = base;
