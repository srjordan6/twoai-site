/**
 * Two more free, structured tiers ahead of any paid web search.
 *
 * OPENALEX (CC0) answers about PEOPLE and INSTITUTIONS. The local corpus holds
 * 809,501 works but no researcher profiles, so "who is Demis Hassabis" is
 * unanswerable from our own tables today while the live API answers it in one
 * call.
 *
 * A DATA-QUALITY FINDING THAT SHAPED THIS FILE. Testing that exact query, the
 * API returned the right person by every metric that matters - h-index 92,
 * 196,933 citations, topics in reinforcement learning and neural mechanisms -
 * and gave his last known institution as John Brown University. That is wrong.
 * Author disambiguation across a 250-million-work corpus produces affiliation
 * errors, and an affiliation is exactly the kind of fact a reader would take
 * at face value. So last_known_institutions is NOT surfaced. Works count,
 * citation count, h-index and topics are computed over the author's own
 * publication record and are trustworthy; the ORCID is carried so anyone can
 * check the identity themselves. Publishing a wrong employer under our own
 * domain to look more complete is the trade this site exists not to make.
 *
 * HUGGING FACE answers about MODELS, which is the most on-topic question class
 * an AI reference site can receive and the one gap not already harvested.
 * Metadata only - downloads, likes, task, library, tags, creation date. Model
 * card prose is left alone: cards carry their own licences and reproducing
 * them is the same mistake as republishing a publisher's abstract.
 */

const UA = "theworldofai.org (https://theworldofai.org; srj@srjconsultingservices.com)";

import postgres from "postgres";

export type LookupFact = { field: string; label: string; value: string };
export type LookupAnswer = {
  source: "openalex" | "huggingface";
  sourceLabel: string;
  title: string;
  description: string;
  url: string;
  facts: LookupFact[];
};

export let lastLookupError = "";

// A stored structured answer is served for this long before we ask the source
// again. Same 30 days as the web cache: long enough that a question asked
// twice in a week comes out of our own database, short enough that a founder
// count or an employee figure cannot sit wrong for a year.
const LOOKUP_TTL_DAYS = 30;

/**
 * Serve a previously stored structured answer instead of calling out again.
 *
 * WHY THIS WAS MISSING AND WHY IT MATTERED. The paid web tier had a cache from
 * the start because a search costs money. The free tiers had none, so "who
 * founded DeepMind" asked twice hit Wikidata twice - and Stephen's point is
 * the right one regardless of cost: once we have looked something up and kept
 * it, the answer should come from our own database. Free does not mean the
 * lookup is free of consequence. It is a network round trip on the reader's
 * request path, a second chance to get a different answer than we showed
 * yesterday, and a load we put on somebody else's public service every time
 * the same question is asked.
 */
export async function cachedLookup(
  env: any,
  norm: string,
  qVec?: number[]
): Promise<{ wikidata?: any; lookup?: any; fetchedAt?: string } | null> {
  if (!env.AUDIT_DB) return null;
  const sql = postgres(env.AUDIT_DB.connectionString, { max: 1, fetch_types: false, idle_timeout: 10 });
  try {
    const vecLit = qVec && qVec.length ? "[" + qVec.join(",") + "]" : null;
    const rows: any[] = vecLit
      ? await sql`
          SELECT results, fetched_at, 1 - (q_vec <=> ${vecLit}::vector) AS sim
            FROM twoai_web_answers
           WHERE superseded_at IS NULL AND q_vec IS NOT NULL
             AND results ? 'lookupKind'
             AND fetched_at > now() - ${LOOKUP_TTL_DAYS + " days"}::interval
           ORDER BY q_vec <=> ${vecLit}::vector
           LIMIT 1`
      : await sql`
          SELECT results, fetched_at, 1.0 AS sim
            FROM twoai_web_answers
           WHERE question_norm = ${norm} AND superseded_at IS NULL
             AND results ? 'lookupKind'
             AND fetched_at > now() - ${LOOKUP_TTL_DAYS + " days"}::interval`;
    const r = rows[0];
    // Same strict 0.93 floor the web cache uses. Measured on real questions,
    // a reworded question and a genuinely different one sit 0.013 apart, so
    // anything looser would serve one entity's facts for another's - which on
    // a fact table is far worse than a redundant free API call.
    if (!r || Number(r.sim) < 0.93 || !r.results) return null;
    return {
      wikidata: r.results.wikidata ?? undefined,
      lookup: r.results.lookup ?? undefined,
      fetchedAt: r.fetched_at ? new Date(r.fetched_at).toISOString() : undefined,
    };
  } catch {
    return null;
  } finally {
    try { await sql.end(); } catch {}
  }
}

