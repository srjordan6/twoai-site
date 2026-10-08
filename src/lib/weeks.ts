/**
 * The weekly digest, read the same way on every page that uses it.
 *
 * Three things live here because three pages need them to agree: the hub,
 * each week, and each subject page. The counts on one must be the counts on
 * the others, and a bill that one page shows must be the bill the others
 * link to. So every page loads the week files through loadWeeks(), which
 * applies the same relevance gate, the same description clean-up and the
 * same subject classification, and nothing is computed twice in two ways.
 *
 * Why the gate is here as well as in the pipeline (Stephen, 2026-10-08,
 * "that looks terrible"): the corpus is keyword-matched at ingest, so a week
 * file held the Budget Act, a Golden Gate Bridge district bill and the Ohio
 * UCC revision beside the AI bills. The pipeline now drops them before the
 * file is written; this copy of the rule keeps the weeks already published
 * clean until the next pipeline run rewrites them, and stays as a second
 * line afterwards.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';

export interface WeekItem {
  state?: string;
  number?: string;
  title: string;
  url: string;
  date: string;
  note?: string;
  slug?: string;
  detail?: string;
  agency?: string;
  themes?: string[];
  anchor?: string;
}

export interface Week {
  slug: string;
  label: string;
  start: string;
  end: string;
  generated?: string;
  recap?: string;
  reading?: any;
  bills: WeekItem[];
  federal: WeekItem[];
  courts: WeekItem[];
  [k: string]: any;
}

// The subjects, with the pipeline's own blurbs. The names must match the
// pipeline's twoaiThemeRules exactly, because the items carry them by name.
export const THEME_BLURBS: Record<string, string> = {
  'Deepfakes and likeness': 'Synthetic images, voices, and video of real people, and who owns a likeness once a machine can copy it.',
  'Elections': 'AI-generated political content, disclosure on campaign material, and interference with voting.',
  'Children and minors': 'Companion chatbots, age verification, school use, and protections for people under eighteen.',
  'Health care': 'Clinical decision support, utilization review, mental health chatbots, and AI in diagnosis or coverage decisions.',
  'Employment and hiring': 'Automated screening of applicants, workplace surveillance, and decisions about pay or promotion.',
  'Government use': 'How agencies themselves buy, deploy, and account for AI, including inventories and procurement rules.',
  'Transparency and disclosure': 'Labeling AI-generated output, telling people when they are talking to a machine, and impact assessments.',
  'Consumer protection and discrimination': 'Algorithmic decisions that affect credit, housing, insurance pricing, or that produce unlawful bias.',
  'Privacy and data': 'Biometrics, training data, and what may be collected or fed into a model.',
  'Criminal law': 'New offenses, penalties, and evidence rules for conduct carried out with AI.',
  'Safety and frontier models': 'Obligations aimed at the most capable systems, including testing, incident reporting, and catastrophic risk.',
  'Infrastructure and energy': 'Data centers, the power they draw, and the local cost of hosting them.',
  'Workforce and education': 'Training people to use AI, apprenticeships, curriculum, and public literacy programs.',
  'Intellectual property': 'Copyright, authorship, and the use of protected work to build models.',
};

export function themeSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function themeFromSlug(slug: string): string | undefined {
  return Object.keys(THEME_BLURBS).find((n) => themeSlug(n) === slug);
}

// The relevance gate, a port of the pipeline's twoaiBillRelevant plus its
// privacy vocabulary. A bill passes on AI or privacy subject matter in its
// title or description; an appropriations vehicle never does.
const AI_RE = /(artificial intelligence|\bAI\b|algorithmic|automated decision|automated employment|machine learning|deepfake|synthetic media|generative|chatbot|companion chatbot|digital replica|conversational artificial)/i;
const EXCLUDE_RE = /(general appropriation|budget technical correction|omnibus appropriation|supplemental appropriation|making appropriations)/i;
const PRIVACY_RE = /\b(privacy (?:act|law|laws|bill|rule|rules|regulation|rights?|protection|legislation)|data (?:privacy|protection|broker|brokers|minimization|minimisation)|consumer privacy|invasion of privacy|right to privacy|personal (?:data|information) protection|biometric (?:privacy|data|information|identifiers?)|age.appropriate design|kids code|children's (?:privacy|online)|ccpa|cpra|gdpr|coppa|bipa|hipaa privacy|wiretap(?:ping)? (?:act|law|statute)|website tracking|online tracking|tracking (?:pixels?|cookies)|surveillance (?:law|advertising|pricing)|opt.out (?:rights?|preference)|do not (?:sell|track)|geolocation (?:data|privacy)|privacy commissioner|data protection (?:authority|officer))\b/i;

export function billRelevant(title: string, detail: string): boolean {
  const blob = `${title || ''} ${detail || ''}`;
  if (EXCLUDE_RE.test(blob)) return false;
  return AI_RE.test(blob) || PRIVACY_RE.test(blob);
}

// The description clean-up, a port of the pipeline's twoaiBillDetail. Ohio
// opens every description with the list of sections it amends; Michigan
// closes with the sections and a tie bar. Those go; the legislature's own
// words stay, capped at a sentence boundary.
const AMEND_RE = /^to (?:amend|enact|repeal|create)\b[\s\S]*\bof the revised code\b[,;.]?\s*(?:and\s+)?(?:to\s+)?/i;
const SECT_RE = /\s*(?:\b(?:amends?|adds?|repeals?)\s+(?:title\s+&\s+)?secs?\.[\s\S]*|\bTIE BAR WITH:[\s\S]*)$/i;

export function tidyBillTitle(s: string): string {
  return String(s || '').replace(SECT_RE, '').trim();
}

export function tidyBillDetail(s: string): string {
  let t = String(s || '').trim();
  const m = AMEND_RE.exec(t);
  if (m) t = t.slice(m[0].length).trim();
  t = t.replace(SECT_RE, '').trim();
  if (!t) return '';
  t = t[0].toUpperCase() + t.slice(1);
  const MAX = 420;
  if (t.length > MAX) {
    let cut = t.slice(0, MAX);
    const i = Math.max(cut.lastIndexOf('.'), cut.lastIndexOf(';'));
    if (i > 120) cut = cut.slice(0, i + 1);
    else {
      const j = cut.lastIndexOf(' ');
      cut = (j > 0 ? cut.slice(0, j) : cut) + '…';
    }
    t = cut;
  }
  return t;
}

export function billAnchor(b: WeekItem): string {
  return `${b.state || ''}-${b.number || ''}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function clean(w: any): Week {
  const bills: WeekItem[] = [];
  for (const b of w.bills || []) {
    const title = tidyBillTitle(b.title);
    const raw = String(b.detail || '');
    if (!billRelevant(title, raw)) continue;
    let detail = tidyBillDetail(raw);
    if (detail && detail.toLowerCase() === title.toLowerCase()) detail = '';
    bills.push({ ...b, title, detail, anchor: billAnchor({ ...b, title }) });
  }
  const federal: WeekItem[] = (w.federal || []).map((f: any, i: number) => ({ ...f, anchor: `fr-${i + 1}` }));
  const courts: WeekItem[] = (w.courts || []).map((c: any, i: number) => ({ ...c, anchor: `court-${i + 1}` }));
  return { ...w, bills, federal, courts };
}

let cache: Week[] | null = null;

/** Every week file, newest first, with the gate and the clean-up applied. */
export function loadWeeks(): Week[] {
  if (cache) return cache;
  if (!existsSync('content/week')) return (cache = []);
  const out: Week[] = [];
  for (const f of readdirSync('content/week')) {
    if (!f.endsWith('.json') || f === 'index.json') continue;
    try {
      const w = JSON.parse(readFileSync(`content/week/${f}`, 'utf8'));
      if (!w.slug) w.slug = f.replace(/\.json$/, '');
      out.push(clean(w));
    } catch {
      /* a malformed week file is skipped, not fatal */
    }
  }
  out.sort((a, b) => (b.slug || '').localeCompare(a.slug || ''));
  return (cache = out);
}

export interface ThemeRow {
  name: string;
  slug: string;
  blurb: string;
  count: number;
  example?: string;
  bills: WeekItem[];
  federal: WeekItem[];
}

/** Subjects across the given weeks, most items first. */
export function themeRows(weeks: Week[]): ThemeRow[] {
  const m = new Map<string, ThemeRow>();
  const row = (name: string) => {
    let r = m.get(name);
    if (!r) {
      r = { name, slug: themeSlug(name), blurb: THEME_BLURBS[name] || '', count: 0, bills: [], federal: [] };
      m.set(name, r);
    }
    return r;
  };
  for (const w of weeks) {
    for (const b of w.bills) for (const t of b.themes || []) { const r = row(t); r.count++; r.bills.push({ ...b, slug: b.slug, week: w.slug } as any); if (!r.example) r.example = `${b.state} ${b.number}`; }
    for (const f of w.federal) for (const t of f.themes || []) { const r = row(t); r.count++; r.federal.push({ ...f, week: w.slug } as any); }
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
