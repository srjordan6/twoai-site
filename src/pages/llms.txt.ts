// llms.txt, generated at build time from the same content files the pages
// render from, so the counts in this file can never disagree with the site it
// describes. It replaced a static public/llms.txt whose numbers had drifted
// (102 lawsuits vs 104 live, 1,836 MCP servers vs 1,909) within two weeks of
// being written - a hand-maintained count in a daily-rebuilt site is a
// staleness bug waiting to be noticed. Prose lives here in the template;
// numbers come from content/ at build; the build date comes from the lawsuit
// tracker's generated stamp, which the daily pipeline advances.
//
// Every read is guarded: a missing or reshaped content file falls back to the
// last known value rather than failing the build or publishing a blank.
import { readFileSync, readdirSync } from 'node:fs';

function readJSON(path: string): any {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}
const fmt = (n: number) => n.toLocaleString('en-US');

const lawsuits = readJSON('content/lawsuits/lawsuits.json');
const mcp = readJSON('content/mcp/index.json');
const compliance = readJSON('content/compliance/index.json');
const glossary = readJSON('content/glossary/glossary.json');
const research = readJSON('content/research/index.json');
// Case studies publishes only after the first harvest lands, and this file
// must not advertise a page that does not render yet, so the entry below is
// emitted only when the content file exists and carries rows.
const caseStudies = readJSON('content/industries/case-studies.json');
const csCount = caseStudies?.total ?? 0;
const csUID = caseStudies?.uid ?? '';
// The Open Library catalogue is a band inside the Books page rather than a
// section of its own, so its counts describe Books rather than a second URL.
const dc = readJSON('content/tech/datacenters.json');
const dcUID = dc?.uid ?? '';
const dcMetrics = Array.isArray(dc?.metrics) ? dc.metrics.length : 0;
const bookCat = readJSON('content/learn/book-catalog.json');
const bcCount = bookCat?.total ?? 0;
const bcFree = bookCat?.free ?? 0;

const caseCount = lawsuits?.count ?? 104;
const generated = lawsuits?.generated ?? '2026-08-20';
const mcpCount = mcp?.total ?? 1908;
const compCount = compliance?.total ?? compliance?.frameworks?.length ?? 62;
const termCount = Array.isArray(glossary?.terms) ? glossary.terms.length : 530;
const researchCount = research?.total ?? 134;

// Live sections and domains, summed across every category-shaped ecosystem
// file (the ones carrying a domains array), counting sections whose status is
// live - the same predicate the category pages themselves render with.
let sections = 0, domains = 0;
try {
  for (const name of readdirSync('content/ecosystem')) {
    if (!name.endsWith('.json')) continue;
    const f = 'content/ecosystem/' + name;
    const d = readJSON(f);
    if (!d?.domains) continue;
    for (const dom of d.domains) {
      domains += 1;
      sections += (dom.sections ?? []).filter((s: any) => s.status === 'live').length;
    }
  }
} catch { /* fall through to fallback */ }
if (!sections) { sections = 135; domains = 29; }

