/**
 * The open-web fallback for /api/ask, and the record of it.
 *
 * WHY THIS EXISTS AT ALL. Until 2026-09-01 the ask box never reached the web:
 * when the site did not cover something it said so and logged the question,
 * because a logged gap gets researched and published once for everyone while a
 * guess helps one person unverifiably. Stephen decided to add a fallback. The
 * original reasoning is preserved by CONFINING it rather than deleting it -
 * this fires only on a genuine empty from both retrievers, renders in its own
 * labelled block, never enters "Sources on this site", and is stored cite_only
 * so it never becomes site content.
 *
 * THREE JOBS, ONE ROW. twoai_web_answers is a cache (a repeat question is
 * served from the row and costs nothing), a retention store (every pointer the
 * box was handed is kept with its URL and title), and a demand signal (a row
 * with zero site hits and zero paper hits is a question this site was asked
 * and could not answer, ranked by times_asked). The third is the reason this
 * is worth building: it turns "what should we cover next" from a guess into a
 * query.
 *
 * WHAT IS STORED AND WHAT IS NOT. Anthropic returns search results encrypted
 * to the caller - only the model sees the result content - so what we are able
 * to keep is exactly what we ought to keep: titles and URLs. Pointers, not
 * publisher prose. That sits inside the corpus provenance rule and inside the
 * argument twoai_thindiscover.go already makes: search is a pointer, not a
 * source.
 */

import postgres from "postgres";

// Web searches per day. Anthropic bills $10 per 1000 searches plus tokens for
// the retrieved results, and the SAME key funds the srj-pipeline cron against
// a $50 monthly account ceiling. A traffic spike on a public endpoint must
// never be able to starve the pipeline, so this cap is deliberately low: 15 a
// day is roughly $13 a month all-in. The cache is what makes that number
// workable, because a repeat question costs nothing.
export const DAILY_SEARCH_CAP = 15;

export type WebAnswer = {
  text: string;
  sources: Array<{ title: string; url: string }>;
  cached: boolean;
  fetchedAt?: string;
};

// How close two questions must be, by embedding cosine similarity, to count
// as the same question for cache purposes. Exact-string matching was wrong and
// a live test proved it: "how did einsteins theory of realtivity influence ai"
// and "How did Einstein theory of relativity influence artificial
// intelligence?" are the same question to any reader, and the box searched
// twice. Trigram similarity scored those two at 0.59 against 0.23 for two
// unrelated questions - real separation, but too thin a margin to spend money
// on. The embedding the Worker already computes for page retrieval handles
// both wording and spelling, at no extra cost. 0.93 is deliberately strict:
// a false cache hit serves the wrong answer, which is worse than a wasted
// search, so this errs toward searching again.
const CACHE_SIM_FLOOR = 0.93;

// How long a stored web answer is served before we search again. A cache with
// no expiry is how a reference site starts serving confidently stale facts:
// "how did relativity influence AI" never changes, but "who runs OpenAI" and
// "when does the EU AI Act apply" do, and this table cannot tell those apart.
// Thirty days is short enough to catch drift and long enough that the cache
// still carries most of the load against a 15-a-day search cap.
const CACHE_TTL_DAYS = 30;

// TEMPORARY DIAGNOSTIC, 2026-09-01. The fallback returned null on every live
// attempt and twoai_web_answers stayed empty, which means it threw before its
// first write - and a catch that returns null tells you nothing about where.
// This is the same ride-along that caught "2021: Invalid User Credentials"
// for the Haiku routing failure and the build-versus-runtime secret mix-up.
// Remove it once the fallback is confirmed writing rows.
export let lastWebError = "";

