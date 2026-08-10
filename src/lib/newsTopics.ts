// Shared helpers for the daily AI briefing pages. Ported from the
// srjconsultingservices.com implementation so both sites read the same
// news.json artifact identically.
//
// WHAT IS DERIVED AND WHAT IS NOT, because it governs everything here.
//
// news.json carries only what the pipeline can observe: a headline, how many
// outlets and articles covered it, which domains, which people and organisations
// were named, and the source articles. It carries no topic label, no analysis,
// no market data, and no forward schedule.
//
// So this module derives only what that supports, deterministically, and never
// invents the rest. Categorisation is an explicit keyword map, not a model: it
// is auditable, it fails to a neutral bucket, and anyone can read it and see
// exactly why a story landed where it did. That is the tradeoff taken over an
// LLM classifier, which would be more accurate and completely unauditable.
//
// Two rules learned by testing this against real data:
//   1. Match the HEADLINE ONLY, never the organisation list. "Pew Research
//      Center" appearing as an org made a Chinese diplomacy story a research
//      story. Entity names are full of topic words and are not topic signals.
//   2. Match on word boundaries. Unanchored substrings put "ai" inside "said"
//      and "ban" inside "urban".
//
// Anything the data cannot support is left as an empty slot that renders when
// real data arrives, rather than being filled with something plausible.

export type Story = {
  Slug: string;
  Headline: string;
  ArticleCount: number;
  DomainCount: number;
  Domains: string[];
  Persons: string[];
  Orgs: string[];
  Articles: { Title: string; URL: string; Domain: string; Date: string }[];
  Why?: string | null;
  Summary?: string | null;
  SummaryURL?: string | null;
  SummaryDomain?: string | null;
};

// Order matters: the first category with a hit wins, so the more specific
// buckets come before the broader ones.
const CATEGORIES: { name: string; slug: string; blurb: string; patterns: string[] }[] = [
  {
    name: 'Policy & Regulation',
    slug: 'policy',
    blurb: 'Legislation, regulators, enforcement, and government AI programmes.',
    patterns: [
      String.raw`regulat\w*`, String.raw`legislat\w*`, 'congress', 'senate', 'parliament',
      'lawsuit', 'court', 'ruling', 'antitrust', 'ftc', 'doj', String.raw`polic(y|ies)`,
      'ban', 'bill', 'compliance', String.raw`govern\w*`, 'privacy', 'white house',
      'executive order', String.raw`sanction\w*`, String.raw`tariff\w*`, 'export control',
      'beijing', 'minister', String.raw`centre\S*`,
    ],
  },
  {
    name: 'Security & Risk',
    slug: 'security',
    blurb: 'Breaches, model risk, safety incidents, and misuse.',
    patterns: [
      String.raw`breach\w*`, String.raw`hack\w*`, String.raw`cyber\w*`, 'ransomware',
      String.raw`vulnerab\w*`, String.raw`exploit\w*`, 'malware', String.raw`deepfake\w*`,
      'fraud', String.raw`scam\w*`, 'safety', 'misuse', 'jailbreak', 'phishing',
      'surveillance', 'espionage', String.raw`leak\w*`, 'trust',
    ],
  },
  {
    name: 'Business & Finance',
    slug: 'business',
    blurb: 'Funding, earnings, deals, hiring, and market movement.',
    patterns: [
      'funding', 'raise', 'valuation', 'ipo', 'acquisition', String.raw`acquires?`, 'merger',
      'earnings', 'revenue', String.raw`profits?`, String.raw`invest\w*`, String.raw`stocks?`,
      'shares', 'billion', 'million', 'hire', 'hiring', String.raw`layoffs?`, 'job cuts',
      'partnership', String.raw`deals?`, String.raw`contracts?`, 'enterprise',
      String.raw`startups?`, 'venture', 'growth', 'market',
    ],
  },
  {
    name: 'Research & Models',
    slug: 'research',
    blurb: 'New models, benchmarks, papers, and technical capability.',
    patterns: [
      String.raw`models?`, 'llm', 'gpt', 'claude', 'gemini', 'llama', String.raw`benchmarks?`,
      String.raw`papers?`, 'research', 'training', String.raw`datasets?`,
      String.raw`open.source`, String.raw`agents?`, 'multimodal', 'reasoning', 'inference',
      'breakthrough', String.raw`launch\w*`, String.raw`releases?`, String.raw`chips?`, 'gpu',
      'compute', 'singularity', String.raw`experts?`,
    ],
  },
  {
    name: 'Society & Workforce',
    slug: 'society',
    blurb: 'Labour, education, healthcare, and public reaction.',
    patterns: [
      String.raw`workers?`, String.raw`employees?`, String.raw`unions?`, 'education',
      String.raw`students?`, String.raw`schools?`, String.raw`teachers?`,
      String.raw`health\w*`, String.raw`patients?`, String.raw`doctors?`, 'clinical',
      String.raw`hospitals?`, 'poll', 'survey', String.raw`ethic\w*`, 'bias',
      String.raw`discriminat\w*`, String.raw`artists?`, 'copyright', String.raw`creators?`,
      String.raw`journalis\w*`, String.raw`democrats?`, String.raw`republicans?`, 'party',
    ],
  },
];

