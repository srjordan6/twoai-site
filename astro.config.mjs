import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

// A sitemap must only carry URLs that answer 200 and are indexable, or the
// two signals contradict each other and crawlers distrust both. Three classes
// of page are therefore excluded here:
//
// 1. MCP server detail pages: registry metadata rather than our own writing;
//    they render noindex and stay out of the sitemap so the two signals agree.
//    The /mcp/ hub remains indexed.
// 2. Any path redirected in public/_redirects: a retired story or re-IDed
//    page still renders in dist (its data row survives), but the edge 301s
//    it, so listing it advertises a redirect. Parsed from the file so every
//    future retirement drops out of the sitemap automatically.
// 3. Tracked-only people profiles: they render noindex (see the people
//    directory route), so they must not be advertised either.
// 4. Research paper pages with no written content: a paper row whose
//    abstract and all three explanations are still empty is a catalogue
//    entry, not an article. On 2026-08-29 that was 129 of 134 papers, each
//    rendering four placeholder paragraphs, and AdSense flagged the site
//    for low value content the same day. Those pages now render noindex
//    (see the paper route) and are withheld here so the two signals agree.
//    A paper indexes again automatically the moment its first written
//    block lands, because both checks read the same content document.
// 5. Vendor news permalinks: live, linked and readable, but not advertised.
//    This one is a crawl-budget decision rather than a quality one, and the
//    numbers made it: on 2026-08-26 these were 2,227 of 4,315 live URLs, 51.6%
//    of the site, while Google Search Console reported 763 of them "Discovered
//    - currently not indexed" alongside 144 glossary terms in the same queue.
//    Google rations attention across a site, and half the queue was the least
//    valuable half - third-party feed summaries competing against the
//    definitions this site is actually cited for.
//
//    They are NOT noindexed and NOT removed. Every permalink still answers
//    200, still carries its archive links, and can still be indexed if Google
//    arrives by another route. Removing them was never an option: a summary
//    floor applied to this same set on 2026-08-22 deleted 2,948 published
//    URLs and produced thirteen 404s in Search Console, and published URLs do
//    not move here. The /ai-news/vendor/ hub and the archive stay in the
//    sitemap, so the set remains discoverable as a set.

function redirectedPaths() {
  const out = new Set();
  if (!existsSync('public/_redirects')) return out;
  for (const line of readFileSync('public/_redirects', 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const src = t.split(/\s+/)[0];
    if (src && src.startsWith('/') && !src.includes('*') && !src.includes(':')) out.add(src.endsWith('/') ? src : `${src}/`);
  }
  return out;
}

// Retained as a no-op guard rather than deleted. Per-person pages stopped being
// published on 2026-09-01, when profiles folded into their primary category's
// section page, so there is no tracked-only person page left to exclude and
// this returns an empty set. It stays because the situation it guards against,
// a page that renders noindex while being advertised in the sitemap, is exactly
// the contradiction the comment at the top of this file exists to prevent, and
// the day a tracked-only shape returns it should be caught here rather than
// rediscovered in Search Console.
function noindexPeoplePaths() {
  const out = new Set();
  const dir = 'content/people';
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json') || f === 'index.json' || f.startsWith('cat-')) continue;
    try {
      const p = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
      if (p.uid && p.tracked_only) out.add(`/ai-ecosystem/ecosystem-entities-market-and-operations/${p.uid}/`);
    } catch { /* a malformed file fails the build elsewhere; not here */ }
  }
  return out;
}

function thinPaperPaths() {
  const out = new Set();
  const dir = 'content/research/paper';
  if (!existsSync(dir)) return out;
  const has = (s) => typeof s === 'string' && s.trim() !== '';
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const p = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
      if (p.uid && !has(p.abstract) && !has(p.explain_beginner) && !has(p.explain_practitioner) && !has(p.explain_business))
        out.add(`/research/paper/${p.uid}/`);
    } catch { /* a malformed file fails the build elsewhere; not here */ }
  }
  return out;
}

