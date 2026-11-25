'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

async function runGit(cwd, args) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout: 5000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

function buildMermaidGitGraph(commits) {
  if (!commits.length) return '';
  // Build a simple chronological Mermaid gitGraph (oldest -> newest)
  const ordered = [...commits].reverse().slice(-18);
  const lines = ['gitGraph'];
  const cleanMsg = (s) => String(s || '').replace(/["`\\]/g, "'").replace(/\s+/g, ' ').trim().slice(0, 36);
  for (const c of ordered) {
    const refs = (c.refs || []).filter((r) => !r.startsWith('HEAD'));
    lines.push(`  commit id: "${c.short}"${refs.length ? ` tag: "${cleanMsg(refs[0])}"` : ''}`);
  }
  return lines.join('\n');
}

async function inspectGit(cwd, { file = '', staged = false, untracked = false } = {}) {
  if (!cwd || !fs.existsSync(cwd)) return { ok: false, error: '작업 폴더를 찾을 수 없습니다.' };
  let topLevel = '';
  try {
    topLevel = (await runGit(cwd, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    return { ok: false, notRepo: true, error: 'Git 저장소가 아닙니다.' };
  }

  if (file) {
    const cleanRel = String(file).replace(/^["']|["']$/g, '');
    if (untracked) {
      const full = path.resolve(topLevel, cleanRel);
      if (!full.startsWith(path.resolve(topLevel))) return { ok: false, error: '잘못된 파일 경로입니다.' };
      try {
        const txt = fs.readFileSync(full, 'utf8').slice(0, 24_000);
        const diff = txt.split(/\r?\n/).map((l) => `+${l}`).join('\n');
        return { ok: true, file: cleanRel, staged: false, untracked: true, diff };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
    const args = ['diff', ...(staged ? ['--cached'] : []), '--', cleanRel];
    const diff = await runGit(topLevel, args).catch((e) => `Diff error: ${e.message}`);
    return { ok: true, file: cleanRel, staged: Boolean(staged), diff: diff || '(변경 내용 없음)' };
  }

  const [statusRaw, worktreeRaw, logRaw] = await Promise.all([
    runGit(topLevel, ['status', '--porcelain=v1', '-b']).catch(() => ''),
    runGit(topLevel, ['worktree', 'list', '--porcelain']).catch(() => ''),
    runGit(topLevel, ['log', '--format=%H%x1f%h%x1f%P%x1f%D%x1f%an%x1f%at%x1f%s', '-n', '20']).catch(() => ''),
  ]);

  let branch = '', upstream = '', ahead = 0, behind = 0;
  const stagedFiles = [], unstagedFiles = [], untrackedFiles = [];

  for (const line of statusRaw.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith('## ')) {
      const hdr = line.slice(3);
      const [brPart, trackPart] = hdr.split('...');
      branch = brPart || '';
      if (trackPart) {
        upstream = trackPart.split(' ')[0] || '';
        const ah = /ahead (\d+)/.exec(trackPart);
        const bh = /behind (\d+)/.exec(trackPart);
        if (ah) ahead = Number(ah[1]);
        if (bh) behind = Number(bh[1]);
      }
      continue;
    }
    const x = line[0], y = line[1], p = line.slice(3).trim();
    if (x === '?' && y === '?') {
      untrackedFiles.push({ status: '?', path: p });
      continue;
    }
    if (x !== ' ') stagedFiles.push({ status: x, path: p });
    if (y !== ' ') unstagedFiles.push({ status: y, path: p });
  }

  const worktrees = [];
  let curWt = null;
  for (const line of worktreeRaw.split(/\r?\n/)) {
    if (!line.trim()) {
      if (curWt) { worktrees.push(curWt); curWt = null; }
      continue;
    }
    if (line.startsWith('worktree ')) curWt = { path: line.slice(9).trim(), branch: '', head: '' };
    else if (curWt && line.startsWith('HEAD ')) curWt.head = line.slice(5).trim().slice(0, 7);
    else if (curWt && line.startsWith('branch ')) curWt.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
  }
  if (curWt) worktrees.push(curWt);

  const commits = [];
  for (const line of logRaw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [hash, short, parents, refsRaw, author, ts, subject] = line.split('\x1f');
    commits.push({
      hash,
      short,
      parents: parents ? parents.split(' ').filter(Boolean) : [],
      refs: refsRaw ? refsRaw.split(',').map((r) => r.trim()).filter(Boolean) : [],
      author,
      ts: Number(ts) * 1000 || 0,
      subject,
    });
  }

  return {
    ok: true,
    root: topLevel,
    branch,
    upstream,
    ahead,
    behind,
    worktrees,
    staged: stagedFiles,
    unstaged: unstagedFiles,
    untracked: untrackedFiles,
    commits,
    mermaid: buildMermaidGitGraph(commits),
  };
}

module.exports = { inspectGit };
