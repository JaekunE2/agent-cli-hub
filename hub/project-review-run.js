'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { setTimeout: delay } = require('timers/promises');

if (require.main === module && require('./i18n').takeOver(module)) return;

function read(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

function write(file, value, publish = fs.renameSync) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  try { publish(tmp, file); }
  finally { fs.rmSync(tmp, { force: true }); }
}

function running(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code !== 'ESRCH') throw error; return false; }
}

async function runReview(dir, prepare) {
  const resultFile = path.join(dir, 'result.json');
  const claimFile = path.join(dir, 'claim.json');
  let launchError, exited = false;
  let spec;
  if (!read(resultFile) && !read(claimFile)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { spec = await prepare(); }
    catch (error) { if (!read(claimFile)) throw error; }
  }
  if (spec && !read(claimFile)) {
    const log = fs.openSync(path.join(dir, 'worker.log'), 'a', 0o600);
    let child;
    try {
      child = spawn(process.execPath, [__filename, dir], {
        detached: true, windowsHide: true, stdio: ['pipe', 'ignore', log],
      });
    } finally { fs.closeSync(log); }
    child.on('error', (error) => { launchError = error; });
    child.on('exit', () => { exited = true; });
    child.stdin.on('error', (error) => { launchError = error; });
    child.stdin.end(JSON.stringify(spec));
    child.unref();
  }
  for (;;) {
    const result = read(resultFile);
    if (result) {
      if (Object.hasOwn(result, 'error')) throw Object.assign(new Error(result.error), { code: result.code, reviewCompleted: true });
      return result;
    }
    const claim = read(claimFile);
    if (claim && !running(claim.pid)) {
      if (read(resultFile)) continue;
      throw Object.assign(new Error('작업 프로세스가 결과 저장 전에 종료되어 제출 여부를 확인할 수 없습니다.'), { code: 'REVIEW_UNCERTAIN' });
    }
    if (!claim && (launchError || exited)) throw launchError || new Error('검토 프로세스가 제출 전에 종료됐습니다.');
    await delay(250);
  }
}

async function worker(dir) {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  let spec;
  try { spec = JSON.parse(input); }
  catch { throw new Error('Invalid or incomplete review worker input'); }
  try { write(path.join(dir, 'claim.json'), { pid: process.pid }, fs.linkSync); }
  catch (error) { if (error.code === 'EEXIST') return; throw error; }
  let result;
  try {
    const { stdout } = await require('./project-plan').spawnCli(spec.cmd, spec.args, spec.options);
    result = spec.conflictResolution ? {} : {
      ...require('./project-autopilot').readReviewResult(spec, stdout), agent: spec.agent, account: spec.account,
    };
  } catch (error) {
    result = { error: error.message, code: error.code };
  }
  write(path.join(dir, 'result.json'), result);
  for (const file of spec.files || []) fs.rmSync(file, { force: true });
}

if (require.main === module) worker(process.argv[2]).catch((error) => {
  console.error('[review-worker]', error);
  process.exitCode = 1;
});
module.exports = { runReview, hasReviewClaim: (dir) => fs.existsSync(path.join(dir, 'claim.json')) };
