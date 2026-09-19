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

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

// THE GUARD WAS BLIND AND SAID NOTHING USEFUL ABOUT IT. Found 2026-09-18 in
// the build log: "live sitemap has only 0 URLs (< 500); treating as a fetch
// problem and passing open." Reproduced the same hour: Node's fetch sends the
// user agent "node", and Bot Fight Mode on theworldofai.org answers that with
// 403 and cf-mitigated: challenge. The challenge page is HTML with no <loc>
// in it, so the guard counted zero URLs, called it a network blip and passed.
// fetch() does not throw on a 403, so the catch never ran either. From the
// day Bot Fight Mode went on, no build was guarded.
//
// Three changes. (1) Every response is checked for its status, so a refusal
// is reported as a refusal. (2) The live site is read from more than one
// origin: the public hostname first, then the Worker's own workers.dev
// hostname, which serves the same deployment and is not behind the zone's bot
// rules. Verified 2026-09-18: "node" gets 403 from the first and 200 from the
// second, same sitemap, same 9,592 unlisted URLs. (3) The verdict is written
// into dist/api/build.json, so it deploys with the site and the pipeline's
// buildwatch can alert when a build shipped unguarded. Passing open is still
// the policy, for the reason given above; passing open silently is not.
// SINCE 2026-09-19 THE LEDGER BELOW IS THE GUARD'S SOURCE, and this origin is
// only what it reads while the ledger is empty or unreachable. The workers.dev
// hostname that used to be second in this list is gone: Stephen ruled that it
// cannot be publicly reachable, and wrangler.jsonc now sets workers_dev false.
// The public hostname stays because it costs nothing and did answer the build
// runner on 2026-09-19 04:34 UTC, though Bot Fight Mode does not promise that.
const ORIGINS = ['https://theworldofai.org'];
const CANONICAL = 'https://theworldofai.org';
const UA = 'twoai-url-guard/1.0 (+https://theworldofai.org/; build-time URL permanence check)';
// The unlisted layer: pages that serve 200 and are linked but are kept out of
// the sitemap. The site publishes this set itself, so the guard can protect it
// without any new plumbing.
const UNLISTED_PATH = '/unlisted-urls.json';
const MIN_LIVE = 500;

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' } });
  if (!res.ok) {
    const why = res.headers.get('cf-mitigated') ? `, cf-mitigated: ${res.headers.get('cf-mitigated')}` : '';
    throw new Error(`${url} answered ${res.status}${why}`);
  }
  return res;
}

// The verdict travels with the build. build.json is written by
// fetch-content.mjs into public/api and copied to dist by Astro.
function record(verdict) {
  const p = 'dist/api/build.json';
  try {
    const j = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
    j.url_guard = { ...verdict, checked_at: new Date().toISOString() };
    writeFileSync(p, JSON.stringify(j, null, 2));
  } catch (e) {
    console.error(`url-guard: could not record the verdict in ${p} (${e.message})`);
  }
}

// THE LEDGER: THE GUARD'S OWN RECORD OF EVERY URL THIS SITE HAS PUBLISHED.
//
// Stephen, 2026-09-19: twoai-site.srjordan.workers.dev cannot stay open, and
// Bot Fight Mode stays on. Those two together rule out asking the internet
// what is live. Bot Fight Mode challenges anything that does not run
// JavaScript, the build runner included, and Cloudflare documents that no WAF
// rule can except it. The workers.dev hostname answered only because it has no
// security in front of it at all, which is exactly why it has to close.
//
// So the guard stops asking. It keeps a ledger in Workers KV (namespace
// twoai-url-ledger) of every path a guarded build has published, reads it
// through the Cloudflare API with the token Workers Builds already gives the
// build (the generated token carries Workers KV Storage edit), and after a
// build passes it writes back the union of the ledger and this build.
//
// This is a stronger guard than the one it replaces, not only a reachable one.
// Comparing against the live site can only catch what the last deploy still
// had: a URL lost while the guard was blind was forgotten the moment it went.
// The ledger only grows, so a published URL is held to the rule for good, and
// the only ways out remain a redirect or a named retirement.
//
// The ledger seeds itself. While it is empty the guard reads the live site
// the old way, and writes what it found.
const LEDGER_NS = '7a70aa90957143cf80ef7fcd4f69ee07';
const LEDGER_KEY = 'published-paths.json';
const CF_API = 'https://api.cloudflare.com/client/v4';

