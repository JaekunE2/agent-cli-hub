// Where the research harness lives: env CCD_HARNESS, else config.json "researchHarness", else a plugin that provides
// one (an App Store app installed it: plugin.json "provides": {"researchHarness": ...}), else ../research-harness
// (the copy in this repo). An existing install can keep its harness (and its projects) where they already are.
'use strict';
const fs = require('fs');
const path = require('path');

function dir() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch {}
  let fromPlugin = null;
  if (!process.env.CCD_HARNESS && !cfg.researchHarness) {
    try { fromPlugin = require('./plugins').provided('researchHarness'); } catch {}
    if (fromPlugin && !fs.existsSync(path.join(fromPlugin, 'lib', 'project.js'))) fromPlugin = null;
  }
  const d = process.env.CCD_HARNESS || cfg.researchHarness || fromPlugin || path.join(__dirname, '..', 'research-harness');
  return path.resolve(__dirname, d);
}
const libPath = (name) => path.join(dir(), 'lib', name);
const lib = (name) => require(libPath(name));

module.exports = { dir, libPath, lib };
