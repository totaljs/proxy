'use strict';

// The visits of the sites that ask for it (route option "stats"): counters per route and day, without cookies and
// without personal data. A visitor is a hash of the address, the browser and a salt that changes every day and is never
// written, so a visitor of today cannot be followed to tomorrow, and nobody can get the address back.
//
// Counted: the pages (GET, not the files of the page: scripts, styles, images, fonts). Each request says who asked:
// a person, a search engine (Googlebot…), an AI agent (GPTBot, ClaudeBot…) or another bot.
//
// data/stats/<route>/<YYYY-MM-DD>.json, written every 5 minutes for the routes that changed, and kept "stats_days" days
// (400: a year and a month, to compare with the year before).

const Fs = require('node:fs');
const Path = require('node:path');
const Crypto = require('node:crypto');

const ASSET = /\.(js|mjs|css|map|png|jpe?g|gif|webp|avif|svg|ico|bmp|woff2?|ttf|otf|eot|mp4|webm|mov|m4a|mp3|wav|ogg|vtt|srt|pdf|zip|gz|rar|7z|wasm|json|txt|xml|rss|atom|webmanifest|csv|xlsx?|docx?)$/i;
const SEARCH = [['Googlebot', /googlebot|google-inspectiontool|storebot-google/i], ['Bingbot', /bingbot|msnbot|bingpreview/i], ['DuckDuckBot', /duckduckbot/i], ['YandexBot', /yandex(bot|images)/i], ['Baiduspider', /baiduspider/i], ['Applebot', /applebot(?!-extended)/i], ['Yahoo Slurp', /slurp/i], ['Qwant', /qwantbot|qwant/i], ['Seznam', /seznambot/i]];
const AI = [['GPTBot', /gptbot/i], ['ChatGPT-User', /chatgpt-user/i], ['OAI-SearchBot', /oai-searchbot/i], ['ClaudeBot', /claudebot/i], ['Claude-User', /claude-user/i], ['Claude-SearchBot', /claude-searchbot/i], ['anthropic-ai', /anthropic-ai/i], ['PerplexityBot', /perplexitybot/i], ['Perplexity-User', /perplexity-user/i], ['Google-Extended', /google-extended/i], ['Applebot-Extended', /applebot-extended/i], ['CCBot', /ccbot/i], ['Bytespider', /bytespider/i], ['Amazonbot', /amazonbot/i], ['Meta-ExternalAgent', /meta-externalagent|meta-externalfetcher/i], ['cohere-ai', /cohere-ai/i], ['MistralAI-User', /mistralai-user/i], ['DeepSeekBot', /deepseekbot/i]];
const BOT = /bot|crawl|spider|slurp|scrap|fetch|curl|wget|python|httpclient|okhttp|go-http|java\/|headless|phantom|lighthouse|monitor|uptime|pingdom|preview/i;

const LIMIT = { paths: 1000, referrers: 300, agents: 100, notfound: 300, errors: 300 };
const DAY = 86400000;
const VISITORS_PER_ROUTE = 50000;
const VISITORS_TOTAL = 500000;

