'use strict';

// The logs of Proxy, in the folder "logs" of the config (made when it is not there):
//
//   <site>.log   the requests of a site (data/sites/<site>.json), unless the site says "logs": false
//   error.log    what went wrong: a config or a site file that was not applied, certificates, workers, and the
//                requests that an app did not answer
//
// A file that reaches "logs_maxsize" MB becomes <name>.log.1 (the one before goes) and a new one starts, so a name
// takes at most twice that size. With workers only the primary writes: the workers send their lines to it.
//
// The lines of the requests are kept in memory and written together a few times a second: one write for all the
// requests of that moment, not one for each (a process that is killed loses those of the last moment). What goes to
// error.log is written at once.

const Fs = require('node:fs');
const Path = require('node:path');

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const MB = 1024 * 1024;
// How long the lines of the requests wait for the others, and how many bytes are written without waiting
const WAIT = 250;
const FULL = 256 * 1024;

// The time of now as the lines have it: made once for all the requests of the same millisecond
let stampAt = 0;
let stamp = '';
function timestamp() {
	const now = Date.now();
	if (now !== stampAt) {
		stampAt = now;
		stamp = new Date(now).toISOString();
	}
	return stamp;
}

// One line of at most 8000 characters, whatever the message has in it
function clean(message) {
	message = String(message);
	if (message.length > 8000)
		message = message.substring(0, 8000) + '…';
	// eslint-disable-next-line no-control-regex
	return message.replace(/[\r\n]+/g, ' | ').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '?');
}

class FileLog {

	constructor(owner, name) {
		this.owner = owner;
		this.file = Path.join(owner.folder, name + '.log');
		this.size = 0;
		this.waiting = false;
		this.stream = null;
		this.idle = null;
		this.retryAt = 0;
	}

	write(line) {
		if (!this.stream && Date.now() >= this.retryAt)
			this.open();
		if (!this.stream || this.waiting)
			return;
		if (this.idle)
			this.idle.refresh();
		else
			this.idle = setTimeout(() => this.close(), 60000).unref();
		const bytes = Buffer.byteLength(line);
		if (this.size + bytes > this.owner.maxsize) {
			// Several lines that do not fit together: one by one, so the file is full at a line and not past it
			const end = line.indexOf('\n');
			if (end !== -1 && end !== line.length - 1) {
				for (const part of line.split('\n'))
					part && this.write(part + '\n');
				return;
			}
			// A line that is larger than a whole file still gets one
			if (this.size) {
				this.rotate();
				if (!this.stream)
					return;
			}
		}
		this.size += bytes;
		if (!this.stream.write(line)) {
			const stream = this.stream;
			this.waiting = true;
			stream.once('drain', () => this.stream === stream && (this.waiting = false));
		}
	}

	// What is still on its way to the disk ends in the old file: the stream keeps it open until then
	rotate() {
		this.close();
		try {
			Fs.renameSync(this.file, this.file + '.1');
		} catch {}
		this.open();
	}

	open() {
		this.close();
		this.retryAt = Date.now() + 5000;
		try {
			Fs.mkdirSync(this.owner.folder, { recursive: true, mode: 0o700 });
			// Never through a link that someone left in the folder
			const flags = Fs.constants.O_WRONLY | Fs.constants.O_CREAT | Fs.constants.O_APPEND | Fs.constants.O_NOFOLLOW | Fs.constants.O_NONBLOCK;
			const fd = Fs.openSync(this.file, flags, 0o600);
			const info = Fs.fstatSync(fd);
			if (!info.isFile()) {
				Fs.closeSync(fd);
				return;
			}
			const stream = Fs.createWriteStream(this.file, { fd });
			this.size = info.size;
			this.waiting = false;
			this.stream = stream;
			this.retryAt = 0;
			stream.on('error', () => {
				if (this.stream === stream)
					this.stream = null;
			});
		} catch {
			this.stream = null;
		}
	}

	close() {
		clearTimeout(this.idle);
		this.idle = null;
		if (this.stream) {
			const stream = this.stream;
			this.stream = null;
			stream.end();
			return stream;
		}
		return null;
	}
}

class Logs {

	// folder: '' writes nothing; maxsize: MB of one file; send: in a worker, the function that takes its lines to the
	// primary ({ name: text })
	constructor(folder, maxsize, send) {
		this.folder = folder;
		this.maxsize = maxsize * MB;
		this.send = send || null;
		this.files = new Map();
		this.pending = null;
		this.bytes = 0;
		this.timer = null;
	}

	// The folder is there from the start, not from the first line
	prepare() {
		if (!this.folder || this.send)
			return;
		try {
			Fs.mkdirSync(this.folder, { recursive: true, mode: 0o700 });
		} catch {}
	}

	// A request that ended
	// status: of the answer (499: the client went away before it ended; 101: a WebSocket that was opened)
	access(site, req, status, ip, host, started) {
		if (!this.folder)
			return;
		this.write(site, timestamp() + ' ' + (ip || '-') + ' ' + (host || '-') + ' ' + req.method + ' ' + JSON.stringify(req.url) + ' ' + status + ' ' + (Date.now() - started) + ' ' + JSON.stringify(String(req.headers['user-agent'] || '')) + '\n');
	}

	error(message) {
		if (!this.folder)
			return;
		this.write('error', new Date().toISOString() + '  ' + clean(message) + '\n');
		// What went wrong is not kept waiting
		this.flush();
	}

	write(name, text) {
		if (!this.folder || !NAME.test(name))
			return;
		// The lines wait for the others of this moment (in a worker: on their way to the primary)
		if (!this.pending)
			this.pending = {};
		this.pending[name] = (this.pending[name] || '') + text;
		this.bytes += text.length;
		if (this.bytes > FULL)
			this.flush();
		else if (!this.timer)
			this.timer = setTimeout(() => this.flush(), WAIT).unref();
	}

	// To the file of a name, now
	store(name, text) {
		let file = this.files.get(name);
		if (!file) {
			file = new FileLog(this, name);
			this.files.set(name, file);
		}
		file.write(text);
	}

	// The lines of a worker, in the primary: { name: text }
	take(lines) {
		if (!lines || typeof lines !== 'object')
			return;
		for (const name in lines) {
			if (typeof lines[name] === 'string' && NAME.test(name))
				this.store(name, lines[name]);
		}
	}

	flush() {
		clearTimeout(this.timer);
		this.timer = null;
		if (!this.pending)
			return;
		const lines = this.pending;
		this.pending = null;
		this.bytes = 0;
		if (this.send)
			this.send(lines);
		else {
			for (const name in lines)
				this.store(name, lines[name]);
		}
	}

	// Resolves when everything is on the disk
	close() {
		this.flush();
		if (this.send)
			return Promise.resolve();
		const closing = [];
		for (const file of this.files.values()) {
			const stream = file.close();
			stream && closing.push(new Promise(resolve => stream.once('close', resolve)));
		}
		this.files.clear();
		return Promise.all(closing);
	}
}

Logs.clean = clean;
module.exports = Logs;
