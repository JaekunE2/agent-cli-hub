'use strict';
// App Store registries and local app folders.
//
// A registry is a JSON catalog that lists apps living in their authors' own repositories:
//   { "registry": { "name", "submitUrl" }, "apps": [{ "id", "name", "description", "author", "tags",
//     "repo": "https://github.com/owner/app" | "file:///D:/src/app" | "D:\\src\\app",
//     "asset": "app.zip", "path": ".", "ref": "v1.0.0", "sha256": "<hex of the release zip>", "verified", "draft" }] }
// A source is the registry's URL (https), a local catalog file, a folder holding catalog.json, or one app folder
// holding app.json. GitHub repos install from their latest release (the upstream mechanism, plus the registry's
// sha256 when given); local repos are copied, and their digest is a SHA-256 over the file list and contents, so
// the review-then-install flow is the same for both.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { fileURLToPath } = require('node:url');
const { createHash } = require('node:crypto');
const { githubRepo, readLimited } = require('./app-store-github');

const exec = promisify(execFile);
const SKIP = new Set(['.git', '.github', 'node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache', 'dist']);
const MAX_FILES = 4000;
const MAX_BYTES = 200 * 1024 * 1024;

function localPath(value) {
  const raw = String(value || '').trim();
  if (/^file:\/\//i.test(raw)) return path.resolve(fileURLToPath(raw));
  if (path.isAbsolute(raw) && !/^[\\/]{2}/.test(raw)) return path.resolve(raw);
  return '';
}

/** a source value → { path } (local folder or catalog file) | { url } (https registry) | null (GitHub owner/repo) */
function localSource(value) {
  const raw = String(value || '').trim();
  const p = localPath(raw);
  if (p) return { path: p };
  if (/^https:\/\//i.test(raw) && !/^https:\/\/github\.com\//i.test(raw)) return { url: new URL(raw).href };
  if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/(?:raw|blob)\/.+\.json$/i.test(raw)) {
    return { url: raw.replace(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:raw|blob)\//i, 'https://raw.githubusercontent.com/$1/$2/') };
  }
  return null;
}

async function readJson(file, max = 1024 * 1024) {
  const info = await fs.stat(file).catch(() => null);
  if (!info?.isFile() || info.size > max) return null;
  try { return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); } catch { return null; }
}

const str = (v, n = 500) => (typeof v === 'string' ? v.slice(0, n) : '');

/** registry catalog of a source: { registry, apps } */
async function readCatalog(source, fetcher) {
  if (source.url) {
    const r = await fetcher(source.url, { redirect: 'follow', signal: AbortSignal.timeout(8000) });
    const data = JSON.parse(await readLimited(r, 1024 * 1024));
    return { base: '', data };
  }
  const p = source.path;
  const info = await fs.stat(p).catch(() => null);
  if (info?.isFile()) return { base: path.dirname(p), data: await readJson(p) };
  if (!info?.isDirectory()) throw new Error(`로컬 스토어 경로가 없습니다: ${p}`);
  const single = await readJson(path.join(p, 'app.json'), 128 * 1024);
  if (single) return { base: p, data: { apps: [{ repo: p, name: single.name, description: single.description }] } };
  return { base: p, data: await readJson(path.join(p, 'catalog.json')) };
}

/** entries of one source: GitHub ones look like upstream entries, local ones carry `local` (the package folder) */
async function registryEntries(source, fetcher) {
  const { base, data } = await readCatalog(source, fetcher);
  if (!data || !Array.isArray(data.apps)) throw new Error('catalog.json 형식이 아닙니다 ({ "apps": [...] })');
  const out = [];
  for (const item of data.apps.slice(0, 500)) {
    if (!item || item.draft) continue;
    const https = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u.slice(0, 500) : '');
    const meta = {
      name: str(item.name, 120), description: str(item.description), author: str(item.author, 120),
      tags: Array.isArray(item.tags) ? item.tags.filter((t) => typeof t === 'string').slice(0, 10).map((t) => t.slice(0, 40)) : [],
      ref: str(item.ref, 80), verified: item.verified === true, registry: str(data.registry?.name, 120),
      tagline: str(item.tagline, 140), category: str(item.category, 40), updated: str(item.updated, 40),
      installs: Number.isSafeInteger(item.installs) && item.installs >= 0 ? item.installs : null,
      featured: item.featured === true, added: str(item.added, 40),
      icon: https(item.icon), screenshots: Array.isArray(item.screenshots) ? item.screenshots.map(https).filter(Boolean).slice(0, 6) : [],
    };
    const rel = str(item.path || item.dir || '.', 300).replace(/\\/g, '/');
    if (rel.split('/').includes('..')) continue;
    // local repo (tests, team shares): a path, or file URL, or relative to a local catalog
    let dir = localPath(item.repo) || (base && !item.repo && item.dir ? path.resolve(base, item.dir) : '');
    if (dir) {
      if (item.repo && rel !== '.') dir = path.resolve(dir, rel);
      const manifest = await readJson(path.join(dir, 'app.json'), 128 * 1024);
      if (!manifest) continue;
      const st = manifest.store && typeof manifest.store === 'object' ? manifest.store : {};
      const key = 'local:' + dir.toLowerCase();
      const asset = (f) => `/api/apps-store/asset?key=${encodeURIComponent(key)}&file=${encodeURIComponent(f)}`;
      const git = await gitInfo(dir);
      out.push({ ...meta, key, local: dir, repo: dir, asset: '',
        name: meta.name || String(manifest.name || path.basename(dir)), description: meta.description || String(manifest.description || ''),
        tagline: meta.tagline || str(st.tagline, 140), category: meta.category || str(st.category, 40),
        icon: meta.icon || (typeof st.icon === 'string' && assetFile(st.icon) ? asset(st.icon) : ''),
        screenshots: meta.screenshots.length ? meta.screenshots
          : (Array.isArray(st.screenshots) ? st.screenshots.filter(assetFile).slice(0, 6).map(asset) : []),
        updated: meta.updated || git.date || '', version: git.tag || String(manifest.version || ''),
        requires: manifest.requires && typeof manifest.requires === 'object' ? manifest.requires : (item.requires || null) });
      continue;
    }
    try {
      const repo = githubRepo(item.repo);
      const asset = str(item.asset, 200);
      const sha = /^[a-f\d]{64}$/i.test(item.sha256 || '') ? item.sha256.toLowerCase() : '';
      out.push({ ...meta, key: repo + (asset ? ':' + asset : ''), repo, asset, sha256: sha, name: meta.name || repo,
        requires: item.requires && typeof item.requires === 'object' ? item.requires : null });
    } catch {}
  }
  return { entries: out, submitUrl: /^https:\/\/github\.com\//i.test(data.registry?.submitUrl || '') ? data.registry.submitUrl : '' };
}

/** every regular file under dir (no links, no build/VCS folders), sorted */
async function listFiles(dir) {
  const files = [];
  let bytes = 0;
  async function walk(abs, rel) {
    for (const ent of await fs.readdir(abs, { withFileTypes: true })) {
      if (ent.isSymbolicLink()) continue;
      const r = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) {
        if (!SKIP.has(ent.name)) await walk(path.join(abs, ent.name), r);
      } else if (ent.isFile()) {
        if (/^\.env/i.test(ent.name)) continue;
        const st = await fs.stat(path.join(abs, ent.name));
        bytes += st.size;
        files.push(r);
        if (files.length > MAX_FILES || bytes > MAX_BYTES) throw new Error('로컬 패키지가 크기 한도를 넘었습니다.');
      }
    }
  }
  await walk(dir, '');
  return files.sort();
}

