'use strict';

// The limit of requests of each address: a bucket per address that holds "burst" requests and fills with "rate" a
// second. A browser that loads a page with all its files fits; a robot that asks without pause waits (429).

// Addresses kept at most: past this, the oldest buckets go (a flood of new addresses never fills the memory)
const MAX = 100000;

class Limiter {

	constructor() {
		this.buckets = new Map();
		this.rate = 0;
		this.burst = 0;
		this.timer = null;
	}

	// { rate, burst } or null (off)
	set(options) {
		this.rate = options ? options.rate : 0;
		this.burst = options ? options.burst : 0;
		this.buckets.clear();
	}

	start() {
		// Full buckets are forgotten: an address that came a while ago starts again with a full one anyway
		this.timer = setInterval(() => this.sweep(), 60000);
		this.timer.unref();
	}

	stop() {
		clearInterval(this.timer);
		this.timer = null;
	}

	sweep(now) {
		now = now || Date.now();
		for (const [ip, bucket] of this.buckets) {
			if (bucket.tokens + (now - bucket.time) / 1000 * this.rate >= this.burst)
				this.buckets.delete(ip);
		}
	}

	// 0 when the request may go, else the seconds to wait
	take(ip, now) {
		if (!this.rate || !ip)
			return 0;
		now = now || Date.now();
		let bucket = this.buckets.get(ip);
		if (!bucket) {
			if (this.buckets.size >= MAX)
				this.buckets.delete(this.buckets.keys().next().value);
			bucket = { tokens: this.burst, time: now };
			this.buckets.set(ip, bucket);
		} else {
			bucket.tokens = Math.min(this.burst, bucket.tokens + (now - bucket.time) / 1000 * this.rate);
			bucket.time = now;
		}
		if (bucket.tokens >= 1) {
			bucket.tokens -= 1;
			return 0;
		}
		return Math.max(1, Math.ceil((1 - bucket.tokens) / this.rate));
	}
}

// Concurrent requests and upgrades are separate from the per-IP request rate.
class Capacity {

	constructor(total, perRoute) {
		this.total = total;
		this.perRoute = perRoute;
		this.active = 0;
		this.routes = new Map();
	}

	take(id, connection) {
		const count = this.routes.get(id) || 0;
		if (this.active >= this.total || count >= this.perRoute)
			return false;
		this.active++;
		this.routes.set(id, count + 1);
		connection.once('close', () => {
			this.active--;
			const remaining = this.routes.get(id) - 1;
			if (remaining)
				this.routes.set(id, remaining);
			else
				this.routes.delete(id);
		});
		return true;
	}
}

Limiter.Capacity = Capacity;
module.exports = Limiter;
