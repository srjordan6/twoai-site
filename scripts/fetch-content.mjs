// Pull the generated content into content/ before the build, and copy the
// aggregates to public/api/ so the same JSON the site is built from is publicly
// fetchable. Content is a pipeline artifact: SQL is the source of truth, the
// daily cron exports it, and this script only reads.
//
// TWO SOURCES, R2 FIRST, GITHUB AS FALLBACK.
//
// The pipeline publishes the whole content set twice: as one gzipped tar in R2
// under a content hash, named by a small manifest, and file by file into the
// twoai-content repo. R2 is preferred because the GitHub path does not scale:
// the MCP registry took the content set to 1,616 files and the per-file
// contents API publish ran about twenty minutes, where the R2 bundle is 988 KB
// in a single request.
//
// GitHub stays wired as the fallback deliberately, and will until R2 has proven
// itself over a stretch of runs. Publishing is the thing that must never break,
// so a second working path costs one curl and buys the ability to lose one.
//
// The manifest carries the bundle's sha256 and this script verifies it. A
// truncated or corrupted download therefore fails over to GitHub rather than
// building a site from half a bundle, which would look like a successful build
// with silently missing pages.
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const REPO = 'https://github.com/srjordan6/twoai-content';
const R2 = 'https://pub-b8347c6e4e8c40febe3c83d8860826e2.r2.dev';
const dirs = ['laws', 'glossary', 'lawsuits', 'caselaw', 'static', 'tools', 'week', 'ecosystem', 'compliance', 'mcp', 'people', 'companies', 'research', 'sources', 'benchmarks', 'prompts', 'news', 'timeline', 'jobs', 'skills', 'models', 'repos', 'status', 'tech', 'learn', 'industries', 'observatory', 'security', 'downloads', 'talent', 'meta', 'compute'];
// 'downloads' was missing here while the pipeline was already writing
// downloads/*.json and the /downloads/ routes were live, so the hub counted
// zero documents and every template returned 404. A directory absent from this
// list is not fetched, so the route's getStaticPaths sees nothing and fails
// silently: no build error, just missing pages. 'caselaw' then repeated the
// same failure on 2026-08-29: stage shipped, route shipped, taxonomy live,
// and all sixteen pages 404ed for one build because the only list that
// mattered was this one.

mkdirSync('content', { recursive: true });
for (const d of dirs) mkdirSync(`content/${d}`, { recursive: true });

function copyDirs(from) {
  let total = 0;
  for (const d of dirs) {
    if (existsSync(`${from}/${d}`)) {
      cpSync(`${from}/${d}`, `content/${d}`, { recursive: true });
      const n = readdirSync(`content/${d}`).length;
      total += n;
      console.log(`content/${d}: ${n} file(s)`);
    }
  }
  return total;
}

function fromR2() {
  execSync(`curl -fsL --max-time 60 ${R2}/manifest.json -o /tmp/twoai-manifest.json`, { stdio: 'inherit' });
  const m = JSON.parse(readFileSync('/tmp/twoai-manifest.json', 'utf8'));
  if (!m.bundle || !m.sha256) throw new Error('manifest missing bundle or sha256');
  execSync(`curl -fsL --max-time 300 ${R2}/${m.bundle} -o /tmp/twoai-bundle.tar.gz`, { stdio: 'inherit' });
  const got = createHash('sha256').update(readFileSync('/tmp/twoai-bundle.tar.gz')).digest('hex');
  if (got !== m.sha256) throw new Error(`bundle sha256 mismatch: expected ${m.sha256}, got ${got}`);
  execSync('rm -rf /tmp/twoai-r2 && mkdir -p /tmp/twoai-r2 && tar -xzf /tmp/twoai-bundle.tar.gz -C /tmp/twoai-r2', { stdio: 'inherit' });
  const n = copyDirs('/tmp/twoai-r2');
  console.log(`fetch-content: R2 bundle ${m.bundle}, ${m.files} files declared, ${n} copied, generated ${m.generated}`);
  if (n === 0) throw new Error('R2 bundle contained no content directories');
  // A shortfall means the bundle holds a directory this script does not know
  // about, which is how the company directory published to R2 and then never
  // reached the site: the pages existed, the build succeeded, and 62 files were
  // silently dropped on the floor. Name the gap rather than swallowing it.
  if (n < m.files) {
    const known = new Set(dirs);
    const extra = readdirSync('/tmp/twoai-r2').filter((d) => !known.has(d));
    console.warn(`fetch-content: WARNING ${m.files - n} file(s) in the bundle were not copied` +
      (extra.length ? `; unknown content directories: ${extra.join(', ')}` : ''));
  }
}

function fromGitHub() {
  execSync(`curl -fsL ${REPO}/archive/refs/heads/main.tar.gz -o /tmp/twoai-content.tar.gz`, { stdio: 'inherit' });
  execSync('rm -rf /tmp/twoai-content && mkdir -p /tmp/twoai-content && tar -xzf /tmp/twoai-content.tar.gz -C /tmp/twoai-content --strip-components=1', { stdio: 'inherit' });
  const n = copyDirs('/tmp/twoai-content');
  console.log(`fetch-content: GitHub tarball, ${n} files copied`);
}