// Who asked: { kind: 'person' | 'search' | 'ai' | 'bot', name }
function client(ua) {
	ua = String(ua || '');
	for (const [name, exp] of AI) {
		if (exp.test(ua))
			return { kind: 'ai', name };
	}
	for (const [name, exp] of SEARCH) {
		if (exp.test(ua))
			return { kind: 'search', name };
	}
	if (!ua || BOT.test(ua)) {
		// Its own name: the word with bot, crawler or spider ("SemrushBot", "AhrefsBot"), else the first word that is not
		// "Mozilla" (most robots start as a browser does)
		const named = (/([\w.-]*(?:bot|crawler|spider|scraper|fetcher|headless)[\w.-]*)/i.exec(ua) || /(?:^|[\s;(])(?!Mozilla\b)([A-Za-z][\w.-]+)\//.exec(ua) || /^([\w.-]+)/.exec(ua) || [0, 'unknown'])[1];
		return { kind: 'bot', name: named.substring(0, 40) };
	}
	return { kind: 'person', name: '' };
}

function today(time) {
	return new Date(time).toISOString().substring(0, 10);
}

function empty(day) {
	const hours = [];
	for (let i = 0; i < 24; i++)
		hours.push({ views: 0, visitors: 0, search: 0, ai: 0, bots: 0, ms: 0 });
	return { day, views: 0, visitors: 0, search: 0, ai: 0, bots: 0, ms: 0, hours, paths: {}, referrers: {}, status: {}, notfound: {}, errors: {}, agents: {} };
}

// A counter in a map with a limit: what does not fit goes to "(other)"
function bump(map, key, limit, value) {
	if (!(key in map) && Object.keys(map).length >= limit)
		key = '(other)';
	map[key] = (map[key] || 0) + (value || 1);
	return key;
}

class Stats {

	constructor(folder, days) {
		this.folder = folder;
		this.days = days || 400;
		this.current = new Map();   // route id → the counters of today
		this.seen = new Map();      // route id → Set of today's visitors (hashes, in memory only)
		this.dirty = new Set();
		this.seenCount = 0;
		this.salt = { day: '', value: null };
		this.timer = null;
		this.cleaned = '';
	}

	start() {
		this.timer = setInterval(() => this.flush(), 5 * 60000);
		this.timer.unref && this.timer.unref();
		this.clean();
	}

	stop() {
		clearInterval(this.timer);
		this.flush();
	}

	// The counters of a route for a day: from memory for today, else from its file
	load(id, day) {
		const file = Path.join(this.folder, id, day + '.json');
		try {
			return JSON.parse(Fs.readFileSync(file, 'utf8'));
		} catch {
			return null;
		}
	}

	today(id, now) {
		const day = today(now);
		let data = this.current.get(id);
		if (!data || data.day !== day) {
			if (data)
				this.write(id, data);
			data = this.load(id, day) || empty(day);
			this.current.set(id, data);
		}
		return data;
	}

	visitor(id, ip, ua, now, data) {
		const day = today(now);
		if (this.salt.day !== day) {
			this.salt = { day, value: Crypto.randomBytes(32) };
			this.seen.clear();
			this.seenCount = 0;
		}
		const set = this.seen.get(id);
		const hash = Crypto.createHmac('sha256', this.salt.value).update(String(ip) + '\n' + String(ua)).digest('base64').substring(0, 16);
		if (set && set.has(hash))
			return false;
		if (this.seenCount >= VISITORS_TOTAL || (set && set.size >= VISITORS_PER_ROUTE)) {
			data.visitors_capped = true;
			return false;
		}
		if (set)
			set.add(hash);
		else
			this.seen.set(id, new Set([hash]));
		this.seenCount++;
		return true;
	}

	// A request that ended: route, method, path (with the query), status, time to answer, address, user agent, referrer
	record(route, info) {
		if (!route || !route.stats || (info.method !== 'GET' && info.method !== 'POST'))
			return;
		const path = String(info.path || '/').split('?')[0].substring(0, 200) || '/';
		if (ASSET.test(path) || path.startsWith('/.well-known/acme-challenge/'))
			return;
		const now = info.time || Date.now();
		const id = route.id;
		const data = this.today(id, now);
		const hour = data.hours[new Date(now).getUTCHours()];
		const who = client(info.ua);
		const ms = Math.max(0, Math.round(info.ms || 0));
		const status = info.status || 0;

		bump(data.status, String(status), 50);
		if (status === 404)
			bump(data.notfound, path, LIMIT.notfound);
		else if (status >= 500)
			bump(data.errors, path, LIMIT.errors);

		if (who.kind !== 'person') {
			data[who.kind === 'bot' ? 'bots' : who.kind]++;
			hour[who.kind === 'bot' ? 'bots' : who.kind]++;
			const name = who.kind === 'bot' ? 'bot:' + who.name : who.name;
			if (!(name in data.agents) && Object.keys(data.agents).length >= LIMIT.agents)
				return this.dirty.add(id);
			const agent = data.agents[name] || (data.agents[name] = { kind: who.kind, views: 0, last: 0, paths: {} });
			agent.views++;
			agent.last = now;
			bump(agent.paths, path, 100);
			this.dirty.add(id);
			return;
		}

		// A page that a person saw (a page of the site: not a redirect, not an error of the request)
		if (info.method !== 'GET' || status >= 300 && status < 400)
			return this.dirty.add(id);
		data.views++;
		hour.views++;
		data.ms += ms;
		hour.ms += ms;
		if (this.visitor(id, info.ip, info.ua, now, data)) {
			data.visitors++;
			hour.visitors++;
		}
		const key = path in data.paths || Object.keys(data.paths).length < LIMIT.paths ? path : '(other)';
		const page = data.paths[key] || (data.paths[key] = { views: 0, ms: 0, max: 0 });
		page.views++;
		page.ms += ms;
		page.max = Math.max(page.max, ms);

		// Where the visit came from: the host of another site (not this one)
		if (info.referer) {
			try {
				const from = new URL(info.referer).hostname.replace(/^www\./, '');
				if (from && !route.hosts.some(host => host.replace(/^www\./, '') === from))
					bump(data.referrers, from, LIMIT.referrers);
			} catch {}
		}
		this.dirty.add(id);
	}

	write(id, data) {
		try {
			Fs.mkdirSync(Path.join(this.folder, id), { recursive: true, mode: 0o700 });
			const file = Path.join(this.folder, id, data.day + '.json');
			Fs.writeFileSync(file + '.tmp', JSON.stringify(data));
			Fs.renameSync(file + '.tmp', file);
		} catch {}
	}

	flush() {
		for (const id of this.dirty) {
			const data = this.current.get(id);
			data && this.write(id, data);
		}
		this.dirty.clear();
		this.clean();
	}

	// Once a day: the days older than the limit go away
	clean() {
		const day = today(Date.now());
		if (this.cleaned === day)
			return;
		this.cleaned = day;
		const limit = today(Date.now() - this.days * DAY);
		let routes = [];
		try {
			routes = Fs.readdirSync(this.folder);
		} catch {
			return;
		}
		for (const id of routes) {
			try {
				for (const name of Fs.readdirSync(Path.join(this.folder, id))) {
					if (name.endsWith('.json') && name.substring(0, 10) < limit)
						Fs.rmSync(Path.join(this.folder, id, name), { force: true });
				}
			} catch {}
		}
	}

	// The days of a route between two dates (YYYY-MM-DD, both in), at most "days" of them: [counters of each day]
	get(id, from, to) {
		const end = /^\d{4}-\d{2}-\d{2}$/.test(to || '') ? to : today(Date.now());
		let start = /^\d{4}-\d{2}-\d{2}$/.test(from || '') ? from : today(Date.parse(end) - 6 * DAY);
		if (Date.parse(end) - Date.parse(start) > this.days * DAY)
			start = today(Date.parse(end) - this.days * DAY);
		const output = [];
		for (let time = Date.parse(start); time <= Date.parse(end); time += DAY) {
			const day = today(time);
			const current = this.current.get(id);
			const data = current && current.day === day ? current : this.load(id, day);
			data && output.push(data);
		}
		return output;
	}

	// A route that no longer exists: its counters go
	remove(id) {
		this.current.delete(id);
		this.seenCount -= this.seen.get(id)?.size || 0;
		this.seen.delete(id);
		this.dirty.delete(id);
		try {
			Fs.rmSync(Path.join(this.folder, id), { recursive: true, force: true });
		} catch {}
	}
}

Stats.client = client;
module.exports = Stats;