// Same gate as thinPaperPaths, for company pages. Added 2026-09-11 when
// Stephen asked directly whether the ETF-fund constituent pages are thin or
// real: they are thin by construction, a facts table with no products, no
// lawsuits, no MCP servers and no written profile, because no website was
// supplied for the harvester to crawl. This page had no noindex protection
// at all until the same day - see the noindex prop in companies/[id].astro -
// so the sitemap side has to agree with it or the two signals contradict,
// which is the exact failure this file's own opening comment exists to
// prevent.
function thinCompanyPaths() {
  const out = new Set();
  const dir = 'content/companies';
  if (!existsSync(dir)) return out;
  const arrLen = (v) => (Array.isArray(v) ? v.length : 0);
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json') || f === 'index.json' || f === 'stocks.json') continue;
    try {
      const d = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
      const c = d && d.company;
      if (!c || !c.uid) continue;
      const bare = arrLen(c.products) === 0 && arrLen(c.cases) === 0 && arrLen(c.mcp) === 0 && !d.profile_text;
      if (bare) out.add(`/companies/${c.uid}/`);
    } catch { /* a malformed file fails the build elsewhere; not here */ }
  }
  return out;
}

const excluded = new Set([...redirectedPaths(), ...noindexPeoplePaths(), ...thinPaperPaths(), ...thinCompanyPaths()]);

// Pages the sitemap deliberately withholds, recorded as the build decides
// them. THIS EXISTS BECAUSE url_registry READS THE SITEMAP. That was the right
// source while "in the sitemap" and "on the site" meant the same thing; the
// moment vendor permalinks were withdrawn for crawl budget on 2026-08-26,
// 5,000 live pages started reporting as gone and the registry raised 2,218
// URLs for redirect-or-restore that need neither. Publishing the withheld set
// keeps the registry's founding property intact: it still learns the site from
// the build, so it cannot disagree with what actually rendered.
const unlisted = new Set();

// Draft section pages, read from the content bundle at config time. A page
// document carrying draft: true is built and reachable but must not enter the
// sitemap, so a section that is still an outline is never submitted for
// indexing. The page itself also renders noindex; see the ecosystem [id]
// route. Both read the same flag, so removing it in SQL publishes the page
// with the URL it already had.
const draftUids = new Set();
try {
  const { readdirSync, readFileSync } = await import('node:fs');
  for (const f of readdirSync('content/industries')) {
    if (!f.endsWith('.json')) continue;
    const d = JSON.parse(readFileSync(`content/industries/${f}`, 'utf8'));
    if (d?.draft && d?.uid) draftUids.add(d.uid);
  }
} catch { /* no bundle yet, or no industries directory: nothing to exclude */ }

function sitemapKeeps(page) {
  // Drafts never reach the sitemap.
  for (const uid of draftUids) {
    if (page.includes(`/${uid}/`)) return false;
  }
  if (/\/mcp\/[^/]+\/$/.test(page) && !page.endsWith('/mcp/')) return false;
  // Vendor permalinks out, the hub itself in.
  if (/\/ai-news\/vendor\/[^/]+\/$/.test(page)) return false;
  const path = new URL(page).pathname;
  return !excluded.has(path);
}

// Emits /unlisted-urls.json alongside the sitemap: live, reachable pages that
// are intentionally not advertised. A consumer that wants "every URL this
// build serves" reads the sitemap and this file together.
function unlistedManifest() {
  return {
    name: 'twoai-unlisted-manifest',
    hooks: {
      'astro:build:done': async ({ pages, dir }) => {
        const all = pages.map((p) => `https://theworldofai.org/${p.pathname}`);
        const withheld = all.filter((u) => !sitemapKeeps(u)).sort();
        const { writeFileSync } = await import('node:fs');
        writeFileSync(
          new URL('unlisted-urls.json', dir),
          JSON.stringify({
            note: 'Live pages deliberately kept out of sitemap.xml. They answer 200 and are linked; they are simply not advertised for crawl budget or noindex reasons.',
            generated: new Date().toISOString().slice(0, 10),
            count: withheld.length,
            urls: withheld,
          })
        );
        console.log(`unlisted-urls.json: ${withheld.length} live pages withheld from the sitemap`);
      },
    },
  };
}

