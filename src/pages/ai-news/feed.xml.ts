// /ai-news/feed.xml: the daily AI news briefings as RSS 2.0, newest first, the
// last 14 days. Stephen, 2026-09-25, for Google News: since March 2025 Google
// builds a publication from what it crawls, and a feed per news section is one
// of the signals it reads. Built from content/news/news.json (today) and
// content/news/archive.json (everything before) on every build. The link is
// the story's uid address, which never changes; the guid is the uid.
import { readFileSync, existsSync } from 'node:fs';
import { storyUid, cleanSummary } from '../../lib/storyUid';

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const load = (p: string) => { try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; } catch { return null; } };

export function collectStories(days = 14) {
  const news = load('content/news/news.json');
  const archive = load('content/news/archive.json');
  const seen = new Set<string>();
  const out: Array<{ uid: string; title: string; summary: string; date: string }> = [];
  const cutoff = Date.now() - days * 86400000;
  const push = (s: any, date: string) => {
    const slug = s.Slug ?? s.slug;
    if (!slug || seen.has(slug)) return;
    seen.add(slug);
    const d = String(date ?? '').slice(0, 10);
    if (!d || isNaN(new Date(d).getTime()) || new Date(d).getTime() < cutoff) return;
    out.push({ uid: storyUid(slug, s.uid), title: String(s.Headline ?? s.headline ?? ''), summary: cleanSummary(s.Summary ?? s.summary ?? ''), date: d });
  };
  for (const s of news?.stories ?? []) push(s, news.date);
  for (const s of archive?.stories ?? []) push(s, s.ArchivedDate ?? s.published_on ?? archive?.date);
  out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return out.filter((s) => s.uid && s.title);
}

export async function GET() {
  const items = collectStories(14).map((s) => `    <item>
      <title>${esc(s.title)}</title>
      <link>https://theworldofai.org/ai-news/${s.uid}/</link>
      <guid isPermaLink="true">https://theworldofai.org/ai-news/${s.uid}/</guid>
      <pubDate>${new Date(s.date + 'T12:00:00Z').toUTCString()}</pubDate>
      <description>${esc(s.summary)}</description>
    </item>`).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>The World of AI, daily AI news</title>
    <link>https://theworldofai.org/ai-news/</link>
    <atom:link href="https://theworldofai.org/ai-news/feed.xml" rel="self" type="application/rss+xml" />
    <description>Each day's top AI stories, ranked by how many outlets covered them, with every source linked. Compiled by The World of AI, edited by Stephen Jordan.</description>
    <language>en-us</language>
${items}
  </channel>
</rss>
`;
  return new Response(xml, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
}
