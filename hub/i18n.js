// Language support. The hub is written in Korean; English comes from i18n/en.json, a map of
// Korean text → English text. Only text inside string literals / template text / HTML is translated
// (a small JS tokenizer finds it), never code, regular expressions or the data that flows through
// (your conversations, screens, file names), so features that match text keep working.
//
//   language: config.json "lang": "en" | "ko"   (env ACH_LANG wins; default: the Windows display language)
//
// Server-side modules are translated when they are loaded (takeOver at the top of server.js / ccd.js);
// the browser files are translated when served (forFile).
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..'); // repo root: hub/, ai-usage/, research-harness/
const HANGUL = /[가-힣]/;

let lang = null;
function language() {
  if (lang) return lang;
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'hub', 'config.json'), 'utf8')); } catch {}
  const sys = (() => { try { return Intl.DateTimeFormat().resolvedOptions().locale || ''; } catch { return ''; } })();
  lang = (process.env.ACH_LANG || cfg.lang || (/^ko/i.test(sys) ? 'ko' : 'en')).toLowerCase().startsWith('ko') ? 'ko' : 'en';
  return lang;
}

let dict = null;
function dictionary() {
  if (dict) return dict;
  try { dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'hub', 'i18n', 'en.json'), 'utf8')); } catch { dict = {}; }
  return dict;
}

// ---------- text pieces ----------
// A "piece" is a run of Korean-containing text between HTML tags / line breaks, or an HTML attribute value.
const PIECE = /[^<>\n]*[가-힣][^<>\n]*/g;
// whole tags, plus a tag cut by a ${...} expression: its end at the start of a run, its start at the end
const TAG = /<[^<>]*>|^[^<>]*>|<[^<>]*$/g;
function* pieces(text) {
  for (const tag of text.match(TAG) || []) {
    for (const m of tag.matchAll(/=\s*"([^"]*[가-힣][^"]*)"/g)) yield m[1].trim();
  }
  const outside = text.replace(TAG, '\n').replace(/\\n/g, '\n');
  for (const m of outside.match(PIECE) || []) { const t = m.trim(); if (t) yield t; }
}
/** translate the pieces of one text run; quote = the delimiter of the JS string it sits in (to escape) */
function translateText(text, quote = '') {
  if (!HANGUL.test(text)) return text;
  const d = dictionary();
  const esc = (s, inAttr) => {
    let r = s;
    if (inAttr) r = r.replace(/"/g, '&quot;');
    // escape the string's own delimiter, unless the translation already carries it escaped (like the source)
    const escq = (s2, q) => s2.replace(new RegExp(`(^|[^\\\\])${q === '$' ? '\\$\\{' : q}`, 'g'), (m, pre) => `${pre}\\${q === '$' ? '${' : q}`);
    if (quote === "'") r = escq(r, "'");
    else if (quote === '"') r = escq(r, '"');
    else if (quote === '`') r = escq(escq(r, '`'), '$');
    return r;
  };
  const one = (m, inAttr) => {
    const t = m.trim();
    const tr = d[t]; // "" is a real translation (Korean counters like 개 / 건 have no English word)
    return typeof tr === 'string' ? m.replace(t, () => esc(tr, inAttr)) : m;
  };
  // attribute values inside tags, then the text between tags (split on \n escapes as well)
  // tags (and cut tags) are set aside first so their text is only touched through attribute values
  const tags = [];
  let out = text.replace(TAG, (tag) => { tags.push(tag.replace(/(=\s*")([^"]*[가-힣][^"]*)(")/g, (_, a, v, b) => a + one(v, true) + b)); return `\u0001${tags.length - 1}\u0002`; });
  out = out.split(/(\u0001\d+\u0002)/).map((seg) => (/^\u0001\d+\u0002$/.test(seg) ? seg
    : seg.split('\\n').map((part) => part.replace(PIECE, (m) => one(m, false))).join('\\n'))).join('');
  return out.replace(/\u0001(\d+)\u0002/g, (_, k) => tags[Number(k)]);
}

// ---------- a small JS tokenizer: only string / template text is visited ----------
// visit(text, quote) returns the replacement for each string/template text run.
function mapStrings(src, visit) {
  let out = '', i = 0, n = src.length;
  const stack = []; // template nesting: for each open `${`, the brace depth at which it closes
  let braces = 0, prevSig = '';
  const regexOk = () => !prevSig || /[(,=:[!&|?{};+\-*%<>~^]$/.test(prevSig) || /\b(return|typeof|case|do|else|in|of|void|yield|await)$/.test(prevSig);
  const readTemplate = () => { // at the char after ` (or after } closing a ${ })
    let start = i;
    while (i < n) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { out += visit(src.slice(start, i), '`') + '`'; i++; prevSig = '`'; return 'end'; }
      if (c === '$' && src[i + 1] === '{') { out += visit(src.slice(start, i), '`') + '${'; i += 2; stack.push(braces); braces++; prevSig = '{'; return 'expr'; }
      i++;
    }
    out += visit(src.slice(start), '`');
    return 'end';
  };
  while (i < n) {
    const c = src[i], c2 = src[i + 1];
    // comments
    if (c === '/' && c2 === '/') { const j = src.indexOf('\n', i); const e = j < 0 ? n : j; out += src.slice(i, e); i = e; continue; }
    if (c === '/' && c2 === '*') { const j = src.indexOf('*/', i + 2); const e = j < 0 ? n : j + 2; out += src.slice(i, e); i = e; continue; }
    // strings
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') j++; j++; }
      out += c + visit(src.slice(i + 1, j), c) + (src[j] || ''); i = j + 1; prevSig = c; continue;
    }
    if (c === '`') { out += '`'; i++; readTemplate(); continue; }
    // regex literal: copied as is
    if (c === '/' && regexOk()) {
      let j = i + 1, cls = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; else if (src[j] === '/' && !cls) break;
        j++;
      }
      if (src[j] === '/') { j++; while (/[a-z]/i.test(src[j] || '')) j++; out += src.slice(i, j); i = j; prevSig = '/'; continue; }
    }
    if (c === '{') braces++;
    if (c === '}') {
      braces--;
      if (stack.length && braces === stack[stack.length - 1]) { stack.pop(); out += '}'; i++; readTemplate(); continue; }
    }
    out += c; i++;
    if (!/\s/.test(c)) prevSig = /[\w$]/.test(c) ? (prevSig && /[\w$]$/.test(prevSig) ? prevSig + c : c) : c;
    if (prevSig.length > 12) prevSig = prevSig.slice(-12);
  }
  return out;
}

