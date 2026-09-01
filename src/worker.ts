/**
 * theworldofai.org — the site Worker.
 *
 * Serves the static build for everything, and handles POST /api/ask itself.
 *
 * WHY THE ENDPOINT LIVES HERE RATHER THAN ON A SERVER. The first working
 * version ran in the pipeline binary on Render, because the retrieval index was
 * in Postgres behind a one-IP allow list a Worker cannot cross. Moving the
 * vectors into Vectorize removes that constraint: retrieval, generation and the
 * page itself now run in the same place, with no extra service to pay for, no
 * cold start, and no Ohio round trip from the edge.
 *
 * POSTGRES REMAINS THE SOURCE OF TRUTH. twoai_embeddings is still the
 * authoritative index, written by the pipeline; Vectorize is a derived copy it
 * pushes to and can rebuild from scratch at any time. Two stores that each
 * think they are authoritative is how data quietly diverges, and this codebase
 * has found that failure often enough this week to design around it.
 *
 * WHAT THIS ENDPOINT WILL NOT DO:
 *  - It never answers from the model's own knowledge. Only retrieved chunks.
 *  - It never presents the web as this site. Until 2026-09-01 this endpoint
 *    did not reach the web at all: when the site did not cover something it
 *    said so and logged the question, because a logged gap gets researched and
 *    published once for everyone, while a guess helps one person unverifiably
 *    and puts an unsourced claim under our own domain name. Stephen decided to
 *    add a web fallback, and the original reasoning is preserved by CONFINING
 *    it rather than removing it: the search fires ONLY when site pages and the
 *    research index both come back empty, its result renders in a separate
 *    labelled block, it never enters "Sources on this site", and it is stored
 *    cite_only so it never becomes site content. The gap is still logged. What
 *    changed is that the reader also gets a pointer while they wait for us to
 *    cover it properly - which is what twoai_thindiscover.go already argues
 *    search should be: a pointer, not a source.
 *  - It never returns an answer without the pages it came from.
 */

import { handleTalent, talentWeeklyDigest, talentMailAnswer } from "./talent";
import { webFallback, lastWebError } from "./websearch";
import { wikidataLookup, lastWikidataError, subjectOf } from "./wikidata";
import { openAlexAuthor, huggingFaceModel, recordLookup, cachedLookup, promoteFacts } from "./lookups";
import postgres from "postgres";

interface Env {
  AI: any;
  VECTORIZE: any;
  // OPTIONAL second Vectorize index over the works corpus (title+abstract
  // embeddings, pushed by the pipeline stage twoai_works_embed). When absent
  // the research index is full-text only, exactly as before: the binding is
  // the switch, so the worker ships hybrid-ready before the index exists.
  WORKS_VECTORIZE?: any;
  ASSISTANT_DB: D1Database;
  // Hyperdrive to srj_audit, read-only role, for the research index.
  AUDIT_DB?: { connectionString: string };
  ASSETS: { fetch: (req: Request) => Promise<Response> };
  // Per-IP rate limiter (wrangler "unsafe" ratelimit binding, open beta).
  // Optional in the type because the Worker must keep answering if the
  // binding is ever dropped from config: degrade to unlimited, never to 500.
  ASK_RATE?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
  // Worker secret. When present, the primary answer model is Claude Haiku
  // called DIRECTLY at api.anthropic.com, bypassing Workers AI partner routing
  // entirely. Set with `wrangler secret put ANTHROPIC_API_KEY` or in the
  // dashboard; the same key already lives on the srj-pipeline Render cron.
  ANTHROPIC_API_KEY?: string;
}

const EMBED_MODEL = "@cf/baai/bge-m3";
// HISTORY OF THE PRIMARY-MODEL FAILURES, in order, because each fix revealed
// the next fault and the sequence is worth not repeating:
//  1. "@cf/anthropic/claude-haiku-4.5" is not a model id (partner models drop
//     the @cf/ prefix). Generic 503.
//  2. A gateway option named a gateway that does not exist. Removed; not the
//     root fault.
//  3. {role: "system"} in the messages array. Partner models take `system` as
//     a top-level string. 7003 User Input Error.
//  4. THE ACTUAL ROOT CAUSE, captured live 2026-08-19: "2021: Invalid User
//     Credentials". Workers AI partner models bill through unified billing or
//     an AI Gateway holding your own Anthropic key. This account has neither,
//     so every partner call has failed since the endpoint shipped and llama
//     served every answer.
// The fix is to stop depending on partner routing at all: with the
// ANTHROPIC_API_KEY secret set, the Worker calls api.anthropic.com directly.
// The partner id stays only as a middle attempt when no key is configured, so
// enabling unified billing later would also work without a code change.
const ANTHROPIC_MODEL = "claude-haiku-4-5"; // direct-API model id
const PARTNER_MODEL = "anthropic/claude-haiku-4.5"; // Workers AI partner id
const GUARD_MODEL = "@cf/meta/llama-guard-3-8b";
// Fallback if the partner model is unavailable for any reason: not enabled on
// the account, quota, an outage, or a changed id. A Cloudflare-hosted model
// keeps the assistant answering rather than showing a dead box on the home
// page, and the response records which model answered so a silent downgrade is
// visible rather than assumed.
const FALLBACK_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * Below this cosine score the site genuinely does not cover the question.
 *
 * RAISED FROM 0.45 TO 0.52 after live testing. At 0.45 the question "hello"
 * scored 0.55 against a vendor post that happens to be titled "Hello World",
 * and the assistant duly explained what Hello World is. That is not a wrong
 * retrieval, it is a wrong THRESHOLD: a coincidental lexical match is not
 * coverage, and answering it makes the assistant look credulous on exactly the
 * kind of input a first-time visitor types.
 *
 * Real hits sit at 0.63 to 0.73. "What is the capital of France" correctly
 * refuses. 0.52 keeps the genuine answers and drops the coincidences.
 */
