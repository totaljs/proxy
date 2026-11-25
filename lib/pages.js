'use strict';

// The page of a site while its app does not answer or is in maintenance, when neither the site nor the settings of the
// edge have their own: plain, light and dark, in Spanish or English as the browser asks.

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

exports.stopped = function(accept) {
	const lang = exports.language(accept);
	return BUILT[lang] || (BUILT[lang] = build(TEXTS[lang]));
};
