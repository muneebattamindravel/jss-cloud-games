#!/usr/bin/env node
'use strict';
/**
 * stamp-busters.js — CONTENT-HASH cache busters for every game page, at deploy.
 *
 * Until 10 Sep 2026 every `?v=` in games/<game>/index.html was typed by hand,
 * and three of the last four incidents on the platform involved a file that
 * changed under a `?v=` that did not. This runs on the deploy copy (web/dist)
 * and rewrites every local <script src>/<link href>/<img src> reference to
 * `?v=<sha256 of the file's bytes, 12 hex>`. A changed file gets a new URL by
 * construction; an unchanged one keeps its old URL (and its cache entry).
 *
 * It also stamps the build into every page —
 *     window.__kjBuild = "<git sha>"; window.__kjBuildAt = <ms>;
 * — and writes games/build.json {build, at}. The SDK compares the two on its
 * heartbeat and asks the platform to reload a game that is sitting on its
 * menu with an older build than the one deployed (never mid-run).
 *
 * Usage: node scripts/stamp-busters.js web/dist [buildId]
 * Never run on the source tree: the source keeps human-readable `?v=` values
 * for local dev, where Vite already serves games with no-store.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const dist = path.resolve(process.argv[2] || 'web/dist');
const buildId = process.argv[3] || process.env.GITHUB_SHA
  || (() => { try { return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (_e) { return 'unknown'; } })();
const buildAt = Date.now();

const gamesDir = path.join(dist, 'games');
if (!fs.existsSync(gamesDir)) { console.error(`stamp-busters: no ${gamesDir}`); process.exit(1); }

const hashCache = new Map();
function hashOf(file) {
  if (!hashCache.has(file)) hashCache.set(file, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12));
  return hashCache.get(file);
}

// Resolve a page-relative or site-absolute reference to a file under dist.
function resolveRef(htmlDir, ref) {
  const clean = ref.split('?')[0].split('#')[0];
  if (!clean || /^(https?:)?\/\//i.test(clean) || /^(data|blob|mailto|tel):/i.test(clean)) return null;
  const abs = clean.startsWith('/') ? path.join(dist, clean) : path.resolve(htmlDir, clean);
  if (!abs.startsWith(dist)) return null;
  return fs.existsSync(abs) && fs.statSync(abs).isFile() ? abs : null;
}

const ATTR = /\b(src|href)=("|')([^"']+)\2/g;
let pages = 0; let refs = 0;
for (const game of fs.readdirSync(gamesDir)) {
  const html = path.join(gamesDir, game, 'index.html');
  if (!fs.existsSync(html)) continue;
  const dir = path.dirname(html);
  let src = fs.readFileSync(html, 'utf8');
  src = src.replace(ATTR, (m, attr, q, ref) => {
    const file = resolveRef(dir, ref);
    if (!file) return m;
    const base = ref.split('?')[0].split('#')[0];
    refs += 1;
    return `${attr}=${q}${base}?v=${hashOf(file)}${q}`;
  });
  const stamp = `<script>window.__kjBuild=${JSON.stringify(buildId)};window.__kjBuildAt=${buildAt};</script>`;
  src = src.includes('__kjBuild=') ? src : src.replace(/<head[^>]*>/i, (m) => `${m}\n  ${stamp}`);
  fs.writeFileSync(html, src);
  pages += 1;
}
fs.writeFileSync(path.join(gamesDir, 'build.json'), JSON.stringify({ build: buildId, at: buildAt }));
console.log(`stamp-busters: ${pages} pages, ${refs} references, build ${buildId.slice(0, 12)} at ${buildAt}`);
