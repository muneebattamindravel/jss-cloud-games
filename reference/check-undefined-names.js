#!/usr/bin/env node
'use strict';
/**
 * check-undefined-names.js: fail the build on any name the code uses but never
 * defines.
 *
 * Why this exists (15 Sep 2026). Removing the hardcoded game list moved the
 * featured line-up into useFeaturedGames and deleted the old getFeaturedGames
 * import and setFeaturedRows state, but both Home pages still called them inside
 * their cycle:state handler. Vite bundled the unknown name as a global without a
 * word, the page loaded fine, and every check passed, because that line only
 * runs when a NEW DAY starts. At the midnight rotation every open Home threw
 * "getFeaturedGames is not defined" and kept yesterday's four games.
 *
 * A name used but never defined is invisible until the exact line runs, and some
 * lines only run at midnight, on a payment callback or on a socket event. So the
 * check is static, covers every file, and runs before every web and admin build
 * (prebuild), which is before every deploy.
 *
 *   node scripts/check-undefined-names.js web [admin mobile]
 *
 * It refuses to pass when it cannot prove itself: ESLint missing, a file that
 * fails to parse, no files found, or a self-test that does not flag a
 * deliberately undefined call (a misconfigured scan that parses nothing reports
 * nothing, and "nothing" looks exactly like "clean").
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ESLINT_VERSION = '8.57.1';

// Globals each app is allowed to use without defining them.
const APPS = {
  web:    { dirs: ['web/src'],   env: {}, globals: { __APP_VERSION__: 'readonly', process: 'readonly' } },   // vite define
  admin:  { dirs: ['admin/src'], env: {}, globals: { process: 'readonly' } },
  mobile: { dirs: ['mobile/app', 'mobile/src'], env: { node: true }, globals: { __DEV__: 'readonly' } },       // Metro require, Expo __DEV__
};

function loadEslint() {
  for (const from of [ROOT, path.join(ROOT, 'admin'), path.join(ROOT, 'web')]) {
    try { return require(require.resolve('eslint', { paths: [from] })); } catch (_e) { /* try the next */ }
  }
  // Not installed here (the admin deploy installs only admin's own packages):
  // fetch the pinned version into a temp dir. If that fails, so does the build.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kj-eslint-'));
  console.log(`check-undefined-names: installing eslint@${ESLINT_VERSION} for the check`);
  execFileSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', '--ignore-scripts', '--prefix', dir, `eslint@${ESLINT_VERSION}`], { stdio: 'inherit' });
  return require(require.resolve('eslint', { paths: [dir] }));
}

function configFor(app) {
  return {
    root: true,
    parserOptions: { ecmaVersion: 2022, sourceType: 'module', ecmaFeatures: { jsx: true } },
    env: { browser: true, es2022: true, ...app.env },
    globals: app.globals,
    rules: { 'no-undef': 'error' },
  };
}

const PROBE = "import { useEffect } from 'react';\n"
  + 'export default function Probe() { useEffect(() => { loadSomethingRemoved(); }, []); return <div />; }\n';

async function main() {
  const names = process.argv.slice(2);
  if (!names.length || names.some((n) => !APPS[n])) {
    console.error(`usage: node scripts/check-undefined-names.js ${Object.keys(APPS).join('|')} [...]`);
    process.exit(2);
  }
  let ESLint;
  try {
    ({ ESLint } = loadEslint());
  } catch (e) {
    console.error(`check-undefined-names: could not load ESLint, refusing to pass. ${e.message}`);
    process.exit(1);
  }

  let failed = 0;
  for (const name of names) {
    const app = APPS[name];
    const eslint = new ESLint({
      cwd: ROOT, useEslintrc: false, allowInlineConfig: false, baseConfig: configFor(app),
      extensions: ['.js', '.jsx'], errorOnUnmatchedPattern: true,
    });

    const [probe] = await eslint.lintText(PROBE, { filePath: path.join(ROOT, app.dirs[0], '__undefined_names_probe.jsx') });
    const probeHits = probe.messages.filter((m) => m.ruleId === 'no-undef').length;
    if (probeHits !== 1 || probe.messages.some((m) => m.fatal)) {
      console.error(`check-undefined-names: ${name}: SELF-TEST FAILED (the probe's undefined call gave ${probeHits} findings). The scan is broken, refusing to pass.`);
      for (const m of probe.messages) console.error(`  probe ${m.line}:${m.column} ${m.message}`);
      failed++;
      continue;
    }

    const results = await eslint.lintFiles(app.dirs);
    let problems = 0;
    for (const r of results) {
      for (const m of r.messages) {
        if (!m.fatal && m.ruleId !== 'no-undef') continue;
        problems++;
        console.error(`${path.relative(ROOT, r.filePath)}:${m.line}:${m.column}  ${m.message}`);
      }
    }
    if (results.length === 0) {
      console.error(`check-undefined-names: ${name}: found no files in ${app.dirs.join(', ')}, refusing to pass.`);
      failed++;
    } else if (problems) {
      console.error(`check-undefined-names: ${name}: ${problems} undefined name(s) or unparsable file(s) in ${results.length} files.`
        + '\n  Each one crashes the page the moment that line runs, which may be a rare moment (midnight, a socket event, a payment callback).'
        + '\n  Import or define the name. If it is a real build-time global, add it to APPS in scripts/check-undefined-names.js.');
      failed++;
    } else {
      console.log(`check-undefined-names: ${name}: ${results.length} files, no undefined names`);
    }
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('check-undefined-names crashed, refusing to pass:', e);
  process.exit(1);
});
