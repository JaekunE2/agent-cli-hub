'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { checkAutopilotCompletions } = require('../project-autopilot');

const [baseDir, phase] = process.argv.slice(2);
const projects = require('../projects')(path.join(baseDir, 'projects.json'));
const save = projects.save;
projects.save = (input, options) => {
  if (phase === 'before-card-save' && input.tasks[0].stage === 'done') process.exit(73);
  return save(input, options);
};
const submissions = path.join(baseDir, 'submissions');
const hub = {
  baseDir, projects, terms: new Map(), mergeRetryDelayMs: 0, cleanEnv: () => process.env,
  codexLaunch: () => ({ cmd: process.execPath, args: ['-e', `(${fakeCodex})()`, baseDir] }),
  validateIntegration: async (cwd) => {
    if (fs.readFileSync(path.join(cwd, 'shared.txt'), 'utf8') !== 'both\n') throw new Error('Missing resolution');
  },
};

function fakeCodex() {
  const fs = require('node:fs');
  const path = require('node:path');
  const [dir] = process.argv.slice(1);
  const submissions = path.join(dir, 'submissions');
  const retry = fs.existsSync(submissions);
  fs.appendFileSync(submissions, '1\n');
  if (!retry) return;
  const timer = setInterval(() => {
    if (!fs.existsSync(path.join(dir, 'release'))) return;
    clearInterval(timer);
    fs.writeFileSync('shared.txt', 'both\n');
  }, 25);
  setTimeout(() => process.exit(1), 15000).unref();
}

if (phase === 'interrupt') {
  const timer = setInterval(() => {
    if (fs.existsSync(submissions) && fs.readFileSync(submissions, 'utf8') === '1\n1\n') process.exit(73);
  }, 10);
  timer.unref();
}

async function main() {
  for (let tick = 0; tick < (phase === 'interrupt' ? 2 : 1); tick++) {
    const jobs = await checkAutopilotCompletions(hub);
    await Promise.all(jobs.map(({ promise }) => promise));
  }
  if (phase === 'resume' && projects.list()[0].tasks[0].stage !== 'done') throw new Error('Merge did not resume');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
