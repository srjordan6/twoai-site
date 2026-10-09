// /this-week-in-ai/feed.xml: the week's AI news as RSS 2.0, newest week
// first (Stephen, 2026-10-09). The weekly policy digest's feed moved to
// /this-week-in-ai-laws/feed.xml with the digest.
import { loadNewsWeeks } from '../../lib/newsWeeks';

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function GET() {
  const items = loadNewsWeeks().slice(0, 12).map((w) => {
    const top = w.stories.slice(0, 3).map((s) => s.title).join('; ');
    const summary = `${w.start} to ${w.end}: ${w.counts.stories} headline stories, ${w.counts.vendor} vendor announcements, ${w.counts.incidents} AI incidents.${top ? ` Top stories: ${top}.` : ''}`;
    return `    <item>
      <title>${esc(`This Week in AI: ${w.label}`)}</title>
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
    <description>The week in AI news: the top headline stories, vendor announcements and AI incidents, chosen by traffic and importance. Edited by Stephen Jordan.</description>
    <language>en-us</language>
${items}
  </channel>
</rss>`;
  return new Response(xml, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
}
