// canonical-noindex-sync.mjs: a page must not name, as its canonical, a page
// that tells crawlers not to index it.
//
// Found 2026-09-18 by Stephen's Screaming Frog crawl: 40 URLs flagged
// "canonical points to a non-indexable page", every one a company twin.
//
// How it happened. Each company is published at two addresses. Since
// 2026-09-01 the ecosystem copy names /companies/{uid}/ as its canonical. On
// 2026-09-18 the thin-page rule on /companies/{uid}/ was tightened, so a
// company with no profile, lawsuit, MCP server or reading became noindex. Its
// twin went on pointing at it. One page says "the real version is over there",
// the other says "do not index me". A crawler that receives both may ignore
// the canonical and index the twin, which is the thinner of the two. Two
// changes, each correct alone, contradicting each other.
//
// Why this is a build step and not a template rule. The twin would have to
// repeat the company page's thin test, which depends on four inputs loaded by
// a different route. A copied rule drifts the moment the original changes;
// scripts/sitemap-noindex-prune.mjs exists because exactly that happened once
// already. So this reads the BUILT HTML: if the page a twin points at says
// noindex, the twin says noindex too. Whatever rule decided it, and whenever
// that rule next changes, the two pages cannot disagree.
//
// It runs BEFORE the sitemap prune, so the prune sees the final robots tags.
// Nothing is unpublished: the twin still builds, serves and is linked.
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'dist';
const ORIGIN = 'https://theworldofai.org';
const noindexRe = /<meta[^>]+name=["']robots["'][^>]*content=["'][^"']*noindex/i;
const canonicalRe = /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i;

function* htmlFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let s;
    try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) {
      if (name === 'pagefind' || name === '_astro') continue;
      yield* htmlFiles(p);
    } else if (name === 'index.html') {
      yield p;
    }
  }
}

const targetNoindex = new Map();
function isNoindex(pathname) {
  if (targetNoindex.has(pathname)) return targetNoindex.get(pathname);
  const file = `${DIST}${pathname.endsWith('/') ? pathname : `${pathname}/`}index.html`;
  let v = false;
  if (existsSync(file)) {
    try { v = noindexRe.test(readFileSync(file, 'utf8')); } catch { v = false; }
  }
  targetNoindex.set(pathname, v);
  return v;
}

let scanned = 0;
let synced = 0;
const examples = [];

if (existsSync(DIST)) {
  for (const file of htmlFiles(DIST)) {
    scanned += 1;
    let html;
    try { html = readFileSync(file, 'utf8'); } catch { continue; }
    // Only the head is needed, and the head is near the top.
    const head = html.slice(0, 20000);
    if (noindexRe.test(head)) continue; // already says so
    const c = canonicalRe.exec(head);
    if (!c) continue;
    let target;
    try {
      const u = new URL(c[1], ORIGIN);
      if (u.origin !== ORIGIN) continue; // a canonical on another site is not ours to read
      target = u.pathname.replace(/\/+$/, '/');
    } catch { continue; }
    const self = ('/' + file.slice(DIST.length + 1).replace(/\\/g, '/').replace(/index\.html$/, '')).replace(/\/+$/, '/');
    if (target === self) continue; // self-canonical, nothing to reconcile
    if (!isNoindex(target)) continue;
    // Same tag the layout writes, placed where the layout would have put it.
    const out = html.replace(/<\/head>/i, '<meta name="robots" content="noindex,follow" /></head>');
    if (out === html) continue;
    writeFileSync(file, out);
    synced += 1;
    if (examples.length < 4) examples.push(`${self} -> ${target}`);
  }
}

// The company directory has a few hundred twins. If this ever touches a large
// share of the site, a canonical or robots tag in the layout has gone wrong,
// and quietly de-indexing thousands of pages is far worse than the
// contradiction this script exists to remove.
if (scanned > 0 && synced / scanned > 0.1) {
  console.error(`canonical-noindex-sync: ABORT SIGNAL, ${synced} of ${scanned} pages would be set noindex. ` +
    'That is not plausible; check the canonical and robots tags in src/layouts/Base.astro.');
  process.exit(1);
}

console.log(`canonical-noindex-sync: ${synced} page(s) set noindex because their canonical target is noindex, of ${scanned} scanned` +
  (examples.length ? `; e.g. ${examples.join(', ')}${synced > examples.length ? ', …' : ''}` : ''));