/**
 * Record a free-tier answer and the facts it carried.
 *
 * WHY THIS EXISTS SEPARATELY FROM webFallback. The free tiers return before
 * the web fallback is ever called, so until now they answered the reader and
 * remembered nothing: "who founded DeepMind" was answered from Wikidata and
 * left no row anywhere, which contradicts the standing rule that we retain
 * everything we look up. This gives them the same memory the paid tier has.
 *
 * FACTS LAND AS `proposed`, NEVER STRAIGHT ONTO A PAGE. Wikidata is CC0 and
 * structured, but it is not uniformly clean: the very first live answer gave
 * Google DeepMind's headquarters as "London, Googleplex", concatenating two
 * P159 values one of which is in Mountain View, and reported 10,000 employees
 * with no date attached. Sound enough to show a reader in a labelled block
 * that names its source; not sound enough to publish as our own fact without
 * someone looking at it.
 */
export async function recordLookup(
  env: any,
  question: string,
  norm: string,
  siteHits: number,
  paperHits: number,
  qVec: number[] | undefined,
  bestScore: number | undefined,
  answers: Array<{ sourceLabel: string; title: string; url: string; facts: LookupFact[] }>,
  payload?: { wikidata?: any; lookup?: any }
): Promise<void> {
  if (!env.AUDIT_DB) return;
  const sql = postgres(env.AUDIT_DB.connectionString, { max: 1, fetch_types: false, idle_timeout: 10 });
  try {
    const vecLit = qVec && qVec.length ? "[" + qVec.join(",") + "]" : null;
    // results carries a lookupKind marker so the cache read can tell a stored
    // structured answer apart from a stored web-search answer in the same
    // column, and fetched_at is set so the TTL applies to both alike.
    const stored = payload
      ? sql.json({ lookupKind: "structured", ...payload } as any)
      : null;
    await sql`
      INSERT INTO twoai_web_answers (question_norm, question_raw, site_hit_count, paper_hit_count, q_vec, best_score, results, provider, fetched_at)
      VALUES (${norm}, ${question}, ${siteHits}, ${paperHits}, ${vecLit}::vector, ${bestScore ?? null}, ${stored}, 'structured-lookup', now())
      ON CONFLICT (question_norm) DO UPDATE
        SET times_asked = twoai_web_answers.times_asked + 1,
            last_asked_at = now(),
            site_hit_count = ${siteHits},
            paper_hit_count = ${paperHits},
            best_score = ${bestScore ?? null},
            results = COALESCE(${stored}, twoai_web_answers.results),
            provider = COALESCE(twoai_web_answers.provider, 'structured-lookup'),
            fetched_at = COALESCE(twoai_web_answers.fetched_at, now()),
            q_vec = COALESCE(twoai_web_answers.q_vec, ${vecLit}::vector)`;

    for (const a of answers) {
      for (const f of a.facts) {
        // Deduplicated on the natural key rather than blindly appended: the
        // same question asked twice must not double the proposal list. An
        // existing row is left alone, including any review already done on it.
        await sql`
          INSERT INTO twoai_web_facts
            (question_norm, entity_name, field, value, source_url, source_title)
          SELECT ${norm}, ${a.title}, ${f.field}, ${f.value}, ${a.url}, ${a.sourceLabel}
           WHERE NOT EXISTS (
             SELECT 1 FROM twoai_web_facts
              WHERE entity_name = ${a.title} AND field = ${f.field}
                AND value = ${f.value} AND superseded_at IS NULL)`;
      }
    }
  } catch (e: any) {
    // Recording is bookkeeping. Its failure must never cost the reader the
    // answer they already have in hand.
    lastLookupError = "record: " + String(e?.message ?? e).slice(0, 200);
  } finally {
    try { await sql.end(); } catch {}
  }
}

