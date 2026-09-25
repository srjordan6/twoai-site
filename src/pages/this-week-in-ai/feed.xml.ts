// /this-week-in-ai/feed.xml: the weekly AI policy and litigation digests as
// RSS 2.0, newest first. Stephen, 2026-09-25, for Google News. Built from
// content/week/*.json on every build; the description is the recap when the
// pipeline wrote one, otherwise the week's counts.
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function GET() {
  const weeks: any[] = [];
  if (existsSync('content/week')) {
    for (const f of readdirSync('content/week')) {
      if (!f.endsWith('.json') || f === 'index.json') continue;
      try { weeks.push(JSON.parse(readFileSync(`content/week/${f}`, 'utf8'))); } catch {}
    }
  }
  weeks.sort((a, b) => (String(a.end) < String(b.end) ? 1 : -1));
  const items = weeks.slice(0, 12).map((w) => {
    const c = w.counts || {};
    const fallback = `Between ${w.start} and ${w.end}: ${c.bills ?? 0} state bills moved, ${c.federal ?? 0} Federal Register documents, ${c.courts ?? 0} lawsuits with docket activity.`;
    const summary = String(w.recap || '').split('\n').filter((p: string) => p.trim())[0] || fallback;
    return `    <item>
      <title>${esc(w.label || `This Week in AI, ${w.start} to ${w.end}`)}</title>
      <link>https://theworldofai.org/this-week-in-ai/${w.slug}/</link>
      <guid isPermaLink="true">https://theworldofai.org/this-week-in-ai/${w.slug}/</guid>
      <pubDate>${new Date(String(w.end).slice(0, 10) + 'T12:00:00Z').toUTCString()}</pubDate>
      <description>${esc(summary)}</description>
    </item>`;
  }).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>This Week in AI, from The World of AI</title>
    <link>https://theworldofai.org/this-week-in-ai/</link>
    <atom:link href="https://theworldofai.org/this-week-in-ai/feed.xml" rel="self" type="application/rss+xml" />
    <description>A weekly digest of AI policy and litigation: state bills that moved, Federal Register documents, and lawsuits with docket activity, computed from the record. Edited by Stephen Jordan.</description>
    <language>en-us</language>
${items}
  </channel>
</rss>
`;
  return new Response(xml, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
}