// FIVE SENTENCES PER PARAGRAPH, ENFORCED ON THE RENDERED HTML.
//
// Stephen's standing rule: no paragraph on the site over four or five
// sentences. It was first enforced at render time in four templates on
// 2026-09-10 (capParagraphs in src/lib/prose.ts), and on 2026-09-11 a live
// sample of 192 pages across all 28 sections still found 59 paragraphs over
// the limit, the worst at 15 sentences: compliance pages, prompt examples,
// weekly recaps carrying bill descriptions, facility pages, static pages.
// Dozens of templates print prose, and wiring the cap into each one is how
// "committed" and "true" came apart.
//
// So the rule is applied here, once, to every HTML file the build produced,
// after every template has run. Nothing can render a long paragraph past
// this step, whichever template wrote it and whenever it is added.
//
// Splitting is HTML-aware and conservative. A <p> is tokenised into tags and
// text; a split may only happen at a sentence boundary in text that sits
// at inline-tag depth zero, so a sentence that ends inside an <a> or <b>
// is never cut mid-element. Paragraphs containing block or code elements
// are left alone, as is anything inside <pre>. The split keeps the <p>'s
// own attributes on every piece, so Astro's scoped-style data attributes
// survive and the pieces style exactly as the original did. Six sentences
// become 3+3, not 5+1, the same even distribution as capParagraphs.
function capParagraphsInHtml() {
  const SB = /[.!?]+["'\u2019\u201d)]*(?=\s+[A-Z0-9"'\u2018\u201c(]|\s*$)/g;
  const MAX = 5;
  const splitOne = (open, inner) => {
    if (/<(p|div|ul|ol|li|table|pre|code|blockquote|h[1-6]|section|figure|svg)[\s>]/i.test(inner)) return null;
    const toks = inner.split(/(<[^>]+>)/).filter((t) => t !== '');
    // Sentence units: each is a run of tokens ending at a boundary at depth 0.
    const units = [];
    let cur = '';
    let depth = 0;
    for (const t of toks) {
      if (t.startsWith('<')) {
        cur += t;
        if (/^<\/[a-z]/i.test(t)) depth = Math.max(0, depth - 1);
        else if (!/\/>$/.test(t) && !/^<(br|img|wbr|input|hr)\b/i.test(t)) depth++;
        continue;
      }
      if (depth > 0) { cur += t; continue; }
      let last = 0;
      let m;
      SB.lastIndex = 0;
      while ((m = SB.exec(t))) {
        const end = m.index + m[0].length;
        cur += t.slice(last, end);
        units.push(cur);
        cur = '';
        last = end;
      }
      cur += t.slice(last);
    }
    if (cur.trim()) units.push(cur);
    if (units.length <= MAX) return null;
    const chunks = Math.ceil(units.length / MAX);
    const per = Math.ceil(units.length / chunks);
    const out = [];
    for (let i = 0; i < units.length; i += per) out.push(open + units.slice(i, i + per).join('').trim() + '</p>');
    return out.join('\n');
  };
  return {
    name: 'twoai-cap-paragraphs',
    hooks: {
      'astro:build:done': async ({ dir }) => {
        const { readdirSync, readFileSync, writeFileSync, statSync } = await import('node:fs');
        const { join } = await import('node:path');
        const root = new URL(dir).pathname.replace(/^\/([A-Za-z]:)/, '$1');
        let files = 0, split = 0;
        const walk = (d) => {
          for (const f of readdirSync(d)) {
            const p = join(d, f);
            if (statSync(p).isDirectory()) { walk(p); continue; }
            if (!f.endsWith('.html')) continue;
            const html = readFileSync(p, 'utf8');
            // Protect <pre> blocks from any rewriting.
            const pres = [];
            let work = html.replace(/<pre[\s\S]*?<\/pre>/gi, (m) => { pres.push(m); return `\u0000PRE${pres.length - 1}\u0000`; });
            let n = 0;
            work = work.replace(/(<p\b[^>]*>)([\s\S]*?)<\/p>/gi, (m, open, inner) => {
              const r = splitOne(open, inner);
              if (r === null) return m;
              n++;
              return r;
            });
            if (n > 0) {
              work = work.replace(/\u0000PRE(\d+)\u0000/g, (_, i) => pres[+i]);
              writeFileSync(p, work);
              split += n;
            }
            files++;
          }
        };
        walk(root);
        console.log(`cap-paragraphs: ${files} pages scanned, ${split} paragraphs split to <=${MAX} sentences`);
      },
    },
  };
}

// DEAD OUTBOUND LINKS, NEUTRALISED AT BUILD TIME.
//
// srj-pipeline's twoai_link_check fetches every external URL the site
// renders and, when one answers 404 or 410 on two checks at least three days
// apart, publishes it in content/meta/dead-links.json. Until 2026-09-14 that
// verdict went to stderr and nowhere else: the page kept its link and a
// reader kept getting a 404. A Screaming Frog crawl that day flagged four
// dead outbound links; the checker already knew about 24.
//
// This does the same thing for links that capParagraphsInHtml does for
// prose: one pass over the built HTML, after every template has run, so
// the fix reaches all of them at once and reaches templates written next
// year. A dead anchor keeps its text and loses its href, gaining a title
// that says why - the reader sees the source's name and is not sent to a
// page that is not there. A source that comes back leaves the list on the
// next pipeline run and its anchor returns on the next build.
function neutraliseDeadLinks() {
  return {
    name: 'twoai-dead-links',
    hooks: {
      'astro:build:done': async ({ dir }) => {
        const { readdirSync, readFileSync, writeFileSync, statSync, existsSync } = await import('node:fs');
        const { join } = await import('node:path');
        if (!existsSync('content/meta/dead-links.json')) return;
        let dead;
        try { dead = JSON.parse(readFileSync('content/meta/dead-links.json', 'utf8')); } catch { return; }
        const urls = new Map();
        for (const l of dead.links || []) if (l.url) urls.set(l.url, l);
        if (urls.size === 0) { console.log('dead-links: none to neutralise'); return; }
        const root = new URL(dir).pathname.replace(/^\/([A-Za-z]:)/, '$1');
        let pages = 0, anchors = 0;
        const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
        const walk = (d) => {
          for (const f of readdirSync(d)) {
            const p = join(d, f);
            if (statSync(p).isDirectory()) { walk(p); continue; }
            if (!f.endsWith('.html')) continue;
            const html = readFileSync(p, 'utf8');
            let n = 0;
            const out = html.replace(/<a\b([^>]*?)\shref="([^"]+)"([^>]*)>/gi, (m, pre, href, post) => {
              const h = href.replace(/&amp;/g, '&');
              const d = urls.get(h) || urls.get(h.replace(/\/$/, '')) || urls.get(h + '/');
              if (!d) return m;
              n++;
              // Merge any class the template set so styling holds; drop rel
              // and target since there is nothing to open.
              const clsm = (pre + post).match(/\sclass="([^"]*)"/i);
              const cls = clsm ? clsm[1] + ' dead-link' : 'dead-link';
              return `<span class="${cls}" title="${esc('This source answered ' + d.status + ' on ' + d.since + ' and again later. Link removed until it returns.')}" data-dead-href="${esc(href)}">`;
            });
            if (n > 0) {
              // Close the spans that replaced anchors. Anchors we did not
              // touch still close with </a>; the ones we did need </span>.
              // Simplest correct approach: walk anchors in order.
              let fixed = '', depth = [];
              const tokens = out.split(/(<a\b[^>]*>|<\/a>|<span class="[^"]*dead-link"[^>]*>)/i);
              for (const t of tokens) {
                if (/^<span class="[^"]*dead-link"/i.test(t)) { depth.push('span'); fixed += t; }
                else if (/^<a\b/i.test(t)) { depth.push('a'); fixed += t; }
                else if (/^<\/a>$/i.test(t)) { fixed += depth.pop() === 'span' ? '</span>' : '</a>'; }
                else fixed += t;
              }
              writeFileSync(p, fixed);
              anchors += n; pages++;
            }
          }
        };
        walk(root);
        console.log(`dead-links: ${urls.size} known dead, ${anchors} anchors neutralised on ${pages} pages`);
      },
    },
  };
}

// Static output; content is fetched from the twoai-content repo by
// scripts/fetch-content.mjs before every build (see package.json prebuild).
export default defineConfig({
  site: 'https://theworldofai.org',
  integrations: [sitemap({ filter: sitemapKeeps }), unlistedManifest(), capParagraphsInHtml(), neutraliseDeadLinks()],
  build: { format: 'directory' },
});