const SCORE_FLOOR = 0.52;
// GLOBAL DAILY CEILING on answered (billable) questions. The per-IP limiter
// stops one caller looping; it does NOT stop a spread of IPs each staying
// under 10/min from running the Anthropic bill up all day. This is the
// account-wide backstop: once this many questions have been ANSWERED in a
// UTC day, the endpoint rests until midnight UTC and returns the same
// not-covered shape as an unknown question, so the page degrades to "resting"
// rather than to an error or an unbounded invoice. Refusals and cache hits do
// not count, because they cost nothing. Pair this with a hard spend cap in
// the Anthropic console: this guards the common case, that guards the tail.
const DAILY_ANSWER_CAP = 5000;
// RAISED 12/6 -> 18/8 (2026-08-31, Stephen's approval of the retrieval-breadth
// fix): the box was reaching five pages while the site holds 522 glossary
// terms, 108 cases and a timeline to 1943. Breadth was the constraint, not
// the model. PER_PAGE stays 2 so one long page cannot crowd out the rest.
const TOP_K = 18;      // over-fetch, then cap per page
const PER_PAGE = 2;    // at most two chunks from any one page
const MAX_SOURCES = 8;

const SYSTEM = `You answer questions about artificial intelligence using ONLY the excerpts provided, which come from theworldofai.org and from its research index of academic papers.

RULES, in order:
1. Use only what is in the excerpts. Refuse ONLY when NEITHER the site pages NOR the research papers below answer the question: a relevant paper IS an answer, and refusing while holding one tells the reader we have nothing when we do. When nothing answers, say plainly: "The World of AI does not cover that yet." Do not fill the gap from your own knowledge, and never guess a date, a number, a case outcome or a legal requirement.
1a. IF THE EXCERPTS COVER THE SUBJECT BUT NOT THE EXACT QUESTION, DO NOT REFUSE. Give the reader what this site holds on that subject - what the organisation or thing is, what it does, and the specific facts the pages carry - and then say in one sentence which part of their question the site does not hold. A reader who asks who founded an organisation and gets "we do not cover that" learns nothing, when the site has a page on that organisation and could have told them what it is, when it was founded and where it is based. Refuse outright only when the excerpts have nothing on the subject at all.
1b. There are two kinds of excerpt. Numbered [1] [2] are PAGES ON THIS SITE. Numbered [R1] [R2] are PAPERS from the research index, which are not pages here. Answer from the pages first and use the papers to support or extend the answer, saying when a claim comes from a paper rather than from this site. Where the pages cover a topic only partly, the papers are how you finish the answer: use them rather than stopping at what the pages happen to hold.
1c. Paper abstracts are the publishers' text, licensed to us for citation only. Summarise a paper in your own words and never quote or reproduce an abstract. If you use a paper, you MUST write its title in full in your answer, because the source list under the answer is built from the titles you name: a paper you rely on without naming will not be shown to the reader, and a paper you name without using would be a false citation. Do not list a paper that added nothing to the answer, but do not withhold one that did.
2. Cite the pages you used by their titles, naturally, in the sentence that uses them.
3. Be brief. Two or three short paragraphs at most. Lead with the answer.
4. Where the excerpts disagree or are dated, say so rather than smoothing it over.
5. Plain English. No hype. Commas rather than dashes.
6. You are a reference work, not a salesperson and not a lawyer. Never give legal advice; report what the sources say and note that the primary source should be checked for anything that matters.
7. OPTIONALLY, after the sourced answer, you may add ONE short paragraph of general context from your own knowledge, and only when it genuinely completes the picture for the reader. It must start on its own line with exactly "BEYOND OUR SOURCES: " and contain no citations, no page titles, no paper titles, and nothing presented as coming from this site. Never use it to answer the question itself, never let it contradict the sourced answer, and omit it entirely when the sourced answer stands on its own.`;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "https://theworldofai.org",
      "cache-control": "no-store",
    },
  });

