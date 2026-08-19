/**
 * Onward-link helpers, shared by every page type.
 *
 * WHY THIS IS CENTRAL AND NOT COPIED PER PAGE. Ten page types each need "what
 * else on this site relates to what you are reading", and the matching rule is
 * the part that is easy to get dangerously wrong. Written once, it can be
 * reasoned about once. Copied ten times, one copy quietly loosens and starts
 * inventing relationships.
 *
 * THE MATCHING RULE. Glossary terms match on WHOLE WORDS, case-insensitive,
 * four characters minimum, longest first, and a term already contained inside
 * a longer match is dropped so "Agent Swarm" does not drag "Agent" in beside
 * it. A substring test finds "Agent" inside "agentic", "RAG" inside "storage"
 * and "Box" inside "toolbox" - which is precisely how 101 false MCP
 * attributions reached production on 2026-08-18.
 *
 * Text matching inside our own prose is a weaker claim than attributing a
 * product to a company: the worst case here is an unhelpful link, not a false
 * statement of fact. The bar is therefore lower than the MCP rule, but the word
 * boundary is not optional.
 *
 * Companies match on exact normalised equality only, the same rule as
 * src/lib/mcpAttribution.ts, because a company link IS a claim about identity.
 *
 * Everything is loaded once per build and cached on globalThis; the content
 * files are read from disk on every page otherwise, and there are 5,800 pages.
 */
import { readFileSync, existsSync } from 'node:fs';

export interface Term { slug: string; term: string; category?: string }
export interface CompanyRef { uid: string; name: string; has_page?: boolean }

// Coerced rather than trusted: these helpers are called from ten templates with
// data of ten different shapes, and a non-string reaching toLowerCase took down
// a whole build once. A helper used everywhere must not assume its caller.
const flatten = (s: unknown): string =>
  (typeof s === 'string' ? s : s == null ? '' : String(s)).toLowerCase().replace(/[^a-z0-9]/g, '');

function load(path: string): any {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  } catch {
    return null;
  }
}

interface Cache {
  terms: Term[];
  companiesByName: Record<string, CompanyRef>;
  vendorArchive: any[];
}

function cache(): Cache {
  const g = globalThis as any;
  if (!g.__twoaiRelated) {
    const gloss = load('content/glossary/glossary.json');
    const comps = load('content/companies/index.json');
    const vend = load('content/news/vendor.json');
    const companiesByName: Record<string, CompanyRef> = {};
    for (const c of comps?.companies ?? []) {
      if (c?.name && c?.uid) companiesByName[flatten(c.name)] = c;
    }
    g.__twoaiRelated = {
      // Longest first so the most specific term wins a contested span.
      terms: (gloss?.terms ?? [])
        .filter((t: any) => t?.term && t?.slug && String(t.term).length >= 4)
        .sort((a: any, b: any) => String(b.term).length - String(a.term).length),
      companiesByName,
      vendorArchive: vend?.archive ?? [],
    } as Cache;
  }
  return g.__twoaiRelated as Cache;
}

/** Glossary terms genuinely named in the given text. */
export function matchTerms(text: unknown, limit = 4): Term[] {
  const hay = (typeof text === 'string' ? text : text == null ? '' : String(text)).toLowerCase();
  if (hay.length < 8) return [];
  const out: Term[] = [];
  const taken: string[] = [];
  for (const t of cache().terms) {
    if (out.length >= limit) break;
    const word = String(t.term).toLowerCase().replace(/\s*\(.*?\)\s*/g, '').trim();
    if (word.length < 4) continue;
    const re = new RegExp(`(^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
    if (!re.test(hay)) continue;
    if (taken.some((u) => u.includes(word))) continue;
    taken.push(word);
    out.push(t);
  }
  return out;
}

/** The company page for a name, only on exact normalised equality. */
export function companyFor(name: unknown): CompanyRef | null {
  if (!name) return null;
  const c = cache().companiesByName[flatten(name)];
  return c && c.has_page !== false ? c : null;
}

/** Other vendor posts by the same vendor that actually have a page. */
export function moreFromVendor(vendor: string, excludeSlug = '', limit = 5): any[] {
  return cache().vendorArchive
    .filter((a: any) => a?.vendor === vendor && a.slug && a.slug !== excludeSlug && a.has_page !== false)
    .slice(0, limit);
}

/** Vendor posts that name a company, for company and tool pages. */
export function vendorPostsNaming(name: string, limit = 5): any[] {
  if (!name) return [];
  const flat = flatten(name);
  return cache().vendorArchive
    .filter((a: any) => a?.slug && a.has_page !== false && flatten(a.vendor || '') === flat)
    .slice(0, limit);
}

/**
 * Companies genuinely named in a piece of text, linked to their profiles.
 *
 * WHY THIS EXISTS. Searching the site for "OpenAI" returns over a thousand
 * pages, and 175 of them named OpenAI in the body without linking to its
 * profile: lawsuit pages, glossary entries, weekly digests, benchmark pages.
 * A reader who arrives on any of those has no way to reach what we actually
 * hold on the company they came to read about.
 *
 * THE RULE, and it is stricter than the glossary matcher on purpose. A
 * glossary mis-match costs an unhelpful link; naming the wrong company is a
 * claim about identity. So:
 *   - whole words only, never substrings
 *   - four characters minimum, which alone rules out "Box" matching "toolbox"
 *   - CASE SENSITIVE, so "Meta" the company matches but "meta tag" does not,
 *     "Scale" matches but "scale up" does not, and "Character" matches but
 *     "character limit" does not. Company names appear capitalised in prose;
 *     the ordinary English words they collide with do not.
 *   - the page's own subject is excluded, so a company page does not link to
 *     itself and a vendor post does not repeat the vendor it already shows
 *
 * Capped low deliberately. Five links a reader might follow beat forty they
 * will scroll past, and a wall of company names reads as an index rather than
 * a recommendation.
 */
export function companiesNamedIn(text: unknown, opts: { limit?: number; exclude?: string } = {}): CompanyRef[] {
  const hay = typeof text === 'string' ? text : text == null ? '' : String(text);
  if (hay.length < 20) return [];
  const limit = opts.limit ?? 5;
  const skip = flatten(opts.exclude ?? '');
  const out: CompanyRef[] = [];
  const seen = new Set<string>();
  // Longest name first, so "Stability AI" is preferred over a bare "Stability".
  const all = Object.values(cache().companiesByName)
    .filter((c) => c.name && c.name.length >= 4 && c.has_page !== false)
    .sort((a, b) => b.name.length - a.name.length);
  for (const c of all) {
    if (out.length >= limit) break;
    const key = flatten(c.name);
    if (!key || key === skip || seen.has(key)) continue;
    const esc = c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // No `i` flag: the case sensitivity is the guard.
    if (!new RegExp(`(^|[^A-Za-z0-9])${esc}([^A-Za-z0-9]|$)`).test(hay)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