// R2 FIRST, AS THE HEADER SAYS. A one-shot GitHub-first override was left
// here after a corrected file was pushed straight to the repo, and it never
// came out. On 2026-09-04 that cost a build: the GitHub publish had been
// killed at its 45-minute deadline halfway through 1,500 changed files, so
// the tarball was a mixed set, while R2 held the complete atomic bundle
// the same run had already written. R2 is the content bus. GitHub is the
// fallback, and nothing else.
try {
  fromR2();
} catch (e) {
  console.warn('fetch-content: R2 unavailable, falling back to GitHub:', e.message);
  try {
    fromGitHub();
  } catch (e2) {
    console.warn('fetch-content: proceeding without remote content:', e2.message);
  }
}

// DAILY AI BRIEFING, FETCHED FROM ITS PUBLISHER.
//
// news/news.json is the artifact the pipeline's publish_news stage writes to
// srj-content every morning: today's stories clustered from worldwide
// coverage, ranked by outlet breadth, with sources and named entities. Both
// sites render the same edition, so this script fetches it straight from the
// publishing repo rather than duplicating the artifact into twoai-content.
// The deploy_site hook fires after publish_news in the daily run, so every
// build carries that morning's briefing.
//
// It holds TODAY only, which is why it cannot be the source of truth for the
// story permalinks: a slug built from it lived exactly one day and then 404'd,
// two more of them every morning. news/archive.json, published from
// twoai_news_stories by the twoai_build stage, carries every story ever seen
// and travels with the rest of the content in the R2 bundle. This file stays
// the source for the briefing; the archive is the source for the permalinks.
function fetchNews() {
  mkdirSync('content/news', { recursive: true });
  execSync('curl -fsL --max-time 60 https://raw.githubusercontent.com/srjordan6/srj-content/main/news/news.json -o content/news/news.json', { stdio: 'inherit' });
  const n = JSON.parse(readFileSync('content/news/news.json', 'utf8'));
  if (!Array.isArray(n.stories)) throw new Error('news.json missing stories');
  console.log(`content/news: briefing ${n.date}, ${n.stories.length} stories`);
}
try {
  fetchNews();
} catch (e) {
  console.warn('fetch-content: news briefing unavailable, /ai-news/ renders its empty state:', e.message);
}

// TAXONOMY COMES FROM THE BUNDLE. DELIBERATELY.
//
// This build used to read twoai_taxonomy live from Postgres when DATABASE_URL
// was present, so a one-row structural flip appeared on any redeploy. On
// 2026-08-14 that path was retired on purpose: it kept a database credential
// inside a third party''s build environment and a public-internet connection
// to the database on every build, and it made builds non-deterministic (the
// same commit could produce different sites). The R2 bundle carries the
// taxonomy exported by the same pipeline run that triggers this deploy, so
// bundle and structure are always consistent, and the flip-before-run rule
// plus the ~1-minute `pipeline twoai` fast path cover the convergence loop.
// The functions below are retired no-ops kept for the record.
async function taxonomyFromSQL() {
  // Retired 2026-08-14: bundle is the sole taxonomy source (see note above).
  return false;
  /* eslint-disable no-unreachable */
  const url = process.env.DATABASE_URL;
  if (!url) return false;
  let pg;
  try {
    pg = await import('pg');
  } catch {
    console.warn('fetch-content: DATABASE_URL set but pg is not installed, using bundled taxonomy');
    return false;
  }
  const client = new pg.default.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const { rows } = await client.query(`
      SELECT t.slug, t.name, COALESCE(t.blurb,'') AS blurb, t.status,
             COALESCE(t.live_path,'') AS path, COALESCE(t.parent_slug,'') AS parent,
             t.level, t.sort,
             (SELECT COALESCE(sum(p.url_count),0) FROM twoai_pages p WHERE p.taxonomy_slug = t.slug) AS pages
      FROM twoai_taxonomy t WHERE t.level IN (1,2,3) ORDER BY t.level, t.sort`);
    const today = new Date().toISOString().slice(0, 10);
    const cats = [];
    const byCat = new Map();
    const byDom = new Map();
    for (const r of rows.filter((r) => r.level === 1)) {
      const c = { slug: r.slug, name: r.name, blurb: r.blurb, domains: [], live: 0, pages: 0 };
      cats.push(c);
      byCat.set(r.slug, c);
    }
    for (const r of rows.filter((r) => r.level === 2)) {
      const c = byCat.get(r.parent);
      if (!c) continue;
      const d = { slug: r.slug, name: r.name, blurb: r.blurb, status: r.status,
        path: r.path || undefined, pages: Number(r.pages), sections: [] };
      c.domains.push(d);
      byDom.set(r.slug, d);
    }
    for (const r of rows.filter((r) => r.level === 3)) {
      const d = byDom.get(r.parent);
      if (!d) continue;
      d.sections.push({ slug: r.slug, name: r.name, blurb: r.blurb, status: r.status,
        path: r.path || undefined, pages: Number(r.pages) });
      d.pages += Number(r.pages);
      if (r.status === 'live') d.status = 'live';
    }
    for (const c of cats) {
      for (const d of c.domains) {
        c.pages += d.pages;
        if (d.status === 'live') c.live += 1;
      }
    }
    mkdirSync('content/ecosystem', { recursive: true });
    for (const c of cats) {
      writeFileSync(`content/ecosystem/${c.slug}.json`, JSON.stringify({
        slug: c.slug, name: c.name, blurb: c.blurb, domains: c.domains,
        live: c.live, total: c.domains.length, pages: c.pages, generated: today,
      }));
    }
    writeFileSync('content/ecosystem/index.json', JSON.stringify({
      categories: cats.map((c) => ({ slug: c.slug, name: c.name, blurb: c.blurb,
        live: c.live, total: c.domains.length, pages: c.pages })),
      generated: today,
    }));
    console.log(`fetch-content: taxonomy read live from SQL, ${cats.length} categories`);
    return true;
  } finally {
    await client.end();
  }
}