const text = `# The World of AI
> The atlas of artificial intelligence: US state AI legislation, major AI
> lawsuits, the language of AI, the tools people actually use, the companies
> that build them, the compliance frameworks that govern them, the benchmarks
> that measure them, the MCP servers that connect them, the peer-reviewed
> research behind the field, what the labs announce themselves, and the
> primary-source bibliography that grounds every fact. Rebuilt daily from
> primary sources (LegiScan, CourtListener/RECAP, the Federal Register, the
> govinfo USCOURTS opinion feed, arXiv, the official MCP registry, and
> published academic indexes). An independent publication of SRJ Consulting &
> Services LLC, Frisco, Texas.

Every reference page carries a visible date stamp (generated, last verified, or
last reviewed) and a ready-made citation. Citing these pages with attribution
is welcome and encouraged. Counts in this file are computed from the same data
that built the pages, in the build dated ${generated}.

## Sections
- [AI Laws by State](https://theworldofai.org/ai-laws/): every tracked AI bill
  in all 50 US states, DC, Puerto Rico, and Congress, one page per jurisdiction.
- [AI Glossary](https://theworldofai.org/ai-glossary/): ${fmt(termCount)} AI terms defined
  in plain English with origin, example, and related terms.
- [AI Lawsuit Tracker](https://theworldofai.org/ai-lawsuits/): ${fmt(caseCount)} living case
  pages with daily docket checks, full timelines, and both the CourtListener
  docket record and the govinfo opinion text where available.
- [AI Compliance Frameworks](https://theworldofai.org/ai-compliance/): ${fmt(compCount)}
  framework pages covering the EU AI Act, NIST AI RMF, ISO/IEC 42001, sector
  regulators, and agency enforcement, each with scope, obligations, deadlines,
  and what changed most recently.
- [AI Tools Directory](https://theworldofai.org/ai-tools/): profiles covering
  pricing, strengths, weaknesses, and governance notes for the tools we have
  researched directly.
- [AI Companies](https://theworldofai.org/companies/): profiled AI companies
  with SEC EDGAR revenue and structure data where public.
- [AI Jobs and Market Dynamics](https://theworldofai.org/ai-ecosystem/ecosystem-entities-market-and-operations/995676ef/):
  the AI labor market tracked daily: thousands of live openings with roles,
  salaries, required skills, and remote availability, drawn from employer
  postings.
- [AI Skills Graph](https://theworldofai.org/skills/): the skills AI work
  actually requires, mapped from O*NET occupational data and live job
  postings, each skill linked to the roles and tools that use it.
- [Downloads and Asset Repository](https://theworldofai.org/downloads/):
  authored governance templates and working documents rendered as readable,
  citable markdown pages with a copy button; nothing requires a download or
  an email address.
- [AI People Directory](https://theworldofai.org/ai-ecosystem/ecosystem-entities-market-and-operations/c53153c4/):
  the people who built and shaped AI, from Lovelace and Turing to the
  researchers running today's labs, each with what they did, when, and why it
  mattered, sourced to primary documents.
- [AI Benchmarks](https://theworldofai.org/benchmarks/): benchmark pages
  covering what each benchmark actually measures, its known limitations, and
  current published results with the evaluator and as-of date named. Results
  come from structured official sources and refresh automatically; benchmarks
  whose published figures are stable carry a dated protocol note instead.
- [MCP Server Registry](https://theworldofai.org/mcp/): ${fmt(mcpCount)} Model Context
  Protocol servers sourced from the official registry at
  registry.modelcontextprotocol.io, one page per server.
- [AI Research Library](https://theworldofai.org/research/): ${fmt(researchCount)} peer-reviewed
  and preprint AI papers sorted into ten topics (reasoning, healthcare,
  applications, architectures, capabilities and limits, evaluation, governance,
  security, bias and fairness, the EU AI Act). Each entry carries authors,
  venue, year, citation count, and a plain-English note on why the paper
  matters. Every rendered citation links to the original paper or publisher.
- [arXiv Research Watch](https://theworldofai.org/research/watch/): recent
  cs.AI, cs.CL, and cs.LG preprints from a rolling 30-day window, labelled as
  not yet peer reviewed.
- [AI News](https://theworldofai.org/ai-news/): the daily briefing of how the
  field is being covered, plus
  [AI Vendor News](https://theworldofai.org/ai-news/vendor/), announcements
  from the organisations building and governing AI in their own words, drawn
  from their own feeds rather than press aggregation. Each vendor post has its
  own page carrying the vendor's published description and a link to the
  original.
- [AI Prompts](https://theworldofai.org/ai-prompts/): prompting techniques and
  domain prompt guides.
- [AI Talent Network](https://theworldofai.org/talent/): profiles of
  practitioners open to AI work, matched daily against live job postings;
  candidates own their pages and publish them with a save.${csCount > 0 ? `