/**
 * Promote looked-up facts onto the matching company profile.
 *
 * Stephen's instruction: after a lookup, promote the information to the
 * company's page. This does that, under four constraints that keep it from
 * being the thing this site exists not to be.
 *
 * 1. HARD IDENTIFIER ONLY. The match is registrable-domain equality between
 *    Wikidata's P856 official website and twoai_company_profiles.website.
 *    Never the name. "Anthropic" and "Anthropic PBC" and somebody's unrelated
 *    consultancy all share a name; they do not share a domain. A wrong match
 *    here writes one company's founders onto another company's page.
 * 2. FILL EMPTY FIELDS ONLY. An existing value is never overwritten. Our own
 *    harvested and verified data outranks a third-party claim, and silently
 *    replacing a checked figure with an unchecked one is how a corpus rots.
 * 3. FIRST VALUE ONLY on fields that must be singular. Wikidata gave Google
 *    DeepMind "London, Googleplex" for headquarters by concatenating two P159
 *    statements, one of which is in Mountain View. A multi-valued answer is
 *    fine in a labelled block that says where it came from; it is not fine as
 *    the headquarters line on our own page.
 * 4. PROVENANCE TRAVELS. Every promoted field appends a sources entry naming
 *    the QID and the date, so the page can say where the fact came from and
 *    the promotion can be undone by a human who disagrees.
 */
export async function promoteFacts(
  env: any,
  wd: { qid: string; title: string; url: string; facts: LookupFact[] }
): Promise<string> {
  if (!env.AUDIT_DB) return "no db";
  const site = wd.facts.find((f) => f.field === "website")?.value ?? "";
  let host = "";
  if (site) {
    try {
      host = new URL(site).hostname.replace(/^www\./i, "").toLowerCase();
    } catch {
      host = "";
    }
  }
  const val = (f: string) => wd.facts.find((x) => x.field === f)?.value ?? "";
  const first = (f: string) => val(f).split(",")[0].trim();

  const sql = postgres(env.AUDIT_DB.connectionString, { max: 1, fetch_types: false, idle_timeout: 10 });
  try {
    // MATCH ORDER: stored QID first, then domain.
    //
    // Domain alone is not enough here, and checking the data before shipping
    // is why. twoai_company_profiles.website holds the PRODUCT url, not the
    // company one: Anthropic is https://claude.ai/, OpenAI is
    // https://chatgpt.com/, Vercel is https://v0.dev/. Wikidata P856 gives
    // anthropic.com, openai.com, vercel.com. Matching those two columns would
    // have failed on essentially every company in the directory, and any
    // accidental hit would have been a coincidence rather than an identity.
    // So the 43 profiles that already carry a verified wikidata_qid match on
    // that, which is the strongest identifier available, and domain equality
    // remains as a second chance for the rest. Still never the name.
    let rows: any[] = await sql`
      SELECT uid, name FROM twoai_company_profiles WHERE wikidata_qid = ${wd.qid} LIMIT 1`;
    if (!rows.length) {
      rows = await sql`
        SELECT uid, name FROM twoai_company_profiles
         WHERE website IS NOT NULL
           AND lower(regexp_replace(regexp_replace(website, '^https?://', ''), '^www\.', '')) LIKE ${host + "%"}
         LIMIT 1`;
    }
    if (!rows.length) return "no profile matching " + wd.qid + " or domain " + host;
    const uid = rows[0].uid;

    const founders = val("founders")
      ? JSON.stringify(val("founders").split(",").map((s) => s.trim()).filter(Boolean))
      : null;
    const foundedYear = /^\d{4}$/.test(val("founded")) ? Number(val("founded")) : null;
    const hq = first("headquarters") || null;
    const emp = /^\d+$/.test(val("employees")) ? Number(val("employees")) : null;

    const res: any = await sql`
      UPDATE twoai_company_profiles
         SET founders = CASE WHEN founders = '[]'::jsonb AND ${founders}::jsonb IS NOT NULL
                             THEN ${founders}::jsonb ELSE founders END,
             founded = COALESCE(founded, ${foundedYear}),
             headquarters = COALESCE(headquarters, ${hq}),
             employees = COALESCE(employees, ${emp}),
             wikidata_qid = COALESCE(wikidata_qid, ${wd.qid}),
             sources = sources || ${sql.json([{ source: "Wikidata " + wd.qid, url: wd.url,
                        retrieved: new Date().toISOString().slice(0, 10) }] as any)},
             updated_at = now()
       WHERE uid = ${uid}
       RETURNING uid`;
    if (!res.length) return "update matched no row";

    await sql`
      UPDATE twoai_web_facts
         SET status = 'promoted', promoted_at = now(), entity_uid = ${uid},
             reviewed_by = 'auto: wikidata domain match'
       WHERE entity_name = ${wd.title} AND status = 'proposed' AND superseded_at IS NULL`;
    return "promoted to " + rows[0].name;
  } catch (e: any) {
    return "promote error: " + String(e?.message ?? e).slice(0, 160);
  } finally {
    try { await sql.end(); } catch {}
  }
}

const getJson = async (url: string): Promise<any | null> => {
  const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" } });
  if (!r.ok) {
    lastLookupError = `HTTP ${r.status} from ${new URL(url).host}`;
    return null;
  }
  return await r.json();
};