async function gitInfo(dir) {
  const git = (...a) => exec('git', ['-C', dir, ...a], { windowsHide: true, timeout: 5000 }).then((r) => r.stdout.trim()).catch(() => '');
  const commit = await git('rev-parse', 'HEAD');
  if (!commit) return {};
  const dirty = Boolean(await git('status', '--porcelain', '--', '.'));
  return { commit, tag: await git('describe', '--tags', '--exact-match'), dirty, date: await git('log', '-1', '--format=%cI') };
}

/** files a store page may show from a local package: the icon and screenshots only */
const assetFile = (f) => typeof f === 'string' && /^(?:icon\.(?:png|svg|webp|jpg)|screenshots\/[\w.-]+\.(?:png|jpg|jpeg|webp|svg))$/i.test(f);

/** { repo, version, digest, files, commit, tag } of a local app folder */
async function localPackage(entry) {
  const files = await listFiles(entry.local);
  const hash = createHash('sha256');
  for (const rel of files) {
    hash.update(rel + '\0');
    hash.update(await fs.readFile(path.join(entry.local, ...rel.split('/'))));
    hash.update('\0');
  }
  const manifest = await readJson(path.join(entry.local, 'app.json'), 128 * 1024) || {};
  const git = await gitInfo(entry.local);
  return { repo: entry.local, version: git.tag || String(manifest.version || 'local'), digest: 'sha256:' + hash.digest('hex'), files, ...git };
}

/** copy the package's files into dest (dest/<folder name>/...) */
async function copyPackage(entry, pkg, dest) {
  const top = path.join(dest, path.basename(entry.local) || 'app');
  for (const rel of pkg.files) {
    const target = path.join(top, ...rel.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(entry.local, ...rel.split('/')), target);
  }
}

// ---------- platform requirements: app.json "requires": { "ccd": ">=1.0.0", "plugins": ["drives"] } ----------
const ver = (s) => String(s || '0').replace(/^v/, '').split(/[.+-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
const cmp = (a, b) => { for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0); return 0; };
/** does version satisfy every space-separated comparator of range (>=, >, <=, <, =, ^, ~, bare = >=)? */
function satisfies(version, range) {
  const v = ver(version);
  return String(range || '').trim().split(/\s+/).filter(Boolean).every((part) => {
    const m = /^(>=|<=|>|<|=|\^|~)?\s*v?([\d.]+)$/.exec(part);
    if (!m) return false;
    const r = ver(m[2]), c = cmp(v, r);
    switch (m[1] || '>=') {
      case '>=': return c >= 0; case '>': return c > 0; case '<=': return c <= 0; case '<': return c < 0; case '=': return c === 0;
      case '^': return c >= 0 && v[0] === r[0];
      case '~': return c >= 0 && v[0] === r[0] && v[1] === r[1];
      default: return false;
    }
  });
}
/** [] when the hub meets the app's requirements, else the reasons */
function unmet(requires, { hubVersion, plugins }) {
  const out = [];
  if (!requires || typeof requires !== 'object') return out;
  if (requires.ccd && !satisfies(hubVersion, requires.ccd)) out.push(`CCD ${requires.ccd} 필요 (이 허브 ${hubVersion})`);
  for (const p of Array.isArray(requires.plugins) ? requires.plugins : []) if (!plugins.includes(String(p))) out.push(`플러그인 ${p} 필요`);
  return out;
}

module.exports = { localSource, registryEntries, localPackage, copyPackage, assetFile, satisfies, unmet };
