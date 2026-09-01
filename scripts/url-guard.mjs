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
// The unlisted layer: pages that serve 200 and are linked but are kept out of
// the sitemap. The site publishes this set itself, so the guard can protect it
// without any new plumbing.
const LIVE_UNLISTED = 'https://theworldofai.org/unlisted-urls.json';
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

// THE WHOLE SITE, NOT JUST THE ADVERTISED PART. Until 2026-09-01 this guard
// compared sitemaps, which protected the 2,101 URLs Google is invited to and
// left the 7,500-odd unlisted pages with no deploy-time protection at all.
// That is how 43 vendor-news posts published on 2026-08-11 went to 404 on
// 2026-08-30 with nothing standing in the way: a gate that deletes rows ran,
// the next build simply had fewer pages, and the guard could not see the
// difference because none of them had ever been in a sitemap. Stephen's rule
// is that a published page is never removed, sitemap or not - it may be
// changed or retired, but it serves forever - so the guard now reads the
// unlisted set the site already publishes and holds every URL to the same
// standard. Failure to fetch the unlisted list falls back to sitemap-only
// with a loud warning rather than blocking every deploy.
async function fetchLiveUnlistedPaths() {
  const j = await (await fetch(LIVE_UNLISTED)).json();
  const out = [];
  for (const u of j?.urls ?? []) {
    try { out.push(new URL(u).pathname); } catch { /* skip malformed */ }
  }
  return out;
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

let liveUnlisted = [];
try {
  liveUnlisted = await fetchLiveUnlistedPaths();
  console.log(`url-guard: guarding ${live.length} sitemap + ${liveUnlisted.length} unlisted live URLs`);
} catch (e) {
  console.error(`url-guard: WARNING could not fetch ${LIVE_UNLISTED} (${e.message}); guarding the sitemap layer only this run. Unlisted pages are unprotected until this is fixed.`);
}

const next = new Set(localPaths());
const isRedirected = redirectCovered();
const isRetired = retired();

// Talent profile pages are membership-lifecycle URLs, not permanent site
// URLs: a member editing their profile returns it to review (unpublishing
// the page until a person re-approves), and profiles expire when not
// renewed. The permanence guard must not hold the whole site's deploys
// hostage to one member's review cycle (2026-08-22: three blocked builds).
const isTransient = (p) => /^\/talent\/tai-[a-z0-9]+\/$/i.test(p);

// A URL can leave the sitemap without dying: a page that renders noindex
// (tracked-only people profiles) is de-listed so the sitemap and the robots
// meta agree, but its file is still in dist and still serves 200. The guard
// protects URL permanence, not sitemap membership, so a dropped sitemap
// entry whose page still builds is fine and is logged rather than blocked.
const stillServed = (p) => existsSync(`dist${p.endsWith('/') ? p : `${p}/`}index.html`);

const transientGone = live.filter((p) => isTransient(p) && !next.has(p) && !stillServed(p));
if (transientGone.length) {
  console.log(`url-guard: ${transientGone.length} talent profile URL(s) unpublished (review/expiry lifecycle, allowed):`);
  for (const p of [...new Set(transientGone)].sort().slice(0, 20)) console.log('  ' + p);
}

const delisted = live.filter((p) => !next.has(p) && !isRedirected(p) && !isRetired.has(p) && stillServed(p));
if (delisted.length) {
  console.log(`url-guard: ${delisted.length} URL(s) left the sitemap but still build and serve 200 (noindex de-listing):`);
  for (const p of [...new Set(delisted)].sort().slice(0, 20)) console.log('  ' + p);
}

const dropped = live.filter((p) => !next.has(p) && !isRedirected(p) && !isRetired.has(p) && !stillServed(p) && !isTransient(p));
// Unlisted pages are judged purely on whether they still build: they were
// never in a sitemap, so "left the sitemap" is meaningless for them, and the
// only question is whether the file still exists in dist.
const unlistedDropped = liveUnlisted.filter((p) => !isRedirected(p) && !isRetired.has(p) && !stillServed(p) && !isTransient(p));
const uniq = [...new Set([...dropped, ...unlistedDropped])].sort();

if (uniq.length === 0) {
  console.log(`url-guard: ok. live=${live.length} unlisted=${liveUnlisted.length} next=${next.size} dropped=0`);
  process.exit(0);
}

console.error(`url-guard: BLOCKING DEPLOY. This build drops ${uniq.length} URL(s) that are live right now.`);
console.error('Each must either come back, gain a redirect in public/_redirects, or be');
console.error('retired by name in url-retirements.txt with a reason. The site keeps serving');
console.error('the previous build until then.');
for (const p of uniq.slice(0, 40)) console.error('  ' + p);
if (uniq.length > 40) console.error(`  ... and ${uniq.length - 40} more`);
process.exit(1);
