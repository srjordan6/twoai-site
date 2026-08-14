// url-guard.mjs: the deploy gate for URL permanence.
//
// Published URLs on theworldofai.org never die by accident. This script runs
// after every build and compares the sitemap the build just produced against
// the sitemap the live site is serving. Any URL that is live right now but
// absent from the new build must be accounted for in one of two ways:
//
//   1. a redirect rule in public/_redirects covering its path, or
//   2. a line in url-retirements.txt naming the path, with a reason.
//
// Anything else fails the build, which means the deploy never happens and
// yesterday's intact site keeps serving. Retiring a URL therefore requires a
// commit that names it, which is the review discipline the whole platform
// runs on. This exists because a story permalink was advertised while
// returning 404: the page had published one morning and been dropped the
// next, and nothing stood between that build and production.
//
// Fail-open cases, deliberately narrow: if the live sitemap cannot be
// fetched, or comes back suspiciously small (under 500 URLs), the guard
// warns and passes, because a network blip must not block every deploy and
// the pipeline's url_registry still catches losses one day later. Set
// SKIP_URL_GUARD=1 to bypass in a genuine emergency; the bypass prints
// loudly so it cannot be quiet.

import { readFileSync, existsSync } from 'node:fs';

const LIVE_INDEX = 'https://theworldofai.org/sitemap-index.xml';
const MIN_LIVE = 500;

function pathsFromSitemapXML(xml) {
  const out = [];
  for (const m of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)) {
    try {
      const u = new URL(m[1]);
      if (u.pathname.endsWith('.xml')) continue; // index entries
      out.push(u.pathname);
    } catch { /* skip malformed */ }
  }
  return out;
}

async function fetchLivePaths() {
  const idx = await (await fetch(LIVE_INDEX)).text();
  const subs = [...idx.matchAll(/<loc>\s*([^<]+?\.xml)\s*<\/loc>/g)].map((m) => m[1]);
  const sources = subs.length ? subs : [LIVE_INDEX];
  const paths = [];
  for (const s of sources) {
    paths.push(...pathsFromSitemapXML(await (await fetch(s)).text()));
  }
  return paths;
}

function localPaths() {
  const idx = readFileSync('dist/sitemap-index.xml', 'utf8');
  const subs = [...idx.matchAll(/<loc>\s*([^<]+?\.xml)\s*<\/loc>/g)]
    .map((m) => new URL(m[1]).pathname.replace(/^\//, 'dist/'));
  const paths = [];
  for (const s of subs.length ? subs : ['dist/sitemap-0.xml']) {
    paths.push(...pathsFromSitemapXML(readFileSync(s, 'utf8')));
  }
  return paths;
}

function redirectCovered() {
  if (!existsSync('public/_redirects')) return () => false;
  const rules = readFileSync('public/_redirects', 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/\s+/)[0])
    .filter(Boolean);
  const exact = new Set(rules.filter((r) => !r.includes('*')));
  const prefixes = rules.filter((r) => r.endsWith('*')).map((r) => r.slice(0, -1));
  return (p) => exact.has(p) || prefixes.some((pre) => p.startsWith(pre));
}

function retired() {
  if (!existsSync('url-retirements.txt')) return new Set();
  return new Set(
    readFileSync('url-retirements.txt', 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.split(/\s+/)[0]),
  );
}

if (process.env.SKIP_URL_GUARD === '1') {
  console.error('url-guard: SKIPPED via SKIP_URL_GUARD=1. Every live URL this build drops will 404.');
  process.exit(0);
}

let live;
try {
  live = await fetchLivePaths();
} catch (e) {
  console.error(`url-guard: could not fetch the live sitemap (${e.message}); passing open. The pipeline registry still audits daily.`);
  process.exit(0);
}
if (live.length < MIN_LIVE) {
  console.error(`url-guard: live sitemap has only ${live.length} URLs (< ${MIN_LIVE}); treating as a fetch problem and passing open.`);
  process.exit(0);
}

const next = new Set(localPaths());
const isRedirected = redirectCovered();
const isRetired = retired();

const dropped = live.filter((p) => !next.has(p) && !isRedirected(p) && !isRetired.has(p));
const uniq = [...new Set(dropped)].sort();

if (uniq.length === 0) {
  console.log(`url-guard: ok. live=${live.length} next=${next.size} dropped=0`);
  process.exit(0);
}

console.error(`url-guard: BLOCKING DEPLOY. This build drops ${uniq.length} URL(s) that are live right now.`);
console.error('Each must either come back, gain a redirect in public/_redirects, or be');
console.error('retired by name in url-retirements.txt with a reason. The site keeps serving');
console.error('the previous build until then.');
for (const p of uniq.slice(0, 40)) console.error('  ' + p);
if (uniq.length > 40) console.error(`  ... and ${uniq.length - 40} more`);
process.exit(1);