export async function webFallback(
  env: any,
  model: string,
  question: string,
  norm: string,
  siteHits: number,
  paperHits: number,
  qVec?: number[]
): Promise<WebAnswer | null> {
  if (!env.ANTHROPIC_API_KEY || !env.AUDIT_DB) {
    lastWebError = !env.ANTHROPIC_API_KEY ? "no ANTHROPIC_API_KEY" : "no AUDIT_DB";
    return null;
  }
  lastWebError = "";

  const sql = postgres(env.AUDIT_DB.connectionString, {
    max: 1,
    fetch_types: false,
    idle_timeout: 10,
  });

  try {
    // CACHE LOOKUP. Nearest question by meaning, not by string. Falls back to
    // the exact key when no embedding was passed, so the fallback still works
    // if the embed call failed upstream.
    const vecLit = qVec && qVec.length ? "[" + qVec.join(",") + "]" : null;
    const prior: any[] = vecLit
      ? await sql`
          SELECT results, fetched_at, question_raw, question_norm,
                 1 - (q_vec <=> ${vecLit}::vector) AS sim,
                 (fetched_at > now() - ${CACHE_TTL_DAYS + " days"}::interval) AS fresh
            FROM twoai_web_answers
           WHERE superseded_at IS NULL AND q_vec IS NOT NULL AND results IS NOT NULL
           ORDER BY q_vec <=> ${vecLit}::vector
           LIMIT 1`
      : await sql`
          SELECT results, fetched_at, question_raw, question_norm, 1.0 AS sim,
                 (fetched_at > now() - ${CACHE_TTL_DAYS + " days"}::interval) AS fresh
            FROM twoai_web_answers
           WHERE question_norm = ${norm} AND superseded_at IS NULL`;

    await sql`
      INSERT INTO twoai_web_answers (question_norm, question_raw, site_hit_count, paper_hit_count, q_vec)
      VALUES (${norm}, ${question}, ${siteHits}, ${paperHits}, ${vecLit}::vector)
      ON CONFLICT (question_norm) DO UPDATE
        SET times_asked = twoai_web_answers.times_asked + 1,
            last_asked_at = now(),
            site_hit_count = ${siteHits},
            paper_hit_count = ${paperHits},
            q_vec = COALESCE(twoai_web_answers.q_vec, ${vecLit}::vector)`;

    const hit = prior.length && prior[0].results && prior[0].results.text
      && Number(prior[0].sim) >= CACHE_SIM_FLOOR;
    if (hit) {
      if (prior[0].fresh) {
        return {
          text: String(prior[0].results.text),
          sources: prior[0].results.sources ?? [],
          cached: true,
          fetchedAt: prior[0].fetched_at ? new Date(prior[0].fetched_at).toISOString() : undefined,
        };
      }
      // EXPIRED. The old answer is marked superseded with its reason rather
      // than overwritten, because the standing rule is that nothing is ever
      // deleted from an SRJ database - a row that recorded what the web said
      // in September is evidence, even once it stops being current. Note the
      // key retired here is the MATCHED row's own question_norm, which under
      // vector matching is often a different phrasing than the one just asked.
      await sql`
        UPDATE twoai_web_answers
           SET question_norm = ${prior[0].question_norm + " #superseded " + new Date().toISOString()},
               superseded_at = now(),
               superseded_reason = ${"cache expired after " + CACHE_TTL_DAYS + " days"}
         WHERE question_norm = ${prior[0].question_norm} AND superseded_at IS NULL`;
      // The supersede above renamed the live key away, so a fresh row must be
      // opened under it or the search result written at the end of this
      // function would target a row that no longer exists and silently store
      // nothing. times_asked carries over so the demand signal is not reset by
      // an expiry the reader never sees.
      await sql`
        INSERT INTO twoai_web_answers (question_norm, question_raw, site_hit_count, paper_hit_count)
        VALUES (${norm}, ${question}, ${siteHits}, ${paperHits})
        ON CONFLICT (question_norm) DO NOTHING`;
    }

    // DAILY CAP. Over it we return null and the caller degrades to the plain
    // not-covered answer: the reader loses the pointer, the gap is still
    // recorded above, and the pipeline keeps its share of the account. A
    // counter we cannot read fails CLOSED - an unreadable budget must never
    // silently unlock unlimited spend on a public endpoint.
    const day = new Date().toISOString().slice(0, 10);
    try {
      await env.ASSISTANT_DB.exec(
        "CREATE TABLE IF NOT EXISTS search_budget (day TEXT PRIMARY KEY, searched INTEGER NOT NULL DEFAULT 0)"
      );
      const row: any = await env.ASSISTANT_DB.prepare(
        "SELECT searched FROM search_budget WHERE day = ?"
      )
        .bind(day)
        .first();
      if (row && Number(row.searched) >= DAILY_SEARCH_CAP) {
        lastWebError = "daily search cap reached";
        return null;
      }
    } catch (e: any) {
      lastWebError = "budget: " + String(e?.message ?? e).slice(0, 200);
      return null;
    }

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 600,
        system:
          "You are answering a question that theworldofai.org does not cover. Search the web and give a brief factual answer in at most 120 words. Begin immediately with the answer: never narrate what you are about to do, and never write a sentence like 'I will search for that'. Name the sources you used. Do not claim this site covers the topic and do not mention theworldofai.org. If the search finds nothing solid, say so plainly rather than guessing.",
        messages: [{ role: "user", content: question }],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    });
    if (!r.ok) {
      lastWebError = `anthropic HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`;
      return null;
    }
    const out: any = await r.json();

    // Pull prose and citation URLs out of the block list. Citations ride on
    // text blocks; server tool result blocks nest their own content, so both
    // shapes are walked rather than assuming one.
    let text = "";
    const srcMap = new Map<string, string>();
    const walk = (blocks: any[]) => {
      for (const b of blocks ?? []) {
        if (b?.type === "text") {
          text += String(b.text ?? "");
          for (const c of b.citations ?? []) {
            const u = String(c?.url ?? "");
            if (u) srcMap.set(u, String(c?.title ?? u));
          }
        }
        if (Array.isArray(b?.content)) walk(b.content);
      }
    };
    walk(out?.content ?? []);
    // Strip tool-use narration. Verified live 2026-09-01: the first working
    // answer opened "I'll search for information on how Einstein's theory of
    // relativity influenced artificial intelligence." before the substance.
    // The prompt now forbids it, and this catches the model that does it
    // anyway, because a reader wants the answer, not the process.
    text = text.replace(/^\s*(i(?:'|\u2019)?ll|i will|let me|i'm going to|i am going to)\b[^.!?\n]*[.!?\n]\s*/i, "");
    text = text.trim();
    if (!text) {
      lastWebError = "empty text from search call";
      return null;
    }

    const sources = [...srcMap].map(([url, title]) => ({ url, title })).slice(0, 6);

    try {
      await env.ASSISTANT_DB.prepare(
        `INSERT INTO search_budget (day, searched) VALUES (?, 1)
           ON CONFLICT(day) DO UPDATE SET searched = searched + 1`
      )
        .bind(day)
        .run();
    } catch {}

    await sql`
      UPDATE twoai_web_answers
         SET provider = 'anthropic-web-search',
             fetched_at = now(),
             results = ${sql.json({ text, sources } as any)},
             provenance = 'cite_only'
       WHERE question_norm = ${norm}`;

    return { text, sources, cached: false, fetchedAt: new Date().toISOString() };
  } catch (e: any) {
    // The fallback is additive. Its failure returns the reader to the same
    // honest not-covered answer they would have had before it existed.
    lastWebError = String(e?.message ?? e).slice(0, 300);
    return null;
  } finally {
    try {
      await sql.end();
    } catch {}
  }
}