const translateJs = (src) => mapStrings(src, (t, q) => translateText(t, q));
const translateHtml = (src) => {
  // inline <script> blocks are JS; the rest is markup. <html lang> tells the page scripts which locale to format dates in.
  return src.replace(/<html lang="ko"/i, '<html lang="en"').split(/(<script\b[^>]*>[\s\S]*?<\/script>)/i).map((part, k) => {
    if (k % 2) { const m = /^(<script\b[^>]*>)([\s\S]*?)(<\/script>)$/i.exec(part); return m[1] + translateJs(m[2]) + m[3]; }
    return translateText(part, '');
  }).join('');
};

/** every Korean piece a user can see in a file (for building en.json) */
function extract(src, kind) {
  const found = new Set();
  const add = (t) => { for (const p of pieces(t)) found.add(p); };
  if (kind === 'html') {
    src.split(/(<script\b[^>]*>[\s\S]*?<\/script>)/i).forEach((part, k) => { if (k % 2) mapStrings(part.replace(/^<script\b[^>]*>|<\/script>$/gi, ''), (t) => { add(t); return t; }); else add(part); });
  } else mapStrings(src, (t) => { add(t); return t; });
  return [...found];
}

// ---------- runtime ----------
const cache = new Map();
/** a browser file's text in the current language (null → serve the file as is) */
function forFile(file) {
  if (language() !== 'en') return null;
  const st = fs.statSync(file);
  const hit = cache.get(file);
  if (hit && hit.m === st.mtimeMs) return hit.text;
  const src = fs.readFileSync(file, 'utf8');
  const text = /\.html?$/i.test(file) ? translateHtml(src) : /\.m?js$/i.test(file) ? translateJs(src) : src;
  cache.set(file, { m: st.mtimeMs, text });
  return text;
}
/** a message built at runtime (API errors, notes) */
const msg = (s) => (language() === 'en' && typeof s === 'string' ? translateText(s, '') : s);

/**
 * Call first thing in an entry file:  if (require('./i18n').takeOver(module)) return;
 * In English mode this reloads the entry (and every module under the repo it requires) with translated
 * strings, so all messages are English; in Korean mode it does nothing.
 */
function takeOver(mod) {
  if (language() !== 'en' || global.__achI18n) return false;
  global.__achI18n = true;
  const orig = Module._extensions['.js'];
  Module._extensions['.js'] = function (m, filename) {
    if (filename.startsWith(ROOT) && !/[\\/]node_modules[\\/]/.test(filename) && !filename.endsWith('i18n.js')) {
      return m._compile(translateJs(fs.readFileSync(filename, 'utf8')), filename);
    }
    return orig(m, filename);
  };
  delete require.cache[mod.filename];
  const fresh = new Module(mod.filename, null);
  fresh.filename = mod.filename;
  fresh.paths = Module._nodeModulePaths(path.dirname(mod.filename));
  require.main = fresh;
  process.mainModule = fresh;
  fresh.load(mod.filename);
  return true;
}

module.exports = { language, translateJs, translateHtml, translateText, extract, forFile, msg, takeOver, pieces };