const FALLBACK = {
  name: 'General AI',
  slug: 'general',
  blurb: 'Stories that span categories or sit outside them.',
};

export function categoryOf(s: Story): { name: string; slug: string } {
  const hay = (s.Headline || '').toLowerCase();
  for (const c of CATEGORIES) {
    if (c.patterns.some((p) => new RegExp(`\\b${p}\\b`).test(hay))) {
      return { name: c.name, slug: c.slug };
    }
  }
  return { name: FALLBACK.name, slug: FALLBACK.slug };
}

export function groupByCategory(stories: Story[]) {
  const order = [
    ...CATEGORIES.map((c) => ({ name: c.name, slug: c.slug, blurb: c.blurb })),
    FALLBACK,
  ];
  return order
    .map((c) => ({ ...c, stories: stories.filter((s) => categoryOf(s).slug === c.slug) }))
    .filter((c) => c.stories.length > 0);
}

/**
 * Reading time from the words actually on the page, at 230 wpm, the usual
 * figure for scanning news rather than reading prose. Never below one minute.
 */
export function readingMinutes(...blocks: string[]): number {
  const words = blocks.join(' ').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 230));
}

export const titleCase = (x: string) =>
  (x || '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Header pills. These are the organisations and people the day's coverage
 * actually named, ranked by how many separate stories mention them. They are
 * ENTITIES, not editorial topics, and the UI labels them that way.
 */
export function topEntities(stories: Story[], n = 8): string[] {
  const count = new Map<string, number>();
  for (const s of stories) {
    for (const o of new Set([...(s.Orgs ?? []), ...(s.Persons ?? [])])) {
      count.set(o, (count.get(o) ?? 0) + 1);
    }
  }
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([k]) => titleCase(k));
}

/**
 * Coverage timeline, grouped by DAY rather than by hour.
 *
 * The structure this page follows asks for intraday timestamps. GDELT carries
 * them, but the pipeline stores only the date, so hour-level grouping would
 * mean inventing times. Day-level is what the data supports, and the page says
 * so rather than implying a precision it does not have. Storing the full
 * timestamp is a pipeline change, tracked separately.
 */
export function coverageByDay(articles: Story['Articles']) {
  const byDay = new Map<string, Story['Articles']>();
  for (const a of articles ?? []) {
    const d = a.Date || 'undated';
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d)!.push(a);
  }
  return [...byDay.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([day, arts]) => ({
      day,
      count: arts.length,
      outlets: new Set(arts.map((a) => a.Domain)).size,
      articles: arts,
    }));
}

/**
 * A factual summary paragraph of the day's leading stories.
 *
 * Assembled from counts and headlines, not written. It states what was most
 * covered and by how many outlets, which the data supports. It deliberately
 * does NOT characterise significance, because nothing in news.json measures
 * significance, and a sentence that sounded like analysis would be fabrication
 * dressed up as a summary.
 */
export function summaryParagraph(stories: Story[], topN = 5): string {
  const top = stories.slice(0, topN);
  if (top.length === 0) return '';
  const outlets = new Set(stories.flatMap((s) => s.Domains ?? [])).size;
  const articles = stories.reduce((n, s) => n + (s.ArticleCount ?? 0), 0);
  const [lead, ...rest] = top;
  const restText = rest
    .map((s, i) => `${rest.length > 1 && i === rest.length - 1 ? 'and ' : ''}\u201C${s.Headline}\u201D (${s.DomainCount} outlets)`)
    .join(', ');
  return (
    `Today's briefing tracks ${stories.length} ${stories.length === 1 ? 'story' : 'stories'} ` +
    `drawn from ${articles} articles across ${outlets} outlets worldwide. The most widely ` +
    `covered is \u201C${lead.Headline}\u201D, carried by ${lead.DomainCount} separate outlets across ` +
    `${lead.ArticleCount} articles.` +
    (rest.length ? ` Also prominent: ${restText}.` : '') +
    ` Stories rank by how many independent outlets carried them, which measures how far a ` +
    `story travelled rather than how much it matters.`
  );
}
