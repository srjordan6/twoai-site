// sitemap-noindex-prune.mjs: a sitemap must not advertise a page that tells
// crawlers not to index it.
//
// astro.config.mjs already excludes three classes of URL and says why: MCP
// detail pages, redirected paths, and tracked-only people. The list was
// maintained by hand and it fell behind the templates. On 2026-09-01 the built
// sitemap advertised /talent/login/, which renders noindex, along with every
// research paper and vendor post whose template had decided it was too thin to
// index. Two signals, contradicting each other, on pages nobody had thought
// about since the rule that generated them was written.
//
// The fix is not a longer list. Any rule copied from a template into the config
// drifts the moment the template changes, which is exactly how this happened.
// This reads the BUILT HTML instead: whatever the page actually says about
// robots is the truth, whichever template said it and whenever it changed.
//
// ORDER MATTERS, AND IT IS WHY THIS RUNS LAST. scripts/url-guard.mjs compares
// the sitemap this build produced against the sitemap the live site serves, and
// fails the deploy on any live URL that vanished. Pruning before that check
// would make every noindex page look like a loss and demand a retirement entry
// for a page that still exists and is still linked. So the guard sees the whole
// sitemap, and the prune happens after it. The next build is unaffected: the
// guard only fails on URLs that disappear, and these will be missing from both
// sides.
//
// Nothing here changes what is published. A pruned page still builds, still
// serves, and is still linked from its section; it simply stops being
// advertised to crawlers that were told to ignore it anyway.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';

const DIST = 'dist';
const noindexRe = /<meta[^>]+name=["']robots["'][^>]*content=["'][^"']*noindex/i;
const canonicalRe = /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i;

function sitemapFiles() {
  if (!existsSync(DIST)) return [];
  return readdirSync(DIST).filter((f) => /^sitemap-\d+\.xml$/.test(f));
}

// Two ways a page tells crawlers not to treat this URL as the canonical one,
// and both mean it does not belong in a sitemap.
//
//   noindex          do not index this page at all
//   canonical elsewhere   index the other URL instead of this one
//
// The second was added on 2026-09-01 for the company directory. Every company
// was published twice, once under /companies/{uid}/ and once under the
// ecosystem path, both declaring themselves canonical and both advertised: 269
// companies, 538 URLs, each pair competing with its own twin. The ecosystem
// copy now points at the richer /companies/ page, and this keeps the sitemap
// consistent with that.
function skipReason(pathname) {
  // Directory-format build: /a/b/ is dist/a/b/index.html.
  const file = `${DIST}${pathname.endsWith('/') ? pathname : `${pathname}/`}index.html`;
  if (!existsSync(file)) return ''; // absent is url-guard's problem, not this script's
  let html;
  try {
    html = readFileSync(file, 'utf8');
  } catch {
    return '';
  }
  if (noindexRe.test(html)) return 'noindex';
  const c = canonicalRe.exec(html);
  if (c) {
    try {
      // Compare paths, not strings: a trailing slash or a protocol difference
      // is not a different canonical target.
      const declared = new URL(c[1]).pathname.replace(/\/+$/, '/');
      const self = pathname.replace(/\/+$/, '/');
      if (declared !== self) return 'canonical elsewhere';
    } catch { /* an unparseable canonical is not evidence of anything */ }
  }
  return '';
}

let scanned = 0;
let pruned = 0;
const dropped = [];
const reasons = {};

for (const f of sitemapFiles()) {
  const path = `${DIST}/${f}`;
  const xml = readFileSync(path, 'utf8');
  const out = xml.replace(/<url>[\s\S]*?<\/url>/g, (block) => {
    const loc = /<loc>\s*([^<]+?)\s*<\/loc>/.exec(block);
    if (!loc) return block;
    scanned += 1;
    let pathname;
    try {
      pathname = new URL(loc[1]).pathname;
    } catch {
      return block;
    }
    const reason = skipReason(pathname);
    if (!reason) return block;
    pruned += 1;
    reasons[reason] = (reasons[reason] || 0) + 1;
    if (dropped.length < 6) dropped.push(`${pathname} (${reason})`);
    return '';
  });
  if (out !== xml) writeFileSync(path, out);
}

// A prune that removes nearly everything means the noindex test matched
// something it should not have, and a silently emptied sitemap is worse than a
// contradictory one. Say so loudly rather than shipping it.
if (scanned > 0 && pruned / scanned > 0.5) {
  console.error(`sitemap-prune: ABORT SIGNAL, ${pruned} of ${scanned} URLs were excluded. ` +
    'That is not plausible; check the robots meta and the canonical tag in ' +
    'src/layouts/Base.astro before deploying.');
  process.exit(1);
}

const detail = Object.entries(reasons).map(([k, v]) => `${v} ${k}`).join(', ');
console.log(`sitemap-prune: ${pruned} URL(s) removed from the sitemap of ${scanned} scanned` +
  (detail ? ` (${detail})` : '') +
  (dropped.length ? `; e.g. ${dropped.join(', ')}${pruned > dropped.length ? ', …' : ''}` : ''));
