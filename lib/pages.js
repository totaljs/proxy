'use strict';

// The pages of the proxy itself, plain, light and dark:
//   stopped: a site while its app does not answer or is in maintenance, when neither the site nor the config has
//            one, in Spanish or English as the browser asks
//   unknown: a host name that no site has (the server works, nothing is published there yet), in English

const TEXTS = {
	en: { lang: 'en', title: 'Back in a moment', text: 'This site is not available right now. Try again in a few minutes.' },
	es: { lang: 'es', title: 'Volvemos enseguida', text: 'Este sitio no está disponible ahora mismo. Vuelve a probar en unos minutos.' }
};

const BUILT = {};

function build(texts) {
	return Buffer.from('<!doctype html>\n<html lang="' + texts.lang + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>' + texts.title + '</title><style>:root{color-scheme:light dark;--bg:#f6f5f2;--card:#fff;--text:#1c1c1a;--muted:#5f5d57;--line:#e6e4de}@media(prefers-color-scheme:dark){:root{--bg:#141413;--card:#1c1c1a;--text:#f1f0ec;--muted:#a9a79f;--line:#2e2d2a}}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--text);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:460px;width:100%;padding:36px 32px;background:var(--card);border:1px solid var(--line);border-radius:16px;text-align:center}.dot{width:44px;height:44px;margin:0 auto 18px;border-radius:50%;border:3px solid var(--line);border-top-color:#f97316;animation:t 1.4s linear infinite}@keyframes t{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.dot{animation:none}}h1{margin:0 0 8px;font-size:22px}p{margin:0;color:var(--muted)}</style></head><body><main><div class="dot" aria-hidden="true"></div><h1>' + texts.title + '</h1><p>' + texts.text + '</p></main></body></html>\n');
}

// The language of the visitor: Spanish when the browser puts it before English, else English
exports.language = function(accept) {
	const value = String(accept || '').toLowerCase();
	const es = value.search(/(^|,)\s*es\b/);
	const en = value.search(/(^|,)\s*en\b/);
	return es !== -1 && (en === -1 || es < en) ? 'es' : 'en';
};

// A host name that no site has, in English: the first lines are for whoever opens the address, the last one for its
// owner. The picture says the same: the request reached the proxy (the mark of Total.js Proxy, assets/proxy-mark.svg)
// and there is no site behind it yet. Everything is in the page: nothing is asked from another server.
const UNKNOWN = { title: 'Nothing here yet', at: 'No site is published at', here: 'No site is published at this address.', visitor: 'The server works, but this name is not set up. Check the address, or try again later.', owner: 'Is this your domain? Add a site for it to the proxy and it will show up here.' };

const UNKNOWN_STYLE = ':root{color-scheme:light dark;--bg:#f6f5f2;--card:#fff;--text:#1c1c1a;--muted:#5f5d57;--line:#d9d6ce;--soft:#f6f5f2;--accent:#1fa37f}@media(prefers-color-scheme:dark){:root{--bg:#141413;--card:#1c1c1a;--text:#f1f0ec;--muted:#a9a79f;--line:#3a3935;--soft:#232321;--accent:#77e2c0}}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;align-content:center;gap:18px;padding:24px;background:var(--bg);color:var(--text);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:480px;width:100%;padding:32px 32px 36px;background:var(--card);border:1px solid var(--line);border-radius:16px;text-align:center}svg{display:block;width:100%;max-width:300px;height:auto;margin:0 auto 20px}.wire{fill:none;stroke:var(--line);stroke-width:2;stroke-linecap:round}.live{stroke:var(--accent)}.none{stroke-dasharray:2 7}.box{fill:var(--soft);stroke:var(--line);stroke-width:2}.empty{fill:none;stroke-dasharray:5 6}.ink{fill:var(--line)}.dot{fill:var(--accent)}h1{margin:0 0 8px;font-size:22px}p{margin:0 0 10px;color:var(--muted)}b{color:var(--text);font-weight:600;overflow-wrap:anywhere}.owner{margin:22px 0 0;padding:12px 14px;border-radius:10px;background:var(--soft);font-size:14px}footer{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:13px}footer svg{width:18px;height:18px;margin:0}@media(prefers-reduced-motion:no-preference){.dot{animation:go 2.4s ease-in-out infinite}@keyframes go{0%{transform:translateX(0);opacity:0}15%{opacity:1}70%{transform:translateX(74px);opacity:1}100%{transform:translateX(74px);opacity:0}}}';

const MARK = '<rect width="64" height="64" rx="14" fill="#111b27"/><path d="M12 18h12l11 14-11 14H12l11-14z" fill="#77e2c0"/><path d="M32 18h12l11 14-11 14H32l11-14z" fill="#f2fffa"/>';

// A browser, the proxy, and the place of a site that is not there
const PICTURE = '<svg viewBox="0 0 300 96" role="img" aria-label="A request reaches Total.js Proxy, and no site is behind it yet">' +
	'<rect class="box" x="1" y="26" width="62" height="44" rx="8"/><circle class="ink" cx="12" cy="36" r="2.5"/><circle class="ink" cx="20" cy="36" r="2.5"/><circle class="ink" cx="28" cy="36" r="2.5"/><path class="wire" d="M12 50h40M12 59h24"/>' +
	'<path class="wire live" d="M72 48h38"/><circle class="dot" cx="72" cy="48" r="4"/>' +
	'<g transform="translate(118 16)">' + MARK + '</g>' +
	'<path class="wire none" d="M192 48h36"/>' +
	'<rect class="box empty" x="237" y="26" width="62" height="44" rx="8"/><path class="wire" d="M261 41l14 14m0-14l-14 14"/>' +
	'</svg>';

function escape(text) {
	return text.replace(/[&<>"']/g, char => '&#' + char.charCodeAt(0) + ';');
}

const UNKNOWN_HEAD = '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>' + UNKNOWN.title + '</title><style>' + UNKNOWN_STYLE + '</style></head><body><main>' + PICTURE + '<h1>' + UNKNOWN.title + '</h1><p>';
const UNKNOWN_TAIL = '</p><p>' + UNKNOWN.visitor + '</p><p class="owner">' + UNKNOWN.owner + '</p></main><footer><svg viewBox="0 0 64 64" aria-hidden="true">' + MARK + '</svg>Total.js Proxy</footer></body></html>\n';

// host: the name that was asked for ('' when the request had none that is a host name)
exports.unknown = function(host) {
	return Buffer.from(UNKNOWN_HEAD + (host ? UNKNOWN.at + ' <b>' + escape(host) + '</b>.' : UNKNOWN.here) + UNKNOWN_TAIL);
};

exports.stopped = function(accept) {
	const lang = exports.language(accept);
	return BUILT[lang] || (BUILT[lang] = build(TEXTS[lang]));
};
