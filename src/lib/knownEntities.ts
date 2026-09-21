/**
 * Resolve news-extracted entity names against the entities this site actually
 * publishes, so a highlighted chip is always a link to a page we own.
 *
 * WHY THIS EXISTS. The news stories carry Orgs and Persons lifted by GDELT's
 * entity extractor from the source article. That extractor is indiscriminate:
 * across 5,025 stories it produced 1,040 distinct "entities", of which twelve
 * were organisations or people this site has a page for. The rest were
 * fragments ("Exchange Commission", "Australian Associated"), generic phrases
 * ("information technology", "terms of service", "application development"),
 * places ("United States"), and untranslated German ("richtung allzeithoch").
 * Rendering those as highlighted chips told a reader nothing and implied the
 * site knew something about each one.
 *
 * The rule now: a chip appears only when the name resolves to a company or
 * person in SQL that has a published page, and it renders as a link to that
 * page. Anything unresolved is dropped rather than shown as dead text. When
 * nothing resolves, the whole chip row is omitted; an empty row is better than
 * a row of noise.
 *
 * Unresolved names are not discarded silently. Build logs the most-mentioned
 * ones so an entity worth publishing can be added to SQL and start resolving
 * on the next run. That is the intended growth path: the chips get richer as
 * the site's own entity coverage grows, never by loosening the match.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';

export interface KnownEntity {
  label: string;
  href: string;
}

/**
 * Normalize for comparison only, never for display. Strips punctuation, the
 * corporate suffixes that differ between how a newswire and a filing name the
 * same company, and collapses whitespace. "Palantir Technologies Inc" and
 * "Palantir" both reduce to "palantir".
 */
