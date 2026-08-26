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
// 4. Vendor news permalinks: live, linked and readable, but not advertised.
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

function noindexPeoplePaths() {
  const out = new Set();
  const dir = 'content/people';
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json') || f === 'index.json') continue;
    try {
      const p = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
      if (p.uid && p.tracked_only) out.add(`/ai-ecosystem/ecosystem-entities-market-and-operations/${p.uid}/`);
    } catch { /* a malformed file fails the build elsewhere; not here */ }
  }
  return out;
}

const excluded = new Set([...redirectedPaths(), ...noindexPeoplePaths()]);

// Pages the sitemap deliberately withholds, recorded as the build decides
// them. THIS EXISTS BECAUSE url_registry READS THE SITEMAP. That was the right
// source while "in the sitemap" and "on the site" meant the same thing; the
// moment vendor permalinks were withdrawn for crawl budget on 2026-08-26,
// 5,000 live pages started reporting as gone and the registry raised 2,218
// URLs for redirect-or-restore that need neither. Publishing the withheld set
// keeps the registry's founding property intact: it still learns the site from
// the build, so it cannot disagree with what actually rendered.
const unlisted = new Set();

function sitemapKeeps(page) {
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

// Static output; content is fetched from the twoai-content repo by
// scripts/fetch-content.mjs before every build (see package.json prebuild).
export default defineConfig({
  site: 'https://theworldofai.org',
  integrations: [sitemap({ filter: sitemapKeeps }), unlistedManifest()],
  build: { format: 'directory' },
});