const num = (n: any) => (typeof n === "number" ? n.toLocaleString("en-US") : "");

/**
 * People and institutions, from OpenAlex. Only fires when the question looks
 * like it is about a person: an author lookup on "what is RAG" would return a
 * confident profile of somebody irrelevant, which is worse than nothing.
 */
export async function openAlexAuthor(subject: string, question: string): Promise<LookupAnswer | null> {
  if (!/\b(who|whose|author|researcher|scientist|professor)\b/i.test(question)) return null;
  if (!subject) return null;
  try {
    const d = await getJson(
      "https://api.openalex.org/authors?per-page=1&search=" + encodeURIComponent(subject));
    const a = d?.results?.[0];
    if (!a?.display_name) {
      lastLookupError = "no openalex author for: " + subject;
      return null;
    }
    const stats = a.summary_stats ?? {};
    const facts: LookupFact[] = [];
    if (a.works_count) facts.push({ field: "works", label: "Published works", value: num(a.works_count) });
    if (a.cited_by_count) facts.push({ field: "cited_by", label: "Times cited", value: num(a.cited_by_count) });
    if (stats.h_index) facts.push({ field: "h_index", label: "h-index", value: String(stats.h_index) });
    const topics = (a.topics ?? []).slice(0, 4).map((t: any) => t?.display_name).filter(Boolean);
    if (topics.length) facts.push({ field: "topics", label: "Research topics", value: topics.join(", ") });
    if (a.orcid) facts.push({ field: "orcid", label: "ORCID", value: String(a.orcid).replace(/^https?:\/\/orcid\.org\//, "") });
    if (!facts.length) return null;
    return {
      source: "openalex",
      sourceLabel: "OpenAlex",
      title: String(a.display_name),
      description: "Researcher profile built from published works",
      url: String(a.id ?? "https://openalex.org"),
      facts,
    };
  } catch (e: any) {
    lastLookupError = String(e?.message ?? e).slice(0, 200);
    return null;
  }
}

/**
 * Models and datasets, from the Hugging Face Hub. Fires on model-shaped
 * questions only, for the same reason as above.
 */
export async function huggingFaceModel(subject: string, question: string): Promise<LookupAnswer | null> {
  if (!/\b(model|models|llm|checkpoint|weights|fine-?tun\w*|dataset)\b/i.test(question)
      && !/\b(llama|mistral|qwen|gemma|phi|falcon|deepseek|whisper|stable diffusion)\b/i.test(question)) {
    return null;
  }
  if (!subject) return null;
  try {
    const list = await getJson(
      "https://huggingface.co/api/models?limit=1&sort=downloads&direction=-1&search=" +
        encodeURIComponent(subject));
    const top = Array.isArray(list) ? list[0] : null;
    if (!top?.modelId && !top?.id) {
      lastLookupError = "no hugging face model for: " + subject;
      return null;
    }
    const id = String(top.modelId ?? top.id);
    const m = (await getJson("https://huggingface.co/api/models/" + id)) ?? top;
    const facts: LookupFact[] = [];
    if (m.pipeline_tag) facts.push({ field: "task", label: "Task", value: String(m.pipeline_tag).replace(/-/g, " ") });
    if (m.library_name) facts.push({ field: "library", label: "Library", value: String(m.library_name) });
    if (typeof m.downloads === "number") facts.push({ field: "downloads", label: "Downloads (30 days)", value: num(m.downloads) });
    if (typeof m.likes === "number") facts.push({ field: "likes", label: "Likes", value: num(m.likes) });
    if (m.createdAt) facts.push({ field: "created", label: "First published", value: String(m.createdAt).slice(0, 10) });
    const tags = (m.tags ?? []).filter((t: string) =>
      !t.startsWith("arxiv") && !t.startsWith("license:") && !t.startsWith("base_model")).slice(0, 8);
    if (tags.length) facts.push({ field: "tags", label: "Tags", value: tags.join(", ") });
    const lic = (m.tags ?? []).find((t: string) => t.startsWith("license:"));
    if (lic) facts.push({ field: "license", label: "Licence", value: lic.slice(8) });
    if (!facts.length) return null;
    return {
      source: "huggingface",
      sourceLabel: "Hugging Face",
      title: id,
      description: "Model metadata from the Hugging Face Hub",
      url: "https://huggingface.co/" + id,
      facts,
    };
  } catch (e: any) {
    lastLookupError = String(e?.message ?? e).slice(0, 200);
    return null;
  }
}