export default {
  // Monday 14:00 UTC (9am CT), after the 11:00 pipeline run has refreshed
  // listings and matches: one weekly digest per live member, via Resend.
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const tenv = env as unknown as Parameters<typeof talentMailAnswer>[0];
    // Two crons share this handler: the five-minute tick answers the relay
    // mailbox; Monday 14:00 UTC additionally sends the job-match digest.
    if (event.cron === "0 14 * * 1") ctx.waitUntil(talentWeeklyDigest(tenv));
    ctx.waitUntil(talentMailAnswer(tenv));
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/talent/")) {
      // The AI Talent Network write path lives in its own module so a bug in
      // it can never touch the assistant, and vice versa.
      return handleTalent(request, env as unknown as Parameters<typeof handleTalent>[1]);
    }

    if (url.pathname === "/sitemap.xml") {
      // robots.txt names /sitemap-index.xml, but enough crawlers and tools ask
      // for the conventional path that a 404 there reads as "no sitemap".
      // Verified still 404 on 2026-08-30; one redirect ends it.
      return Response.redirect(`${url.origin}/sitemap-index.xml`, 301);
    }

    if (url.pathname !== "/api/ask") {
      // Everything else is the static site, untouched.
      return env.ASSETS.fetch(request);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "https://theworldofai.org",
          "access-control-allow-headers": "content-type",
          "access-control-allow-methods": "POST, OPTIONS",
        },
      });
    }
    if (request.method !== "POST") return json({ error: "POST only" }, 405);

    // Rate limit BEFORE reading the body or spending anything. Keyed on the
    // connecting IP: coarse (an office NAT shares a key) but the right trade
    // for an endpoint whose per-request cost is a paid model call. When the
    // binding is absent the check is skipped entirely.
    if (env.ASK_RATE) {
      try {
        const ip = request.headers.get("cf-connecting-ip") || "unknown";
        const { success } = await env.ASK_RATE.limit({ key: ip });
        if (!success) {
          return json({ error: "Too many questions too quickly. Wait a minute and try again." }, 429);
        }
      } catch {
        /* Limiter failure must never block a reader. */
      }
    }

    let question = "";
    try {
      const body = (await request.json()) as { question?: string };
      question = (body.question || "").trim();
    } catch {
      return json({ error: "Bad request" }, 400);
    }
    if (question.length < 3) return json({ error: "Ask a question." }, 400);
    if (question.length > 500) question = question.slice(0, 500);

    const norm = question.toLowerCase().split(/\s+/).join(" ");

    // Screening runs in SHADOW MODE: recorded, never blocking. This corpus is
    // ABOUT deepfakes, extremism policy and abuse litigation, so a classifier
    // reading surface terms would refuse the site's own tracker to the audience
    // it was built for. The decision to enforce gets made from real traffic.
    const guard = env.AI.run(GUARD_MODEL, {
      messages: [{ role: "user", content: question }],
    }).then((r: any) => String(r?.response ?? "")).catch(() => "error");

    const researchExcerpts: string[] = [];
    // The question embedding is hoisted out of the retrieval block so the web
    // cache can match on meaning instead of exact text. It costs nothing extra
    // - it is already computed for page retrieval.
    let qVec: number[] | undefined;
    let hits: Array<{ score: number; url: string; title: string; body: string }> = [];
    try {
      const emb = await env.AI.run(EMBED_MODEL, { text: [question] });
      const vector = emb.data[0];
      qVec = vector;
      const res = await env.VECTORIZE.query(vector, {
        topK: TOP_K,
        returnMetadata: "all",
      });
      const perPage: Record<string, number> = {};
      for (const m of res.matches ?? []) {
        const md = m.metadata ?? {};
        const u = String(md.url ?? "");
        if (!u) continue;
        perPage[u] = (perPage[u] ?? 0) + 1;
        if (perPage[u] > PER_PAGE) continue;
        hits.push({
          score: m.score,
          url: u,
          title: String(md.title ?? u),
          body: String(md.body ?? ""),
        });
      }
      hits = hits.slice(0, MAX_SOURCES);
    } catch (e) {
      return json({ error: "Search is unavailable right now." }, 503);
    }

    // THE RESEARCH INDEX. Stephen, 2026-08-31: every piece of content in the
    // website, in SQL, and in the OpenAlex mirror must be reachable here. The
    // mirror holds over 700,000 works and none of it was reachable, because
    // this endpoint only ever searched Vectorize, which is built from the
    // site's own pages.
    //
    // Full text rather than embeddings: a GIN index over title and abstract
    // answers in about 4ms across the whole corpus, where embedding 700,000
    // works would cost days of compute to answer the same question worse. The
    // mirror grows every night and the index updates on insert, so a work is
    // searchable the day it arrives.
    //
    // LICENCE. Every row carries license_class 'metadata_cc0_abstract_cite_only'.
    // The metadata is CC0 and ours to publish; the abstract is the publisher's
    // and is passed to the model to READ, never to reproduce. The prompt says
    // so, and the answer links out to the DOI so the reader goes to the source.
    type Paper = { title: string; year: number | null; cited: number | null; url: string };
    let papers: Paper[] = [];
    if (env.AUDIT_DB) {
      try {
        const sql = postgres(env.AUDIT_DB.connectionString, {
          max: 1, fetch_types: false, idle_timeout: 10,
        });
        // THE QUESTION IS NOT THE QUERY. websearch_to_tsquery ANDs every word
        // it is given, so "What does academic research say about symbolic
        // chain of thought for faithful logical reasoning?" demanded that an
        // abstract contain "academic", "say" and "research" as well as the
        // real terms, and matched nothing. Measured against the corpus: that
        // sentence returns 0 rows, the same question stripped to its content
        // words returns the paper it was asking for. The box was refusing
        // questions while holding their answers, and the prompt got blamed
        // for it first.
        //
        // So the question is reduced to content words before it becomes a
        // query, and an OR pass with relevance ranking runs when the AND pass
        // finds nothing, because a long question should degrade to its best
        // matches rather than to silence.
        const STOP = new Set(("a an the what which who whom whose when where why how is are was were be been being do does did " +
          "of for to in on at by with from about into over after before between and or but if then than that this these those " +
          "say says said tell explain describe show give me my our your it its as can could should would will may might " +
          "research paper papers study studies academic literature evidence any some there their his her they we you i").split(" "));
        // CORPUS STOPWORDS. In a 700,000-work AI corpus, "artificial",
        // "intelligence" and their kin are stopwords in all but name: the
        // first pairwise-relaxation draft ranked by ts_rank_cd and returned
        // nursing AI-literacy surveys for the Einstein question, because
        // frequency ranking rewards a paper that says "artificial
        // intelligence" forty times. Measured live 2026-08-31 before this
        // rewrite. These words still count in the strict AND tier, where
        // co-occurrence with everything else keeps them honest; they are
        // excluded from the relaxation tiers, where they drown the terms
        // that carry the question.
        // IMPORTANT: the WHERE clauses below filter on the to_tsvector
        // EXPRESSION, not on the fts column, because the existing GIN index
        // twoai_works_fts_idx is built on that expression and Postgres will
        // not match a bare column to it. The stored fts column is used only
        // in the SELECT list for coverage ranking, where it is a cheap
        // column read instead of a per-row tsvector recomputation. That split
        // is what took the Einstein query from 12.3s to 51ms without needing
        // a second GIN index on 776k rows.
        const FTSX = "to_tsvector('english', coalesce(title,'') || ' ' || coalesce(abstract,''))";
        const CORPUS_STOP = new Set(("artificial intelligence machine learning model models data neural " +
          "network networks deep algorithm algorithms system systems human based using approach analysis").split(" "));
        const terms = question.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/)
          .filter((w) => w.length > 2 && !STOP.has(w)).slice(0, 12);
        const distinctive = terms.filter((w) => !CORPUS_STOP.has(w)).slice(0, 8);
        // TERM RARITY. Coverage ranking that treats every word alike returns
        // geology papers for an Einstein question: measured 2026-09-01 on the
        // live site, tier 3 returned five works, NONE containing "einstein",
        // including The Mechanics of Oblique Slip Faulting. Two causes. First,
        // "theory" and "influence" are near-universal in an academic corpus
        // while "einstein" appears in ~350 works, yet each counted 1. Second,
        // the Postgres english stemmer collapses relativity and relative to
        // one stem, so any abstract using "relative" scored a match on
        // "relativity". Counting is capped at 5000 rows per term so a common
        // word costs no more than a rare one; a term at the cap is common
        // enough that its exact frequency does not matter.
        let anchor = "";
        if (distinctive.length) {
          try {
            const counts = await sql.unsafe(
              distinctive.map((t, i) =>
                `SELECT ${i} AS i, count(*) AS n FROM (SELECT 1 FROM twoai_works
                 WHERE ${FTSX} @@ to_tsquery('english', '${t}') LIMIT 5000) x${i}`
              ).join(" UNION ALL "));
            let best = -1, bestN = Number.MAX_SAFE_INTEGER;
            for (const r of counts as any[]) {
              const n = Number(r.n);
              if (n > 0 && n < bestN) { bestN = n; best = Number(r.i); }
            }
            if (best >= 0) anchor = distinctive[best];
          } catch {
            /* Rarity is an improvement, not a dependency. */
          }
        }
        const andQuery = terms.join(" ");
        const orQuery = terms.join(" | ");
        // Coverage rank: how many DISTINCT distinctive terms a work matches,
        // computed as a sum of boolean matches on the stored fts column. This
        // is what ts_rank cannot give us: three different question words
        // beat one question word repeated forty times.
        const coverage = distinctive.length
          ? distinctive.map((t) => `(fts @@ to_tsquery('english', '${t}'))::int`).join(" + ")
          : "0";
        // The pair set is now ANCHORED: every clause requires the rarest
        // term. "einstein & theory | einstein & relativity | ..." rather than
        // any two words at all. A work that never mentions Einstein cannot
        // be an answer to a question about Einstein, however many generic
        // words it shares. When no anchor was determined we fall back to the
        // old unanchored pairs rather than returning nothing.
        const pairs: string[] = [];
        if (anchor) {
          for (const t of distinctive) if (t !== anchor) pairs.push(`(${anchor} & ${t})`);
        } else {
          for (let a = 0; a < distinctive.length; a++)
            for (let b = a + 1; b < distinctive.length; b++)
              pairs.push(`(${distinctive[a]} & ${distinctive[b]})`);
        }
        const pairQuery = pairs.join(" | ");
        // TIERS ARE ADDITIVE, not first-nonempty. Measured on the Einstein
        // question: the strict tiers return one tangential physics paper, and
        // stopping there would hand the model a single weak excerpt while the
        // corpus holds Minsky. Each tier tops the list up to 5, most precise
        // first, deduplicated on the OpenAlex link identity (doi, else
        // oa_url), so the order of the list is the order of confidence.
        let rows: any[] = [];
        const seen = new Set<string>();
        const take = (batch: any[]) => {
          for (const r of batch) {
            if (rows.length >= 5) break;
            const k = String(r.doi ?? r.oa_url ?? r.title ?? "");
            if (!k || seen.has(k)) continue;
            seen.add(k);
            rows.push(r);
          }
        };
        if (terms.length) {
          // TIER 1: every content word must co-occur. Highest precision;
          // the common case for short questions.
          take(await sql.unsafe(`
            SELECT title, pub_year, cited_by, doi, oa_url, abstract
            FROM twoai_works
            WHERE ${FTSX} @@ websearch_to_tsquery('english', $1)
            ORDER BY cited_by DESC NULLS LAST
            LIMIT 5`, [andQuery]));
          // TIER 2: AND of only the distinctive words. "How did Einstein's
          // theory of relativity influence artificial intelligence" becomes
          // einstein & theory & relativity & influence.
          if (rows.length < 5 && distinctive.length >= 2 && distinctive.length < terms.length) {
            take(await sql.unsafe(`
              SELECT title, pub_year, cited_by, doi, oa_url, abstract
              FROM twoai_works
              WHERE ${FTSX} @@ to_tsquery('english', $1)
              ORDER BY cited_by DESC NULLS LAST
              LIMIT 5`, [distinctive.join(" & ")]));
          }
          // TIER 3: any two distinctive words co-occurring, ranked by how
          // many distinctive words the work matches, then citations.
          // Ranking the full pair-match set costs 5.4s (measured, 86k rows
          // for the Einstein question). Capping candidates to the 400
          // most-cited pair matches first, then coverage-ranking those,
          // returns the same top papers in 51ms. The cap is a citation prior,
          // which for a reference site is the right bias: a work nobody cites
          // is not the answer we want to hand a reader.
          if (rows.length < 5 && pairs.length) {
            take(await sql.unsafe(`
              WITH cand AS (
                SELECT title, pub_year, cited_by, doi, oa_url, abstract, fts
                FROM twoai_works
                WHERE ${FTSX} @@ to_tsquery('english', $1)
                ORDER BY cited_by DESC NULLS LAST
                LIMIT 400)
              SELECT title, pub_year, cited_by, doi, oa_url, abstract,
                     (${coverage}) AS cov
              FROM cand
              ORDER BY cov DESC, cited_by DESC NULLS LAST
              LIMIT 5`, [pairQuery]));
          }
          // TIER 4: last resort, any single content word, relevance ranked.
          // Only when nothing above matched at all: a low-coverage single
          // word hit below real matches adds noise, not reach.
          if (!rows.length && terms.length > 2) {
            take(await sql.unsafe(`
              SELECT title, pub_year, cited_by, doi, oa_url, abstract,
                     ts_rank_cd(fts, to_tsquery('english', $1)) AS rank
              FROM twoai_works
              WHERE ${FTSX} @@ to_tsquery('english', $1)
              ORDER BY rank DESC, cited_by DESC NULLS LAST
              LIMIT 5`, [orQuery]));
          }
        }
        for (const r of rows as any[]) {
          const link = r.doi ? 'https://doi.org/' + String(r.doi) : String(r.oa_url ?? '');
          if (!link) continue;
          papers.push({
            title: String(r.title ?? '').slice(0, 300),
            year: r.pub_year ?? null,
            cited: r.cited_by ?? null,
            url: link,
          });
          researchExcerpts.push(
            '[R' + papers.length + '] ' + String(r.title ?? '') +
            (r.pub_year ? ' (' + r.pub_year + ')' : '') + ' ' + link + '\n' +
            String(r.abstract ?? '').slice(0, 1200));
        }
        ctx.waitUntil(sql.end());
      } catch {
        // A research outage must degrade the box to site pages, never break it.
      }
    }

    // HYBRID RESEARCH RETRIEVAL. Full text finds exact terms; it cannot find
    // "who founded the field" in a paper that says "the origins of machine
    // intelligence". When the works Vectorize index exists (pipeline stage
    // twoai_works_embed, phased highest-cited first), the same question
    // vector queries it and semantic hits fill the remaining paper slots.
    // Dedupe is by link, because the same work can arrive from both paths.
    if (env.WORKS_VECTORIZE && papers.length < 5) {
      try {
        const emb2 = await env.AI.run(EMBED_MODEL, { text: [question] });
        const wres = await env.WORKS_VECTORIZE.query(emb2.data[0], {
          topK: 5, returnMetadata: "all",
        });
        const have = new Set(papers.map((p) => p.url));
        for (const m of wres.matches ?? []) {
          if (papers.length >= 5) break;
          if (m.score < 0.5) continue;
          const md = m.metadata ?? {};
          const link = md.doi ? "https://doi.org/" + String(md.doi) : String(md.oa_url ?? "");
          if (!link || have.has(link)) continue;
          have.add(link);
          papers.push({
            title: String(md.title ?? "").slice(0, 300),
            year: md.pub_year ?? null,
            cited: md.cited_by ?? null,
            url: link,
          });
          researchExcerpts.push(
            "[R" + papers.length + "] " + String(md.title ?? "") +
            (md.pub_year ? " (" + md.pub_year + ")" : "") + " " + link + "\n" +
            String(md.abstract ?? "").slice(0, 1200));
        }
      } catch {
        /* Semantic leg is additive; its failure changes nothing. */
      }
    }

    const best = hits.length ? hits[0].score : 0;
    // Declared BEFORE log() so the refusal path can call log(false) safely.
    // Previously these sat below the refusal branch, and binding modelErrors
    // inside log threw a temporal-dead-zone ReferenceError on every refused
    // question, silently killing exactly the logging the refusal exists for.
    let usedModel = "";
    const modelErrors: string[] = [];

    // Day key in UTC. The ceiling is a single counter row per day; reading it
    // is one indexed lookup and incrementing is one upsert, both cheap next to
    // a model call. Table and row are created lazily so there is no migration
    // to keep in sync, matching how answer_log's columns are managed above.
    const dayKey = new Date().toISOString().slice(0, 10);
    const answeredToday = async (): Promise<number> => {
      try {
        await env.ASSISTANT_DB.exec(
          "CREATE TABLE IF NOT EXISTS answer_budget (day TEXT PRIMARY KEY, answered INTEGER NOT NULL DEFAULT 0)"
        );
        const row: any = await env.ASSISTANT_DB.prepare(
          "SELECT answered FROM answer_budget WHERE day = ?"
        ).bind(dayKey).first();
        return row ? Number(row.answered) || 0 : 0;
      } catch {
        // A counter that cannot be read must not shut the endpoint: fail OPEN
        // on the ceiling (the per-IP limiter and the Anthropic console cap are
        // the other two layers) rather than dark on a transient D1 error.
        return 0;
      }
    };
    const bumpAnswered = async () => {
      try {
        await env.ASSISTANT_DB.prepare(
          `INSERT INTO answer_budget (day, answered) VALUES (?, 1)
             ON CONFLICT(day) DO UPDATE SET answered = answered + 1`
        ).bind(dayKey).run();
      } catch {
        /* Best-effort; the read side already fails open. */
      }
    };

    const log = async (answered: boolean) => {
      // The columns are added here rather than in a migration because the
      // Worker is the only writer and a logging schema drift must never break
      // an answer. Both statements are no-ops once applied.
      try {
        await env.ASSISTANT_DB.exec("ALTER TABLE answer_log ADD COLUMN model_used TEXT");
      } catch {}
      try {
        await env.ASSISTANT_DB.exec("ALTER TABLE answer_log ADD COLUMN model_errors TEXT");
      } catch {}
      const verdict = await guard;
      const unsafe = verdict.toLowerCase().startsWith("unsafe");
      await env.ASSISTANT_DB.prepare(
        `INSERT INTO answer_log (question, question_norm, answered, best_score, top_url,
           guard_verdict, guard_categories, model_used, model_errors)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          question, norm, answered ? 1 : 0, best,
          hits.length ? hits[0].url : null,
          unsafe ? "unsafe" : verdict === "error" ? "error" : "safe",
          unsafe ? verdict.split("\n").slice(1).join(" ").trim() : null,
          answered ? usedModel : null,
          modelErrors.length ? modelErrors.join(" | ") : null
        )
        .run()
        .catch(() => {
          /* Logging is diagnostics, not the product. A failed insert must never
             reach the reader, and waitUntil already keeps it off the response
             path. */
        });
    };

    // A question the site has not covered may still be answerable from the
    // research index, so the refusal now requires BOTH retrievers to come back
    // empty. Papers alone are a thinner answer and it says so, but refusing
    // while holding a relevant paper would be the box lying about its reach.
    if ((!hits.length || best < SCORE_FLOOR) && !papers.length) {
      ctx.waitUntil(log(false));
      const notCovered =
        "The World of AI does not cover that yet. The question has been recorded, and topics that come up repeatedly get researched and published.";
      // WEB FALLBACK, added 2026-09-01 on Stephen's decision. It fires ONLY
      // here, on a genuine empty from both retrievers, which is why the tier-3
      // rarity fix had to land first: before it, tier 3 returned papers that
      // did not contain the question's rare term at all, so the box believed
      // it had coverage and this branch never ran on questions that needed it.
      const web = await webFallback(env, ANTHROPIC_MODEL, question, norm, hits.length, papers.length, qVec, best);
      if (web) {
        return json({
          answered: false,
          answer: notCovered,
          sources: [],
          web: web.text, webSources: web.sources, webCached: web.cached || undefined,
          webFetchedAt: web.fetchedAt,
        });
      }
      return json({ answered: false, answer: notCovered, sources: [], webError: lastWebError || undefined });
    }

    // Retrieval succeeded and we are about to spend on a model call. Check the
    // account-wide daily ceiling FIRST. Over the cap, return the not-covered
    // shape (200, answered:false) so the page shows its normal quiet state
    // rather than an error, and record the question so a real spike is visible
    // in the log the next morning.
    if ((await answeredToday()) >= DAILY_ANSWER_CAP) {
      ctx.waitUntil(log(false));
      return json({
        answered: false,
        answer:
          "The assistant has answered its limit of questions for today and is resting until tomorrow. Your question has been recorded. The pages it would have cited are still here to read and search.",
        sources: hits.map((h) => ({ title: h.title, url: h.url, score: h.score })),
        papers: papers.map((p) => ({ title: p.title, url: p.url, year: p.year, cited: p.cited })),
      });
    }

    const excerpts = hits
      .map((h, i) => `[${i + 1}] ${h.title} (${h.url})\n${h.body}`)
      .join("\n\n");

    const research = researchExcerpts.length
      ? `\n\nPapers from the research index (NOT pages on this site, cite by name and link, never reproduce an abstract):\n\n${researchExcerpts.join("\n\n")}`
      : "";
    const userContent = `Excerpts from theworldofai.org:\n\n${excerpts}${research}\n\nQuestion: ${question}\n\nAnswer using only the excerpts above.`;

    // Direct call to the Anthropic API. No Workers AI, no gateway, no partner
    // billing: just the key. Errors carry the HTTP status and the first slice
    // of the body, which is what turns "unavailable" into a diagnosable fault.
    const askAnthropicDirect = async (): Promise<string> => {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY!,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 700,
          system: SYSTEM,
          messages: [{ role: "user", content: userContent }],
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
      const out: any = await r.json();
      return String(
        Array.isArray(out?.content) ? out.content.map((c: any) => c?.text ?? "").join("") : ""
      ).trim();
    };

    const askWorkersAI = async (model: string): Promise<string> => {
      // Partner models take `system` top-level; @cf/ models take it in the
      // messages array. Both shapes verified against the model docs.
      const userTurn = { role: "user", content: userContent };
      const params: any = model.startsWith("@cf/")
        ? { max_tokens: 700, messages: [{ role: "system", content: SYSTEM }, userTurn] }
        : { max_tokens: 700, system: SYSTEM, messages: [userTurn] };
      const out: any = await env.AI.run(model, params);
      return String(
        out?.response ??
          (Array.isArray(out?.content) ? out.content.map((c: any) => c?.text ?? "").join("") : "")
      ).trim();
    };

    // Attempt order: direct Anthropic when the secret exists, the partner
    // route only when it does not (so unified billing enabled later just
    // works), llama always last so the box on the home page never dies.
    const attempts: Array<[string, () => Promise<string>]> = [];
    if (env.ANTHROPIC_API_KEY) {
      attempts.push([`anthropic-direct/${ANTHROPIC_MODEL}`, askAnthropicDirect]);
    } else {
      attempts.push([PARTNER_MODEL, () => askWorkersAI(PARTNER_MODEL)]);
    }
    attempts.push([FALLBACK_MODEL, () => askWorkersAI(FALLBACK_MODEL)]);

    let answer = "";
    let lastError = "";
    for (const [name, call] of attempts) {
      try {
        answer = await call();
        if (answer) {
          usedModel = name;
          break;
        }
        lastError = `${name}: empty response`;
        modelErrors.push(lastError);
      } catch (e: any) {
        lastError = `${name}: ${e?.message ?? String(e)}`;
        // A fallback nobody sees is a quality regression that hides itself.
        // Every failure is recorded per request in D1, so "which model is
        // actually answering, and why" is a query rather than an
        // investigation.
        modelErrors.push(lastError);
      }
    }
    if (!answer) {
      return json({ error: "The assistant is unavailable right now.", detail: lastError }, 503);
    }

    ctx.waitUntil(log(true));
    ctx.waitUntil(bumpAnswered());

    // THE BEYOND-OUR-SOURCES BLOCK. Stephen's explicit decision, 2026-08-31:
    // the model may add general-knowledge context, but only in a visually
    // separate, labelled block, never interleaved with cited claims and never
    // feeding the source list. The prompt asks for a marker line; this splits
    // on it, so even a model that ignores the placement rule cannot get
    // uncited prose into the sourced answer, and paper-citation matching runs
    // against the sourced portion only.
    let beyond = "";
    {
      const mIdx = answer.indexOf("BEYOND OUR SOURCES:");
      if (mIdx >= 0) {
        beyond = answer.slice(mIdx + "BEYOND OUR SOURCES:".length).trim();
        answer = answer.slice(0, mIdx).trim();
      }
    }

    // Sources are the pages actually retrieved, deduplicated, in rank order. An
    // answer without them would be an unsourced claim under our own domain.
    const seen = new Set<string>();
    const sources = hits
      .filter((h) => (seen.has(h.url) ? false : (seen.add(h.url), true)))
      .map((h) => ({ title: h.title, url: h.url, score: h.score }));

    // A SOURCE LIST MUST NAME WHAT THE ANSWER USED, AND NOTHING ELSE. The
    // first live test retrieved five relevant papers, the model answered
    // entirely from this site's own pages, and the box was about to render
    // all five under "Research papers" as though they were sources. Listing
    // a source an answer never used is the same failure as omitting one it
    // did: this box is worth having only because its source list is true.
    //
    // So papers are filtered to those the answer actually names. The model is
    // told to name them; this checks rather than trusts. Matching is on a
    // punctuation-stripped leading clause, because a model writes
    // "Faithful Logical Reasoning via Symbolic Chain-of-Thought" for a title
    // that carries a subtitle after a colon, and on any five-word run of the
    // title, which catches a shortened reference without matching on
    // "language models" alone.
    const flat = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
    const flatAnswer = flat(answer);
    const namedInAnswer = (title: string): boolean => {
      const ft = flat(title);
      if (!ft) return false;
      const lead = ft.split(" ").slice(0, 6).join(" ");
      if (lead.length > 12 && flatAnswer.includes(lead)) return true;
      const w = ft.split(" ");
      for (let i = 0; i + 5 <= w.length; i++) {
        const run = w.slice(i, i + 5).join(" ");
        if (run.length > 18 && flatAnswer.includes(run)) return true;
      }
      return false;
    };
    const citedPapers = papers.filter((pp) => namedInAnswer(pp.title));

    // THE SAME RULE, NOW APPLIED TO PAGES. Papers were filtered to those the
    // answer actually names; site pages were not, so every page retrieval
    // returned got listed as a source whether the answer leaned on it or not.
    // The visible symptom was three pages - Alan Turing, Fei-Fei Li, Eric
    // Nguyen - appearing under almost every question. They are not a bug in
    // the index: they are long, well-written, broad AI prose, so they sit near
    // the centre of the embedding space and are genuinely close to most AI
    // questions. Hub documents. Retrieving them is correct; CITING them when
    // the answer never used them is not, and it makes the source list look
    // padded, which is the one thing this box cannot afford.
    //
    // Rule 2 of the system prompt already tells the model to name the pages it
    // uses, so this checks rather than trusts. If the filter would empty the
    // list entirely the top-scoring page is kept, because an answer that came
    // from somewhere must show somewhere.
    const namedSources = sources.filter((s) => namedInAnswer(s.title));
    const shownSources = namedSources.length ? namedSources : sources.slice(0, 1);

    // THE SECOND REFUSAL PATH. Measured live 2026-09-01: the Einstein question
    // retrieved seven site pages and a quantum computing paper, so the
    // retrieval-empty branch above never ran - and then the MODEL refused,
    // correctly, because none of it answers the question. That is still a gap,
    // and a reader who is told "we do not cover that" while the box quietly
    // holds a web answer it declined to fetch is the exact failure this
    // fallback exists to prevent. Retrieval finding SOMETHING is not the same
    // as retrieval ANSWERING, and only the model can tell the two apart, so
    // the refusal it writes is the signal we key on.
    if (/does not cover that yet/i.test(answer)) {
      // TIER 2: WIKIDATA, ahead of any web search. Free, so no cap and no
      // budget counter, and CC0, so unlike a publisher's prose these claims
      // can eventually be published on our own pages rather than only cited.
      // Verified live against Q15733006: "who founded DeepMind" resolves to
      // Google DeepMind and returns Demis Hassabis and Shane Legg with the
      // founding year, headquarters, parent and employee count.
      // FREE STRUCTURED TIERS, in order, before anything that costs money.
      // Each returns null unless the question is its shape, so a model
      // question never gets an author profile and vice versa - a confident
      // profile of the wrong subject is worse than no answer.
      const subject = subjectOf(question);
      // OUR OWN DATABASE FIRST, even for the free tiers. A structured answer we
      // have already stored is served from Postgres rather than fetched again:
      // once we have looked something up and kept it, the answer comes from
      // us. Only on a miss do we go out to Wikidata and the rest.
      const cached = await cachedLookup(env, norm, qVec);
      if (cached && (cached.wikidata || cached.lookup)) {
        return json({
          answered: false, answer, sources: shownSources, papers: [],
          wikidata: cached.wikidata, lookup: cached.lookup,
          lookupCached: true, lookupFetchedAt: cached.fetchedAt,
        });
      }
      const wd = await wikidataLookup(question);
      const alt = wd ? null : (await huggingFaceModel(subject, question)) ?? (await openAlexAuthor(subject, question));
      if (wd || alt) {
        // Retain what we looked up. Runs in waitUntil so the reader is not
        // waiting on bookkeeping, and every fact lands as `proposed` for
        // review rather than on a page.
        const recorded: Array<{ sourceLabel: string; title: string; url: string; facts: any[] }> = [];
        if (wd) recorded.push({ sourceLabel: "Wikidata " + wd.qid, title: wd.title, url: wd.url, facts: wd.facts });
        if (alt) recorded.push({ sourceLabel: alt.sourceLabel, title: alt.title, url: alt.url, facts: alt.facts });
        ctx.waitUntil(recordLookup(env, question, norm, hits.length, papers.length, qVec, best, recorded,
          { wikidata: wd ?? undefined, lookup: alt ?? undefined }));
        // PROMOTE. Stephen's instruction: after a lookup, the information goes
        // onto the company's page. Only Wikidata promotes - it is CC0, so its
        // claims can be published rather than merely cited, which is not true
        // of the web-search tier or of a model card. Runs in waitUntil so the
        // reader is not held up, and the page itself changes on the next
        // pipeline build, not instantly, because pages are rendered from SQL.
        if (wd) ctx.waitUntil(promoteFacts(env, wd).then((r) => console.log("promote:", r)));
        return json({
          answered: false, answer, sources: shownSources, papers: [],
          wikidata: wd ?? undefined, lookup: alt ?? undefined,
          lookupFetchedAt: new Date().toISOString(),
        });
      }
      const web2 = await webFallback(env, ANTHROPIC_MODEL, question, norm, hits.length, papers.length, qVec, best);
      if (web2) {
        return json({
          answered: false, answer, sources: shownSources, papers: [],
          web: web2.text, webSources: web2.sources, webCached: web2.cached || undefined,
          webFetchedAt: web2.fetchedAt,
        });
      }
      return json({ answered: false, answer, sources: shownSources, papers: [], webError: lastWebError || undefined });
    }

    // Diagnostic ride-alongs removed 2026-08-19 after doing their job twice:
    // first captured "2021: Invalid User Credentials" (partner routing had no
    // Anthropic billing path), then key_present exposed that five dashboard
    // attempts were writing BUILD variables, not runtime secrets. The working
    // path was `wrangler secret put ANTHROPIC_API_KEY`. Failures stay
    // queryable in answer_log.model_errors.
    return json({ answered: true, answer, beyond: beyond || undefined, sources: shownSources, papers: citedPapers, model: usedModel });
  },
};
