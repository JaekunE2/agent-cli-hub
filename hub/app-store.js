'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const { githubRepo, githubSource, discoverRepos, latestPackage, downloadPackage, readLimited } = require('./app-store-github');
const { registryEntries, localPackage, copyPackage } = require('./app-store-local');

const exec = promisify(execFile);
const SHARED = 'https://raw.githubusercontent.com/JaekunE2/agent-cli-hub/dev_side/hub/app-catalog.json';
const bundled = require('./app-catalog.json');

module.exports = function createAppStore({ dataFile, fetcher = fetch, python = process.env.CCD_PYTHON || 'python', secretsDir = '' }) {
  // the user's own GitHub token, only for private app repositories: env, a secrets file, or the gh CLI login
  let tokenCache = null;
  async function githubToken() {
    if (tokenCache !== null) return tokenCache;
    let t = process.env.CCD_GITHUB_TOKEN || process.env.GITHUB_TOKEN || '';
    if (!t && secretsDir) t = await fs.readFile(path.join(secretsDir, 'github-token.txt'), 'utf8').then((x) => x.trim()).catch(() => '');
    if (!t) t = await exec('gh', ['auth', 'token'], { windowsHide: true, timeout: 5000 }).then((r) => r.stdout.trim()).catch(() => '');
    tokenCache = t;
    return t;
  }
  const root = path.join(path.dirname(dataFile), 'store-apps');
  let shared = bundled;
  let refreshAt = 0;
  const feeds = new Map();

  async function discovery(owner) {
    const cached = feeds.get(owner);
    if (cached && Date.now() < cached.until) return cached.result;
    const result = discoverRepos(fetcher, owner);
    feeds.set(owner, { result, until: Date.now() + 300000 });
    return result;
  }

  async function catalog(local) {
    if (Date.now() >= refreshAt) {
      refreshAt = Date.now() + 300000;
      try {
        const r = await fetcher(SHARED, { redirect: 'error', signal: AbortSignal.timeout(3000) });
        const next = JSON.parse(await readLimited(r, 256 * 1024));
        if (Array.isArray(next.apps)) shared = next;
      } catch {}
    }
    const owners = new Set();
    for (const source of [...(Array.isArray(shared.sources) ? shared.sources : []), ...local]) {
      if (!source?.owner) continue;
      try {
        const { owner } = githubSource(source.owner);
        if (owner) owners.add(owner);
      } catch {}
    }
    const results = await Promise.allSettled([...owners].map(discovery));
    const discovered = results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
    const unavailable = [...owners].filter((_, i) => results[i].status === 'rejected');
    const entries = new Map();
    // registries (a catalog URL / file / folder listing apps in their authors' repos) and local app folders
    const submitUrls = [];
    const registries = local.filter(item => item?.path || item?.url);
    const read = await Promise.allSettled(registries.map(source => registryEntries(source, fetcher)));
    read.forEach((result, i) => {
      if (result.status !== 'fulfilled') return void unavailable.push(registries[i].path || registries[i].url);
      if (result.value.submitUrl) submitUrls.push(result.value.submitUrl);
      for (const entry of result.value.entries) if (!entries.has(entry.key)) entries.set(entry.key, entry);
    });
    for (const entry of [...shared.apps, ...bundled.apps, ...local, ...discovered]) {
      if (!entry?.repo) continue;
      try {
        const repo = githubRepo(entry.repo);
        const asset = typeof entry.asset === 'string' ? entry.asset : '';
        const key = repo + (asset ? ':' + asset : '');
        if (!entries.has(key)) entries.set(key, { key, repo, asset, name: String(entry.name || repo), description: String(entry.description || '') });
      } catch {}
    }
    return { entries: [...entries.values()], unavailable, submitUrls: [...new Set(submitUrls)] };
  }

  async function withPackage(entry, expected, callback) {
    const token = entry.private && !entry.local ? await githubToken() : '';
    if (entry.private && !entry.local && !token) throw new Error('비공개 저장소입니다. GitHub 토큰(CCD_GITHUB_TOKEN, secrets/github-token.txt 또는 gh auth login)이 필요합니다.');
    const pkg = entry.local ? await localPackage(entry) : await latestPackage(fetcher, entry.repo, entry.asset, token);
    if (entry.sha256 && pkg.digest !== 'sha256:' + entry.sha256) throw new Error('릴리스 ZIP의 SHA-256이 레지스트리에 등록된 값과 다릅니다.');
    if (expected && expected !== pkg.digest) throw new Error('릴리스가 변경되었습니다. 설치 내용을 다시 확인하세요.');
    const bytes = entry.local ? null : await downloadPackage(fetcher, pkg, token);
    await fs.mkdir(root, { recursive: true });
    const stage = await fs.mkdtemp(path.join(root, 'package-'));
    let keep = false;
    try {
      const dir = path.join(stage, 'files'), zip = path.join(stage, 'app.zip');
      if (entry.local) await copyPackage(entry, pkg, dir);
      else {
        await fs.writeFile(zip, bytes);
        await exec(python, [path.join(__dirname, 'app-store-unzip.py'), zip, dir], { windowsHide: true, timeout: 30000 })
          .catch(() => { throw new Error('안전한 ZIP 압축 해제에 실패했습니다. Python과 패키지 형식을 확인하세요.'); });
        await fs.unlink(zip);
      }
      const top = await fs.readdir(dir, { withFileTypes: true });
      const cwd = top.length === 1 && top[0].isDirectory() ? path.join(dir, top[0].name) : dir;
      const file = path.join(cwd, 'app.json');
      const info = await fs.stat(file).catch(() => null);
      if (!info?.isFile() || info.size > 128 * 1024) throw new Error('올바른 app.json이 필요합니다.');
      const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!/^[a-z0-9][a-z0-9_-]{1,47}$/.test(manifest.id)) throw new Error('패키지의 앱 ID가 올바르지 않습니다.');
      const id = `${entry.local ? 'loc' : 'gh'}-${createHash('sha256').update((entry.local ? entry.key : entry.repo) + '/' + manifest.id).digest('hex').slice(0, 20)}`;
      const result = callback({ ...manifest, id, cwd, env: {}, secretRefs: [],
        session: { autoMatchCwd: false, autoPinArtifacts: false }, schedule: { enabled: false } }, pkg);
      keep = Boolean(expected);
      return result;
    } finally {
      if (!keep) {
        const realStage = await fs.realpath(stage), realRoot = await fs.realpath(root);
        if (path.dirname(realStage) === realRoot && path.basename(realStage).startsWith('package-')) {
          await fs.rm(realStage, { recursive: true, force: true });
        }
      }
    }
  }
  /** the folder that holds installed store packages (an installed app's cwd is inside it) */
  const owns = (dir) => {
    const rel = path.relative(root, path.resolve(dir || ''));
    return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel) && /^package-/.test(rel.split(path.sep)[0]);
  };
  const packageDir = (dir) => path.join(root, path.relative(root, path.resolve(dir)).split(path.sep)[0]);
  return { catalog, discovery, withPackage, owns, packageDir, root };
};
