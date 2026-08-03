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
import { cpSync, existsSync, mkdirSync, readdirSync, copyFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const REPO = 'https://github.com/srjordan6/twoai-content';
const R2 = 'https://pub-b8347c6e4e8c40febe3c83d8860826e2.r2.dev';
const dirs = ['laws', 'glossary', 'lawsuits', 'static', 'tools', 'week', 'ecosystem', 'compliance', 'mcp', 'people', 'companies'];

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

try {
  fromR2();
} catch (e) {
  console.warn('fetch-content: R2 unavailable, falling back to GitHub:', e.message);
  try {
    fromGitHub();
  } catch (e2) {
    // Both sources gone. Build the shell rather than failing: an empty section
    // renders its own "publishes on the next run" copy, which is a better
    // outcome than no deploy at all.
    console.warn('fetch-content: proceeding without remote content:', e2.message);
  }
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
  ['content/people/index.json', 'public/api/people.json'],
  ['content/companies/index.json', 'public/api/companies.json'],
];
for (const [src, dst] of api) if (existsSync(src)) copyFileSync(src, dst);