export function normEntity(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(the|inc|corp|corporation|llc|ltd|limited|plc|pbc|co|sa|ag|gmbh|nv|bv|pvt|holdings|group|technologies|solutions)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build the lookup from the content bundle. Two keys per entity: the
 * normalized name, and the same with spaces removed, because the extractor
 * emits "OPENAI" and "Open AI" for the same organisation and only the second
 * key catches the split form.
 */
export function loadKnownEntities(): Map<string, KnownEntity> {
  const known = new Map<string, KnownEntity>();

  const add = (name: string | undefined, href: string) => {
    if (!name) return;
    const key = normEntity(name);
    // A one-character key matches far too much; skip rather than poison.
    if (key.length < 2) return;
    if (!known.has(key)) known.set(key, { label: name, href });
    const tight = key.replace(/ /g, '');
    if (tight !== key && !known.has(tight)) known.set(tight, { label: name, href });
  };

  if (existsSync('content/companies')) {
    for (const f of readdirSync('content/companies')) {
      if (!f.endsWith('.json') || f === 'index.json') continue;
      try {
        const c = JSON.parse(readFileSync(`content/companies/${f}`, 'utf8'))?.company;
        if (c?.uid) {
          add(c.name, `/companies/${c.uid}/`);
          // ALIASES, because a newswire names the model and not the lab.
          // Stephen, 2026-09-15, on a story about China closing the gap:
          // it should list Moonshot AI, DeepSeek and Z.ai. Six of those labs
          // already had pages. They did not chip because the article says
          // Kimi, GLM and Qwen, and nothing mapped a model back to the
          // company that makes it.
          for (const a of (Array.isArray(c.aliases) ? c.aliases : [])) {
            add(a, `/companies/${c.uid}/`);
          }
        }
      } catch { /* a malformed file fails the build in its own route, not here */ }
    }
  }

  if (existsSync('content/people')) {
    for (const f of readdirSync('content/people')) {
      if (!f.endsWith('.json') || f === 'index.json') continue;
      try {
        const p = JSON.parse(readFileSync(`content/people/${f}`, 'utf8'));
        if (p?.uid) add(p.name, `/ai-ecosystem/ecosystem-entities-market-and-operations/${p.uid}/`);
      } catch { /* as above */ }
    }
  }

  // Data-centre operators and named facilities. A story that names HyperVault
  // or Equinix LA7 should link to the registry page, not only to a parent
  // company. Operator docs are tech/dc-op-*.json; facility docs are the rest
  // of tech/ with shape dc-facility. Facility names are long and specific
  // ("QTS Phoenix 1 (PHX1, Van Buren)"), so exact-name matching is safe;
  // operator names are short and are added with their aliases where the doc
  // carries them. Stephen, 2026-09-06.
  if (existsSync('content/tech')) {
    for (const f of readdirSync('content/tech')) {
      if (!f.endsWith('.json')) continue;
      try {
        const d = JSON.parse(readFileSync(`content/tech/${f}`, 'utf8'));
        if (!d?.uid) continue;
        const href = `/ai-ecosystem/technology-and-core-infrastructure/${d.uid}/`;
        if (d.shape === 'dc-operator') {
          add(d.name, href);
          for (const a of (Array.isArray(d.aliases) ? d.aliases : [])) add(a, href);
        } else if (d.shape === 'dc-facility' && d.name && d.name.length >= 12) {
          add(d.name, href);
        }
      } catch { /* as above */ }
    }
  }

  return known;
}

export function resolveEntity(name: string, known: Map<string, KnownEntity>): KnownEntity | null {
  const key = normEntity(name);
  return known.get(key) ?? known.get(key.replace(/ /g, '')) ?? null;
}

/**
 * COMPANY NAMES THAT ARE ALSO ORDINARY WORDS. 2026-09-21: the story on
 * Newsom's AI "kill switch" order chipped Switch, the data centre operator,
 * because the headline contains the word switch. Every name here is a
 * published company whose name is a common English word, a place, or a first
 * name, taken from the single-word company names in SQL on that date. Such a
 * name never chips from the text scan, and from the extractor list only when
 * the extractor gave more than the bare word ("Switch Inc", "Zoom Video").
 * Losing an occasional true chip is the right trade: a wrong one tells the
 * reader the site knows something it does not. Add to this list when a new
 * company with a dictionary name is published.
 */
const AMBIGUOUS = new Set([
  'altered', 'arm', 'box', 'captions', 'chroma', 'cognition', 'comet', 'consensus',
  'elicit', 'ellis', 'fathom', 'gamma', 'glean', 'grain', 'harvey', 'headliner',
  'loom', 'make', 'mila', 'modular', 'munch', 'neptune', 'obsidian', 'paradox',
  'perplexity', 'phrase', 'pitch', 'read', 'repurpose', 'rev', 'runway', 'saul',
  'sierra', 'sketch', 'splice', 'surfer', 'switch', 'tempus', 'tome', 'typeface',
  'writer', 'zoom',
]);

/**
 * Resolve a list of raw names, dedupe by destination page (the extractor often
 * yields "Google" and "Google LLC" in one story), and cap.
 */
export function resolveEntities(names: string[], known: Map<string, KnownEntity>, n = 8): KnownEntity[] {
  const out: KnownEntity[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const bare = (raw || '').trim().toLowerCase();
    if (AMBIGUOUS.has(bare)) continue;
    const hit = resolveEntity(raw, known);
    if (!hit || seen.has(hit.href)) continue;
    seen.add(hit.href);
    out.push(hit);
    if (out.length >= n) break;
  }
  return out;
}

/**
 * Find entities NAMED IN THE TEXT that the extractor missed.
 *
 * GDELT's list is the only input resolveEntities has, and on a story about
 * Chinese labs closing the gap it produced Trump, two officials and a news
 * photographer while never naming Moonshot AI, DeepSeek or Z.ai, which were
 * the subject. The extractor is tuned for people and institutions, not for
 * model families.
 *
 * So the headline and summary are scanned directly for names this site
 * publishes. Only keys of four characters or more, only whole words, and only
 * entities already in the known map, so this cannot invent a chip: it can
 * only find one the extractor overlooked.
 */
export function entitiesInText(text: string, known: Map<string, KnownEntity>, n = 6): KnownEntity[] {
  const hay = ' ' + normEntity(text) + ' ';
  const out: KnownEntity[] = [];
  const seen = new Set<string>();
  // Longest keys first, so a two-word lab name is not shadowed by one word of
  // it matching something shorter.
  const keys = [...known.keys()]
    .filter((k) => k.length >= 4 && !AMBIGUOUS.has(k))
    .sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (!hay.includes(' ' + k + ' ')) continue;
    const hit = known.get(k)!;
    if (seen.has(hit.href)) continue;
    seen.add(hit.href);
    out.push(hit);
    if (out.length >= n) break;
  }
  return out;
}

/**
 * Log the most-mentioned names that did not resolve, so the gap is visible in
 * every build rather than being something someone has to go looking for. This
 * is the queue for "should this be in SQL?", and it is the only sanctioned way
 * the chip list grows.
 */
export function reportUnresolved(counts: Map<string, number>, known: Map<string, KnownEntity>, top = 12): void {
  const missing = [...counts.entries()]
    .filter(([name]) => !resolveEntity(name, known))
    .sort((a, b) => b[1] - a[1])
    .slice(0, top);
  if (missing.length === 0) return;
  console.log(
    `news entities: ${missing.length} unresolved candidates (add to SQL to surface them): ` +
      missing.map(([name, c]) => `${name} (${c})`).join(', ')
  );
}
