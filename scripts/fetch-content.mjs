// Pull the generated content (twoai-content repo) into content/ before the
// build, and copy the aggregates to public/api/ so the same JSON the site is
// built from is publicly fetchable. The repo is a pipeline artifact: SQL is
// the source of truth, the daily cron exports it, and this script only reads.
//
// Every step tolerates absence so the very first Cloudflare build, before the
// pipeline's first run, still succeeds and ships the shell pages.
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';

const REPO = 'https://github.com/srjordan6/twoai-content';
const dirs = ['laws', 'glossary', 'lawsuits', 'static', 'tools', 'week', 'ecosystem', 'compliance'];

mkdirSync('content', { recursive: true });
for (const d of dirs) mkdirSync(`content/${d}`, { recursive: true });

try {
  execSync(`curl -fsL ${REPO}/archive/refs/heads/main.tar.gz -o /tmp/twoai-content.tar.gz`, { stdio: 'inherit' });
  execSync('mkdir -p /tmp/twoai-content && tar -xzf /tmp/twoai-content.tar.gz -C /tmp/twoai-content --strip-components=1', { stdio: 'inherit' });
  for (const d of dirs) {
    if (existsSync(`/tmp/twoai-content/${d}`)) {
      cpSync(`/tmp/twoai-content/${d}`, `content/${d}`, { recursive: true });
      console.log(`content/${d}: ${readdirSync(`content/${d}`).length} file(s)`);
    }
  }
} catch (e) {
  console.warn('fetch-content: proceeding without remote content:', e.message);
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
];
for (const [src, dst] of api) if (existsSync(src)) copyFileSync(src, dst);