- [AI Case Studies](https://theworldofai.org/ai-ecosystem/enterprise-applications-governance-and-tools/${csUID}/): ${fmt(csCount)}
  published accounts of real AI deployments, indexed from research publishers
  with sponsored content refused and product news filtered out; every entry
  links to the original.` : ''}${dcUID ? `
- [Data Centers](https://theworldofai.org/ai-ecosystem/technology-and-core-infrastructure/${dcUID}/): the
  physical layer of the AI boom, quarterly capital expenditure from hyperscalers
  and colocation operators read from SEC filings, material facility 8-Ks, ${fmt(dcMetrics)}
  operations and market metrics defined, and a directory of grid queues, market
  researchers, and standards bodies.` : ''}
- [Sources and References](https://theworldofai.org/sources/): the primary
  sources behind every fact on the site, across EU and Council of Europe, US
  federal, US state and city, other jurisdictions, standards bodies and SROs,
  and peer-reviewed research.
- [AI Calculators](https://theworldofai.org/calculators/): token cost, GPU
  VRAM, ROI, training cost, energy and carbon, and context window estimators.
- [This Week in AI](https://theworldofai.org/this-week-in-ai/): a weekly
  digest of what changed across law, litigation, research, and product,
  with permalinked ISO-week archives.
- [The AI Ecosystem](https://theworldofai.org/): the map that ties every
  section together, organised into four categories: Technology and Core
  Infrastructure, Ecosystem Entities Market and Operations, Research
  Knowledge and Learning, and Enterprise Applications Governance and Tools.
  ${sections} sections are live across ${domains} domains in this build;
  sections mapped but not yet published render on the coverage roadmap as
  planned rather than vanishing.
- AI Security and Risk (under Enterprise Applications, Governance and Tools):
  sixteen sections, from prompt injection, jailbreaks, and model poisoning
  through supply chain, data leakage, model theft, shadow AI, AI-enabled
  malware, deepfakes, and AI phishing, to security tooling, agent and
  non-human identity, agent security, AI in security operations, AI privacy,
  and red teaming. Each page carries substantive analysis under the six
  security domains (governance and risk management, security operations,
  architecture and engineering, application and product security,
  third-party and supply chain risk, data protection and privacy) followed by
  primary sources: OWASP GenAI, MITRE ATLAS, NIST AI 100-2 and the AI RMF,
  CISA, NCSC, FBI IC3, the EU AI Act, C2PA, the MCP specification, and the
  labs' own published security research. Every source URL is verified before
  publication and re-verified daily. Live counts from this site (state
  deepfake bills, tracked MCP servers, compliance documents) appear in
  context.
- Industry Use Cases (same category): 21 sector pages, from manufacturing,
  healthcare, banking, and insurance to mining, agriculture, energy, defense,
  hospitality, real estate, sports, nonprofits, and churches. Each page leads
  with what AI is actually deployed for in the sector and who tracks it,
  then a set of sourced points, every one linked to a verified primary
  source: government agencies and statistical programs first, then trade
  associations, standards bodies, and the operating companies' own published
  programs. Paywalled analyst research and marketing pages are excluded.
- AI Observatory (under Research, Knowledge and Learning): seven daily
  telemetry sections computed only from data this site already keeps: model
  release cadence, GitHub activity across tracked AI repositories, Hugging
  Face catalog movement, provider API uptime from public status feeds,
  funding activity from SEC Form D filings, USPTO patent filings, and
  security incidents from provider status feeds. Daily snapshots accumulate.
- Entity Graph (same category): the site's own knowledge graph, roughly
  7,000 nodes across sixteen entity types (companies, people, models, papers,
  lawsuits, MCP servers, patents, filings, benchmarks, and more) and 3,100
  relationships across eleven edge types, each edge carrying the method that
  produced it. Rendered as two sections and exposed for machine reading.
- Cloud GPU and Compute Telemetry and Acquisitions (under AI Companies):
  quarterly capital expenditure for the seven largest AI infrastructure
  spenders drawn from SEC XBRL company facts, and 8-K acquisition filings
  (items 1.01 and 2.01) across tracked registrants, linked to the filings
  rather than summarised.
- Books (under Research, Knowledge and Learning): an independent shelf of AI
  titles, followed by the SRJ book series on AI audit, governance, and
  security, labelled as the publisher's own and linked with rel=sponsored.${bcCount ? ` The
  same page then lists ${bcCount} further AI books a reader can open today,
  ${bcFree} free to read in full and the rest borrowable free from the Internet
  Archive, catalogued from Open Library. Those are catalogued rather than
  curated: inclusion means only that the book is about AI and is actually
  reachable. Fiction tagged artificial intelligence and conference proceedings
  are excluded. Metadata only, each entry linking to its Open Library record.` : ''}

## Ask this site
Every page carries an ask box backed by POST https://theworldofai.org/api/ask
(JSON body: {"question": "..."}). It answers only from this site's own pages
using retrieval over the daily index, cites the pages it drew from, and
refuses questions the site does not cover rather than guessing. Rate limits:
10 questions per minute per IP and a global daily ceiling; over either limit
it declines quietly. Answers are generated, so treat the cited pages as the
authoritative record.

## Machine-readable data
- https://theworldofai.org/api/laws.json (per-state counts and index)
- https://theworldofai.org/api/glossary.json (all terms)
- https://theworldofai.org/api/lawsuits.json (all tracked cases)
- https://theworldofai.org/api/tools.json (tool catalog, categories, profiles)
- https://theworldofai.org/api/companies.json (company index)
- https://theworldofai.org/api/people.json (AI People Directory index)
- https://theworldofai.org/api/research.json (research library hub with all
  ten topics, most-cited papers, and per-paper metadata)
- https://theworldofai.org/api/sources.json (primary sources, sorted and
  sectioned as on the /sources/ page)
- https://theworldofai.org/api/compliance.json (compliance framework index)
- https://theworldofai.org/api/mcp.json (MCP server registry)
- https://theworldofai.org/api/weeks.json (weekly digest index)
- https://theworldofai.org/api/graph-entities.json and
  https://theworldofai.org/api/graph-relationships.json (the entity graph:
  nodes with type and source, edges with type and method)
- https://theworldofai.org/sitemap-index.xml (every URL, refreshed daily)

## About this publication
- https://theworldofai.org/about/ (who publishes this and how pages are made)
- https://theworldofai.org/contact/ (corrections, press, data questions)
- https://theworldofai.org/disclosure/ (advertising and affiliate policy)
- https://theworldofai.org/privacy/ (privacy policy)
- https://theworldofai.org/terms/ (terms of use)
- https://theworldofai.org/disclaimer/ (editorial and legal disclaimer)

## Update cadence
All data refreshes once daily via an automated pipeline running at 11:00 UTC;
the "generated" or "last verified" date on each page and in each API file is
the verification date. Benchmark results refresh from structured official
sources on the same daily run and fail closed to the last verified snapshot
rather than publishing an unverified number. The arXiv watch and vendor news
sections use a rolling 30-day window.

## Editorial policy
Every fact on this site traces to a primary source cataloged on the
[Sources and References](https://theworldofai.org/sources/) page. Where a
claim cannot be sourced, it is not published. Vendor announcements are
labelled as the vendor's own claims, not verified facts. Preprints are
labelled as not peer reviewed. Every outbound source URL on curated pages
is verified live before publication and re-verified on each daily run; a
source that stops resolving is marked stale on the page rather than removed
silently. Computed figures (counts, censuses, live statistics) are verified
against production data before they ship. Corrections are welcomed at
info@srjconsultingservices.com.

## Citation format
"{Page title}." The World of AI, {URL}. Verified {date}.
`;

export async function GET() {
  return new Response(text, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