async function cfApi(path, init = {}) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is not visible to the build step');
  return fetch(`${CF_API}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
}

let ledgerAccount = null;
async function ledgerUrl() {
  if (!ledgerAccount) {
    ledgerAccount = process.env.CLOUDFLARE_ACCOUNT_ID || null;
    if (!ledgerAccount) {
      const res = await cfApi('/accounts?per_page=5');
      if (!res.ok) throw new Error(`account lookup answered ${res.status}`);
      const j = await res.json();
      if (!j.result || j.result.length !== 1) throw new Error(`account lookup returned ${j.result ? j.result.length : 0} accounts, need exactly 1 or CLOUDFLARE_ACCOUNT_ID`);
      ledgerAccount = j.result[0].id;
    }
  }
  return `/accounts/${ledgerAccount}/storage/kv/namespaces/${LEDGER_NS}/values/${LEDGER_KEY}`;
}

// Returns the ledger's paths, or [] when the key has never been written.
// Throws when the ledger cannot be reached, which is a different thing.
async function ledgerRead() {
  const res = await cfApi(await ledgerUrl());
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`ledger read answered ${res.status}`);
  const j = await res.json();
  return Array.isArray(j.paths) ? j.paths : [];
}

async function ledgerWrite(paths) {
  const body = JSON.stringify({ updated: new Date().toISOString(), commit: process.env.WORKERS_CI_COMMIT_SHA || null, count: paths.length, paths });
  const res = await cfApi(await ledgerUrl(), { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body });
  if (!res.ok) throw new Error(`ledger write answered ${res.status}`);
}

// What this build publishes, by the site's own account of itself: the sitemap
// as built, before the noindex prune runs, plus the unlisted list.
function builtPaths() {
  const out = new Set(localPaths());
  if (existsSync('dist/unlisted-urls.json')) {
    try {
      for (const u of JSON.parse(readFileSync('dist/unlisted-urls.json', 'utf8')).urls ?? []) {
        try { out.add(new URL(u).pathname); } catch { /* skip malformed */ }
      }
    } catch { /* an unreadable list adds nothing */ }
  }
  return out;
}

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

// The sitemap index names its parts on the public hostname whichever origin
// served it, so each part is re-addressed to the origin being read.
async function fetchLivePaths(origin) {
  const index = `${origin}/sitemap-index.xml`;
  const idx = await (await get(index)).text();
  const subs = [...idx.matchAll(/<loc>\s*([^<]+?\.xml)\s*<\/loc>/g)]
    .map((m) => m[1].replace(CANONICAL, origin));
  const sources = subs.length ? subs : [index];
  const paths = [];
  for (const s of sources) {
    paths.push(...pathsFromSitemapXML(await (await get(s)).text()));
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
async function fetchLiveUnlistedPaths(origin) {
  const j = await (await get(`${origin}${UNLISTED_PATH}`)).json();
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
  record({ guarded: false, reason: 'SKIP_URL_GUARD=1' });
  process.exit(0);
}

// The ledger first. The live site only while the ledger is empty or cannot
// be reached.
let ledger = null;
let ledgerNote = null;
try {
  ledger = await ledgerRead();
} catch (e) {
  ledgerNote = e.message;
  console.error(`url-guard: WARNING the ledger could not be read (${e.message}).`);
}
const useLedger = Array.isArray(ledger) && ledger.length >= MIN_LIVE;

let live = null;
let origin = null;
let liveUnlisted = [];
let unlistedNote = null;
if (useLedger) {
  // One set, one rule: a ledger path must still build, or be redirected or
  // retired. Whether it was ever in a sitemap does not matter to permanence.
  live = [];
  liveUnlisted = ledger;
  origin = 'ledger';
  console.log(`url-guard: guarding ${ledger.length} published URLs from the ledger`);
} else {
  if (Array.isArray(ledger)) console.log(`url-guard: the ledger holds ${ledger.length} URLs, too few to guard with; reading the live site to seed it.`);
  const refusals = [];
  for (const o of ORIGINS) {
    try {
      const got = await fetchLivePaths(o);
      if (got.length < MIN_LIVE) {
        refusals.push(`${o}: only ${got.length} URLs (< ${MIN_LIVE})`);
        continue;
      }
      live = got;
      origin = o;
      break;
    } catch (e) {
      refusals.push(e.message);
    }
  }
  for (const r of refusals) console.error(`url-guard: ${r}`);
  if (!live) {
    console.error('url-guard: UNGUARDED BUILD. Neither the ledger nor any origin gave a usable URL set, so this deploy is NOT checked for dropped URLs. Passing open; the verdict is recorded in /api/build.json and buildwatch will alert.');
    record({ guarded: false, reason: [ledgerNote && `ledger: ${ledgerNote}`, ...refusals].filter(Boolean).join(' | ').slice(0, 500) });
    process.exit(0);
  }
  try {
    liveUnlisted = await fetchLiveUnlistedPaths(origin);
    console.log(`url-guard: guarding ${live.length} sitemap + ${liveUnlisted.length} unlisted live URLs, read from ${origin}`);
  } catch (e) {
    unlistedNote = e.message;
    console.error(`url-guard: WARNING could not fetch the unlisted list (${e.message}); guarding the sitemap layer only this run. Unlisted pages are unprotected until this is fixed.`);
  }
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
  // The ledger only grows: what it held, what was live, and what this build
  // publishes. Talent profiles stay out, they are lifecycle URLs. Written only
  // on a pass, and never when the unlisted layer went unread, because a
  // partial picture must not become the record.
  let ledgerWritten = null;
  if (!ledgerNote && !unlistedNote) {
    const union = [...new Set([...(ledger || []), ...live, ...liveUnlisted, ...builtPaths()])].filter((p) => !isTransient(p)).sort();
    try {
      await ledgerWrite(union);
      ledgerWritten = union.length;
      console.log(`url-guard: ledger written, ${union.length} published URLs on record`);
    } catch (e) {
      ledgerNote = e.message;
      console.error(`url-guard: WARNING the ledger could not be written (${e.message}).`);
    }
  }
  // Sitemap-only is half a guard, and the record says so. A pass that could
  // not reach the ledger is still guarded this once, by the live site, and
  // says why the ledger was not used.
  record({ guarded: !unlistedNote, reason: unlistedNote ? `unlisted layer unread: ${unlistedNote}`.slice(0, 500) : null,
    source: origin, ledger_read: Array.isArray(ledger) ? ledger.length : null, ledger_written: ledgerWritten,
    ledger_note: ledgerNote, live: live.length, unlisted: liveUnlisted.length, dropped: 0 });
  process.exit(0);
}

console.error(`url-guard: BLOCKING DEPLOY. This build drops ${uniq.length} URL(s) that ${useLedger ? 'this site has published' : 'are live right now'}.`);
console.error('Each must either come back, gain a redirect in public/_redirects, or be');
console.error('retired by name in url-retirements.txt with a reason. The site keeps serving');
console.error('the previous build until then.');
for (const p of uniq.slice(0, 40)) console.error('  ' + p);
if (uniq.length > 40) console.error(`  ... and ${uniq.length - 40} more`);
process.exit(1);
