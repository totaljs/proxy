'use strict';

// Each route gets a daily file and its own size budget. Unmatched HTTP requests
// use the deployment's original access-YYYY-MM-DD.log when logging is enabled.

const Fs = require('node:fs');
const Path = require('node:path');

class FileLog {

	constructor(root, directory, id, days, maxsize, prefix) {
		this.root = root;
		this.target = Path.join(root, directory);
		this.prefix = prefix || (id ? 'access-' + id + '-' : 'access-');
		this.days = days || 14;
		this.maxsize = (maxsize || 500) * 1024 * 1024;
		this.size = 0;
		this.full = false;
		this.waiting = false;
		this.day = '';
		this.stream = null;
		this.idle = null;
		this.retryAt = 0;
	}

	write(line, now) {
		const day = now.toISOString().substring(0, 10);
		if ((day !== this.day || !this.stream) && Date.now() >= this.retryAt)
			this.open(day);
		if (!this.stream || this.waiting)
			return;
		if (this.idle)
			this.idle.refresh();
		else
			this.idle = setTimeout(() => this.close(), 60000).unref();
		const bytes = Buffer.byteLength(line);
		if (this.size + bytes > this.maxsize) {
			if (!this.full) {
				this.full = true;
				const notice = now.toISOString() + ' - - - - - - "the log of today is full: the next lines are tomorrow"\n';
				const noticeBytes = Buffer.byteLength(notice);
				if (this.size + noticeBytes <= this.maxsize) {
					this.size += noticeBytes;
					this.stream.write(notice);
				}
			}
			return;
		}
		this.size += bytes;
		if (!this.stream.write(line)) {
			this.waiting = true;
			this.stream.once('drain', () => this.waiting = false);
		}
	}

	open(day) {
		this.close();
		const newDay = day !== this.day;
		this.retryAt = Date.now() + 5000;
		try {
			Fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
			const root = Fs.realpathSync(this.root);
			let directory = root;
			for (const segment of Path.relative(this.root, this.target).split(Path.sep).filter(Boolean)) {
				directory = Path.join(directory, segment);
				try {
					Fs.mkdirSync(directory, { mode: 0o700 });
				} catch (err) {
					if (err.code !== 'EEXIST')
						throw err;
				}
				if (!Fs.lstatSync(directory).isDirectory())
					return;
			}
			const target = Fs.realpathSync(this.target);
			const relative = Path.relative(root, target);
			if (relative === '..' || relative.startsWith('..' + Path.sep) || Path.isAbsolute(relative))
				return;
			const file = Path.join(target, this.prefix + day + '.log');
			try {
				const size = Fs.lstatSync(file).size;
				this.size = newDay ? size : Math.max(this.size, size);
			} catch {
				if (newDay)
					this.size = 0;
			}
			if (newDay)
				this.full = false;
			this.waiting = false;
			const flags = Fs.constants.O_WRONLY | Fs.constants.O_CREAT | Fs.constants.O_APPEND | Fs.constants.O_NOFOLLOW | Fs.constants.O_NONBLOCK;
			const fd = Fs.openSync(file, flags, 0o600);
			if (!Fs.fstatSync(fd).isFile()) {
				Fs.closeSync(fd);
				return;
			}
			const stream = Fs.createWriteStream(file, { fd });
			this.stream = stream;
			this.day = day;
			this.retryAt = 0;
			stream.on('error', () => {
				if (this.stream === stream)
					this.stream = null;
			});
			if (newDay)
				this.prune(target);
		} catch {
			this.stream = null;
		}
	}

	prune(target) {
		const limit = new Date(Date.now() - this.days * 86400000).toISOString().substring(0, 10);
		let names = [];
		try {
			names = Fs.readdirSync(target);
		} catch {}
		for (const name of names) {
			const match = name.startsWith(this.prefix) && /^(\d{4}-\d{2}-\d{2})\.log$/.exec(name.slice(this.prefix.length));
			if (match && match[1] < limit)
				Fs.rm(Path.join(target, name), () => {});
		}
	}

	close() {
		clearTimeout(this.idle);
		this.idle = null;
		if (this.stream) {
			const stream = this.stream;
			this.stream = null;
			stream.end();
		}
	}
}

class AccessLog {

	constructor(target, days, maxsize) {
		this.target = target;
		this.days = days;
		this.maxsize = maxsize;
		this.files = new Map();
	}

	write(req, res, ip, host, started, route) {
		if (!this.target)
			return;
		const now = new Date();
		const line = [now.toISOString(), ip || '-', host || '-', req.method, JSON.stringify(req.url), res.statusCode, Date.now() - started, JSON.stringify(String(req.headers['user-agent'] || ''))].join(' ') + '\n';
		if (this.target === 'stdout') {
			process.stdout.write(line);
			return;
		}

		const id = route?.id || '';
		const directory = route?.accesslog_dir || '';
		const key = directory + '/' + id;
		let file = this.files.get(key);
		if (!file) {
			file = new FileLog(this.target, directory, id, this.days, this.maxsize);
			this.files.set(key, file);
		}
		file.write(line, now);
	}

	close() {
		for (const file of this.files.values())
			file.close();
		this.files.clear();
	}
}

module.exports = AccessLog;

// Operational messages are separate from access records.
module.exports.Events = class {
	constructor(target) {
		this.target = target || 'stdout';
		this.file = this.target === 'stdout' || this.target === 'off' ? null : new FileLog(this.target, '', '', 14, 50, 'proxy-');
	}

	write(message) {
		const now = new Date();
		const line = now.toISOString() + '  ' + message;
		if (this.file)
			this.file.write(line + '\n', now);
		else if (this.target === 'stdout')
			console.log(line);
	}

	close() {
		const stream = this.file?.stream;
		if (!stream)
			return;
		return new Promise(resolve => {
			stream.once('close', resolve);
			this.file.close();
		});
	}
};
