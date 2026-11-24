'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const names = (result) => result.stdout.split('\0').filter(Boolean);

async function integrateBatch({ cwd, entries, git, resolve, check, progress, current }) {
  const call = async (dir, args) => {
    const r = await git(dir, args, 30_000);
    if (!r.ok) throw new Error((r.stderr || r.stdout || args.join(' ')).trim().slice(-1300));
    return r.stdout.trim();
  };
  const base = await call(cwd, ['rev-parse', 'HEAD']);
  const ref = await call(cwd, ['symbolic-ref', 'HEAD']);
  const ancestor = async (dir, commit) => (await git(dir, ['merge-base', '--is-ancestor', commit, 'HEAD'])).ok;
  if ((await Promise.all(entries.map(({ commit }) => ancestor(cwd, commit)))).every(Boolean)) return { ok: true, tip: base };
  const key = createHash('sha256').update(JSON.stringify([ref, base, entries.map(({ commit }) => commit)])).digest('hex').slice(0, 20);
  const root = path.join(cwd, '.hub-worktrees');
  const worktree = path.join(root, `integrate-${key}`);
  try {
    if (!fs.existsSync(worktree)) {
      fs.mkdirSync(root, { recursive: true });
      await call(cwd, ['worktree', 'add', '--detach', worktree, base]);
    } else {
      const registered = names(await git(cwd, ['worktree', 'list', '--porcelain', '-z']));
      const valid = registered.some((line) => line.startsWith('worktree ') && path.relative(worktree, line.slice(9)) === '');
      if (!valid || (await git(worktree, ['symbolic-ref', '-q', 'HEAD'])).ok || !await ancestor(worktree, base)) {
        throw new Error('통합 작업 폴더를 확인할 수 없습니다.');
      }
    }
    for (const entry of entries) {
      if (!current()) return { skipped: true };
      if (await ancestor(worktree, entry.commit)) continue;
      progress('통합 진행 중', worktree);
      const head = await call(worktree, ['rev-parse', 'HEAD']);
      const active = await git(worktree, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
      if (active.ok && active.stdout.trim() !== entry.commit) throw new Error('통합 작업 폴더의 병합 대상이 변경되었습니다.');
      if (!active.ok) {
        const merged = await git(worktree, ['merge', '--no-ff', '--no-commit', entry.commit], 30_000);
        if (!merged.ok && !(await git(worktree, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).ok) {
          throw new Error(merged.stderr.trim() || merged.stdout.trim() || 'Git merge failed');
        }
      }
      const conflicts = names(await git(worktree, ['diff', '--name-only', '--diff-filter=U', '-z']));
      if (!conflicts.length && active.ok && !(await git(worktree, ['diff', '--cached', '--check', 'HEAD'])).ok) {
        // A prior attempt may have staged incomplete resolutions. Git retains their original conflict entries.
        const stagedConflicts = await git(worktree, ['ls-files', '--resolve-undo', '-z']);
        conflicts.push(...new Set(names(stagedConflicts).map((line) => line.slice(line.indexOf('\t') + 1))));
      }
      if (conflicts.length) {
        progress('통합 충돌 해결 중', worktree);
        const index = await call(worktree, ['ls-files', '-s', '-z']);
        const untracked = await call(worktree, ['ls-files', '--others', '--exclude-standard', '-z']);
        await resolve(worktree, entry, conflicts);
        if (await call(worktree, ['rev-parse', 'HEAD']) !== head || await call(worktree, ['rev-parse', 'MERGE_HEAD']) !== entry.commit) {
          throw new Error('통합 작업 폴더의 병합 대상이 변경되었습니다.');
        }
        if (await call(worktree, ['ls-files', '-s', '-z']) !== index) throw new Error('충돌 해결 중 Git 스테이징 상태가 변경되었습니다.');
        const extra = names(await git(worktree, ['diff', '--name-only', '-z'])).filter((name) => !conflicts.includes(name));
        if (extra.length || await call(worktree, ['ls-files', '--others', '--exclude-standard', '-z']) !== untracked) {
          throw new Error('충돌 파일 외에 수정된 파일이 있습니다.');
        }
        await call(worktree, ['--literal-pathspecs', 'add', '--', ...conflicts]);
      }
      await call(worktree, ['diff', '--cached', '--check', 'HEAD']);
      await call(worktree, ['commit', '-m', `hub: integrate ${entry.id.slice(0, 8)}`]);
    }
    if (await call(worktree, ['status', '--porcelain', '-uno'])) throw new Error('통합 작업 폴더에 커밋되지 않은 변경이 있습니다.');
    const tip = await call(worktree, ['rev-parse', 'HEAD']);
    progress('통합 테스트 중', worktree);
    await check(worktree);
    if (await call(worktree, ['rev-parse', 'HEAD']) !== tip || await call(worktree, ['status', '--porcelain', '-uno'])) {
      throw new Error('통합 테스트 중 작업 폴더가 변경되었습니다.');
    }
    if (!current()) return { skipped: true };
    if (await call(cwd, ['rev-parse', 'HEAD']) !== base || await call(cwd, ['symbolic-ref', 'HEAD']) !== ref)
      return { pending: true, worktree };
    if ((await git(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).ok)
      throw new Error('대상 브랜치에 진행 중인 Git 병합이 있습니다.');
    if (!current()) return { skipped: true };
    progress('대상 브랜치 반영 중', worktree);
    const publish = await git(cwd, ['merge', '--ff-only', '--no-overwrite-ignore', tip], 30_000);
    if (!publish.ok) throw new Error(`대상 브랜치 반영 실패: ${(publish.stderr || publish.stdout).trim().slice(-1300)}`);
    await git(cwd, ['worktree', 'remove', worktree], 15_000);
    return { ok: true, tip };
  } catch (error) { return { error: error.message, worktree }; }
}

module.exports = { integrateBatch };
