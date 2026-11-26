'use strict';

// The requests of each site, counted: how many, with which answer, how long they took. A proxy counts and does not
// look inside: no pages, no visitors, no user agents (all of that is in logs/<site>.log for whoever wants to work it
// out). A request costs a few additions in memory; nothing is written or sent while it is served.
//
// data/stats/<site>.json:
//
//   { "total": { "requests": 0, "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, "ms": 0, "failed": 0, "websockets": 0 },
//     "days": { "2026-11-26": { the same counters, "hours": [requests of each hour, UTC] } } }
//
//   ms: the time of all the answers together (ms / requests is the average); failed: the requests that the app did not
//   answer; websockets: the WebSocket connections that were opened.
//
// The counters are added to the day every few seconds and written every minute, for the sites that had requests. Days
// older than "stats_days" go. With workers, each one counts by itself and sends what it counted to the primary a few
// times a minute: one message for all the sites, whatever the traffic.

const Fs = require('node:fs');
const Path = require('node:path');

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const FIELDS = ['requests', '2xx', '3xx', '4xx', '5xx', 'ms', 'failed', 'websockets'];
const REQUESTS = 0;
const MS = 5;
const FAILED = 6;
const WEBSOCKETS = 7;
const DAY = 86400000;

function empty() {
	const output = {};
	for (const field of FIELDS)
		output[field] = 0;
	return output;
}

function number(value) {
	return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

class Stats {

	// options: { send(counted) in a worker, fold (ms), save (ms) }
	constructor(folder, days, options) {
		options = options || {};
		this.folder = folder;
		this.days = days || 400;
		this.send = options.send || null;
		// What was counted and is not in a day yet: site → [requests, 2xx, 3xx, 4xx, 5xx, ms, failed, websockets]
		this.counted = new Map();
		// The files in memory: site → { total, days }
		this.sites = new Map();
		this.dirty = new Set();
		this.foldEvery = options.fold || 5000;
		this.saveEvery = options.save || 60000;
		this.timers = [];
	}

	start() {
		if (this.timers.length)
			return;
		this.timers.push(setInterval(() => this.fold(), this.foldEvery));
		if (!this.send)
			this.timers.push(setInterval(() => this.save(), this.saveEvery));
		for (const timer of this.timers)
			timer.unref();
	}

	stop() {
		for (const timer of this.timers)
			clearInterval(timer);
		this.timers = [];
		this.fold();
		this.save();
	}

	counters(id) {
		let item = this.counted.get(id);
		if (!item) {
			item = [0, 0, 0, 0, 0, 0, 0, 0];
			this.counted.set(id, item);
		}
		return item;
	}

	// A request of a site that ended
	hit(id, status, ms) {
		const item = this.counted.get(id) || this.counters(id);
		item[REQUESTS]++;
		const kind = (status / 100) | 0;
		if (kind >= 2 && kind <= 5)
			item[kind - 1]++;
		item[MS] += ms;
	}

	// A request that the app did not answer
	failed(id) {
		this.counters(id)[FAILED]++;
	}

	// A WebSocket that was opened
	websocket(id) {
		this.counters(id)[WEBSOCKETS]++;
	}

	// What a worker counted: { site: [counters] }
	take(counted) {
		if (!counted || typeof counted !== 'object')
			return;
		for (const id in counted) {
			const values = counted[id];
			if (!NAME.test(id) || !Array.isArray(values))
				continue;
			const item = this.counters(id);
			for (let i = 0; i < item.length; i++)
				item[i] += number(values[i]);
		}
	}

	file(id) {
		return Path.join(this.folder, id + '.json');
	}

	load(id) {
		let site = this.sites.get(id);
		if (site)
			return site;
		site = { total: empty(), days: {} };
		try {
			const saved = JSON.parse(Fs.readFileSync(this.file(id), 'utf8'));
			if (saved && typeof saved === 'object' && saved.total && saved.days && typeof saved.days === 'object') {
				for (const field of FIELDS)
					site.total[field] = number(saved.total[field]);
				site.days = saved.days;
			}
		} catch {}
		this.sites.set(id, site);
		return site;
	}

	// What was counted goes to the day and the hour of now (in a worker: to the primary)
	fold(now) {
		if (!this.counted.size)
			return;
		const counted = this.counted;
		this.counted = new Map();
		if (this.send) {
			this.send(Object.fromEntries(counted));
			return;
		}
		const date = new Date(now || Date.now());
		const key = date.toISOString().substring(0, 10);
		const hour = date.getUTCHours();
		for (const [id, values] of counted) {
			if (!NAME.test(id))
				continue;
			const site = this.load(id);
			let day = site.days[key];
			if (!day || typeof day !== 'object' || !Array.isArray(day.hours)) {
				day = site.days[key] = empty();
				day.hours = new Array(24).fill(0);
			}
			for (let i = 0; i < FIELDS.length; i++) {
				site.total[FIELDS[i]] += values[i];
				day[FIELDS[i]] = number(day[FIELDS[i]]) + values[i];
			}
			day.hours[hour] = number(day.hours[hour]) + values[REQUESTS];
			this.dirty.add(id);
		}
	}

	save(now) {
		if (!this.dirty.size || this.send)
			return;
		const limit = new Date((now || Date.now()) - this.days * DAY).toISOString().substring(0, 10);
		try {
			Fs.mkdirSync(this.folder, { recursive: true, mode: 0o700 });
		} catch {}
		for (const id of this.dirty) {
			const site = this.sites.get(id);
			if (!site)
				continue;
			for (const key of Object.keys(site.days)) {
				if (key < limit)
					delete site.days[key];
			}
			try {
				const file = this.file(id);
				Fs.writeFileSync(file + '.tmp', JSON.stringify(site));
				Fs.renameSync(file + '.tmp', file);
			} catch {}
		}
		this.dirty.clear();
	}

	// The counters of a site as they are now, with what is not written yet
	get(id) {
		this.fold();
		return NAME.test(id) ? this.load(id) : null;
	}
}

Stats.FIELDS = FIELDS;
module.exports = Stats;
