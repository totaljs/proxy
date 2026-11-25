'use strict';

const Path = require('node:path');

const field = (value, name) => {
	if (typeof value !== 'string' || value.length > 512 || value.trim() !== value || !/^[a-z0-9_][a-z0-9_.-]*(?:\/[a-z0-9_][a-z0-9_.-]*)*$/i.test(value))
		throw new Error(name + ' must be a relative path inside custom_cert_dir');
	return value;
};

exports.pair = function(input) {
	return { cert_file: field(input.cert_file, 'cert_file'), key_file: field(input.key_file, 'key_file') };
};

exports.configured = function(source) {
	const result = new Map();
	if (!source)
		return result;
	const input = JSON.parse(source);
	if (!input || typeof input !== 'object' || Array.isArray(input))
		throw new Error('PROXY_CUSTOM_CERTS must be an object keyed by route ID');
	for (const [id, files] of Object.entries(input)) {
		if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id) || !files || typeof files !== 'object' || Array.isArray(files))
			throw new Error('Invalid route or certificate files in PROXY_CUSTOM_CERTS');
		result.set(id, exports.pair(files));
	}
	return result;
};

exports.inside = function(root, filename) {
	const relative = Path.relative(root, filename);
	return relative && relative !== '..' && !relative.startsWith('..' + Path.sep) && !Path.isAbsolute(relative);
};
