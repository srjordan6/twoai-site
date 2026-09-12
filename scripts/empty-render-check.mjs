/**
 * Empty-render audit: fail the build when a template prints structure with
 * nothing in it.
 *
 * WHY THIS EXISTS. The same bug has now shipped three times, each time
 * invisible until someone looked at a page:
 *   2026-09-01  the person template read shapes site_people does not use.
 *               58 profiles damaged at once - "[object Object]", quick facts
 *               labelled 0/1/2/3, five empty bullets under "Known for".
 *   2026-09-01  `reading` was written by twoai_thinsense into 271 pages and
 *               rendered by 3 templates out of 15. 240 pages carried one and
 *               displayed none of it.
 *   2026-09-11  the compliance Sources list rendered title/url/publisher
 *               against citations carrying author/year/journal/quote. Every
 *               compliance page showed a row of empty bullets over real data.
 *
 * All three are one failure: a template reads a property the data does not
 * carry. JSX gives no error for that - a missing property is undefined, and
 * undefined renders as nothing - so the page builds, deploys, and looks
 * broken to a reader while every log says ok.
 *
 * The check is on the OUTPUT, not the templates, because output is the only
 * place the mismatch becomes visible. After every build it walks dist and
 * looks for list items, table cells, links and headings that contain no text
 * at all. Those are never intentional: a template that has nothing to say
 * should render nothing, not an empty bullet.
 *
 * It FAILS THE BUILD rather than warning. A warning in a build log is how
 * the 09-01 defects survived a month - twoai_thinaudit was already counting
 * words and nobody read it. A failed deploy is noticed the same day.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const DIST = 'dist';

// Elements whose entire purpose is to hold content. An empty one is a
// rendering failure, not a style choice. <td> is excluded deliberately: a
// blank cell in a data table is a legitimate "no value for this row".
const CONTAINERS = ['li', 'h1', 'h2', 'h3', 'a', 'figcaption', 'dt', 'dd'];

// Void of text once tags are stripped. An element holding only an <img>, an
// <svg>, or an <input> is doing its job, so those are treated as content.
const hasContent = (inner) => {
  if (/<(img|svg|input|picture|video|iframe|canvas)[\s>]/i.test(inner)) return true;
  return inner.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim() !== '';
};

const walk = (dir, out = []) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (f.endsWith('.html')) out.push(p);
  }
  return out;
};

const files = walk(DIST);
const findings = new Map(); // "tag in /section/" -> {count, example}

for (const file of files) {
  const html = readFileSync(file, 'utf8');
  const main = html.match(/<main[\s\S]*?<\/main>/i);
  if (!main) continue;
  const body = main[0];
  const url = '/' + relative(DIST, file).replace(/\\/g, '/').replace(/index\.html$/, '');

  for (const tag of CONTAINERS) {
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
    let m;
    let empties = 0;
    while ((m = re.exec(body))) if (!hasContent(m[1])) empties++;
    if (empties === 0) continue;
    // Group by section so one broken template reports once, not 4,000 times.
    const section = url.split('/')[1] || 'root';
    const key = `<${tag}> in /${section}/`;
    const prev = findings.get(key) || { pages: 0, empties: 0, example: url };
    prev.pages += 1;
    prev.empties += empties;
    findings.set(key, prev);
  }
}

if (findings.size === 0) {
  console.log(`empty-render: ${files.length} pages checked, no empty containers.`);
  process.exit(0);
}

console.error('\nempty-render: FAILED. A template is printing structure with nothing in it.');
console.error('This is almost always a template reading a field the data does not carry.\n');
const rows = [...findings.entries()].sort((a, b) => b[1].empties - a[1].empties);
for (const [key, v] of rows) {
  console.error(`  ${key.padEnd(34)} ${String(v.empties).padStart(6)} empty on ${String(v.pages).padStart(5)} pages   e.g. ${v.example}`);
}
console.error('\nCompare the template\'s property names against the page JSON in twoai_pages.');
console.error('If an element can legitimately be empty, give it content or do not render it.\n');
process.exit(1);
