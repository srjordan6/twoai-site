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
        if (c?.uid) add(c.name, `/companies/${c.uid}/`);
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

  return known;
}

export function resolveEntity(name: string, known: Map<string, KnownEntity>): KnownEntity | null {
  const key = normEntity(name);
  return known.get(key) ?? known.get(key.replace(/ /g, '')) ?? null;
}

/**
 * Resolve a list of raw names, dedupe by destination page (the extractor often
 * yields "Google" and "Google LLC" in one story), and cap.
 */
export function resolveEntities(names: string[], known: Map<string, KnownEntity>, n = 8): KnownEntity[] {
  const out: KnownEntity[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const hit = resolveEntity(raw, known);
    if (!hit || seen.has(hit.href)) continue;
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