try {
  await taxonomyFromSQL();
} catch (e) {
  console.warn('fetch-content: live taxonomy unavailable, using bundled copy:', e.message);
}

// THE RESEARCH LIBRARY IS READ LIVE FROM POSTGRES TOO, FOR THE SAME REASON.
//
// twoai_research_papers is refreshed by a scheduled Cowork task, because
// Consensus is an MCP connector reachable only from a Claude session and not an
// HTTP API the pipeline can call. Routing that refresh through the nightly cron
// to reach the site would mean running twenty unrelated stages, LegiScan,
// GDELT, CourtListener and the rest, to publish eleven small JSON files. That
// is the wrong loop, exactly as it was for a one-row taxonomy edit.
//
// So the render rows are read straight from twoai_pages, which twoai_build
// writes and the Cowork task can upsert directly. A deploy of this site then
// picks up a refreshed shelf with no pipeline involvement at all. Without
// DATABASE_URL it silently uses whatever the bundle carried, so the build never
// depends on the database being reachable.
async function researchFromSQL() {
  // Retired 2026-08-14 with the taxonomy live-read; the bundle carries research/.
  return false;
  /* eslint-disable no-unreachable */
  const url = process.env.DATABASE_URL;
  if (!url) return false;
  let pg;
  try {
    pg = await import('pg');
  } catch {
    console.warn('fetch-content: DATABASE_URL set but pg is not installed, using bundled research');
    return false;
  }
  const client = new pg.default.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const { rows } = await client.query(`
      SELECT path, data FROM twoai_pages
      WHERE kind IN ('research-topic','research-hub','research-paper','sources-hub') ORDER BY path`);
    if (!rows.length) return false;
    mkdirSync('content/research', { recursive: true });
    mkdirSync('content/research/paper', { recursive: true });
    mkdirSync('content/sources', { recursive: true });
    for (const r of rows) {
      // path is already the repo-relative content path, e.g. research/index.json,
      // research/paper/rXXXXXXX.json, or sources/index.json.
      const parts = r.path.split('/');
      if (parts.length > 1) {
        mkdirSync(`content/${parts.slice(0, -1).join('/')}`, { recursive: true });
      }
      writeFileSync(`content/${r.path}`, JSON.stringify(r.data));
    }
    console.log(`fetch-content: research + sources read live from SQL, ${rows.length} page(s)`);
    return true;
  } finally {
    await client.end();
  }
}

try {
  await researchFromSQL();
} catch (e) {
  console.warn('fetch-content: live research unavailable, using bundled copy:', e.message);
}

// Public API mirrors of the aggregates.
mkdirSync('public/api', { recursive: true });
const api = [
  ['content/laws/index.json', 'public/api/laws.json'],
  ['content/glossary/glossary.json', 'public/api/glossary.json'],
  ['content/lawsuits/lawsuits.json', 'public/api/lawsuits.json'],
  ['content/tools/index.json', 'public/api/tools.json'],
  ['content/week/index.json', 'public/api/weeks.json'],
  ['content/compliance/index.json', 'public/api/compliance.json'],
  ['content/mcp/index.json', 'public/api/mcp.json'],
  ['content/talent/matches.json', 'public/api/talent-matches.json'],
  ['content/people/index.json', 'public/api/people.json'],
  ['content/companies/index.json', 'public/api/companies.json'],
  ['content/research/index.json', 'public/api/research.json'],
  ['content/sources/index.json', 'public/api/sources.json'],
  // llms.txt advertised these two long before they were mirrored, so both
  // returned 404 to every crawler that followed the machine-readable index.
  // The graph data has been in the content bundle under learn/ all along.
  ['content/learn/graph-entities.json', 'public/api/graph-entities.json'],
  ['content/learn/graph-relationships.json', 'public/api/graph-relationships.json'],
];
for (const [src, dst] of api) if (existsSync(src)) copyFileSync(src, dst);
