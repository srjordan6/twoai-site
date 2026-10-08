// NO EXTERNAL LINKS UNDER /ai-news/. Stephen, 2026-10-07 (theworldofai rows
// 581 and 582): the news section attributes its sources as plain text, outlet
// and date, and renders no hyperlink to an external domain anywhere in
// <main>. The URLs stay in the JSON and the database; this is a render rule.
// The build fails if any page under dist/ai-news/ carries an external href
// inside <main>, so the rule cannot drift back in through a template or a
// component. Internal links, mailto and anchors are fine; the RSS feeds are
// feeds, not pages, and keep their links.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = 'dist/ai-news';
const ours = new Set(['theworldofai.org', 'www.theworldofai.org']);

function walk(dir, out = []) {
  let entries = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.html')) out.push(p);
  }
  return out;
}

const hits = [];
let pages = 0;
for (const file of walk(root)) {
  pages++;
  const html = readFileSync(file, 'utf8');
  const main = html.match(/<main[\s\S]*?<\/main>/i);
  const scope = main ? main[0] : html;
  const re = /href=["'](https?:)?\/\/([^/"'?#]+)/gi;
  let m;
  while ((m = re.exec(scope))) {
    const host = m[2].toLowerCase();
    if (!ours.has(host)) hits.push(`${file}: ${host}`);
  }
}
if (hits.length) {
  console.error(`news-no-external-links: ${hits.length} external link(s) under /ai-news/ in ${pages} pages:`);
  for (const h of hits.slice(0, 40)) console.error('  ' + h);
  if (hits.length > 40) console.error(`  ... and ${hits.length - 40} more`);
  process.exit(1);
}
console.log(`news-no-external-links: ${pages} pages under /ai-news/, no external links in <main>`);
