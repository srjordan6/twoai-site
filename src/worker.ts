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
 *  - It never reaches the web. When the site does not cover something it says
 *    so and logs the question, because a logged gap gets researched and
 *    published once for everyone, while a guess helps one person unverifiably
 *    and puts an unsourced claim under our own domain name.
 *  - It never returns an answer without the pages it came from.
 */

interface Env {
  AI: any;
  VECTORIZE: any;
  ASSISTANT_DB: D1Database;
  ASSETS: { fetch: (req: Request) => Promise<Response> };
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
const TOP_K = 12;      // over-fetch, then cap per page
const PER_PAGE = 2;    // at most two chunks from any one page
const MAX_SOURCES = 6;

const SYSTEM = `You answer questions about artificial intelligence using ONLY the excerpts provided from theworldofai.org.

RULES, in order:
1. Use only what is in the excerpts. If they do not answer the question, say plainly: "The World of AI does not cover that yet." Do not fill the gap from your own knowledge, and never guess a date, a number, a case outcome or a legal requirement.
2. Cite the pages you used by their titles, naturally, in the sentence that uses them.
3. Be brief. Two or three short paragraphs at most. Lead with the answer.
4. Where the excerpts disagree or are dated, say so rather than smoothing it over.
5. Plain English. No hype. Commas rather than dashes.
6. You are a reference work, not a salesperson and not a lawyer. Never give legal advice; report what the sources say and note that the primary source should be checked for anything that matters.`;

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
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

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

    let hits: Array<{ score: number; url: string; title: string; body: string }> = [];
    try {
      const emb = await env.AI.run(EMBED_MODEL, { text: [question] });
      const vector = emb.data[0];
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

    const best = hits.length ? hits[0].score : 0;
    // Declared BEFORE log() so the refusal path can call log(false) safely.
    // Previously these sat below the refusal branch, and binding modelErrors
    // inside log threw a temporal-dead-zone ReferenceError on every refused
    // question, silently killing exactly the logging the refusal exists for.
    let usedModel = "";
    const modelErrors: string[] = [];
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

    if (!hits.length || best < SCORE_FLOOR) {
      ctx.waitUntil(log(false));
      return json({
        answered: false,
        answer:
          "The World of AI does not cover that yet. The question has been recorded, and topics that come up repeatedly get researched and published.",
        sources: [],
      });
    }

    const excerpts = hits
      .map((h, i) => `[${i + 1}] ${h.title} (${h.url})\n${h.body}`)
      .join("\n\n");

    const userContent = `Excerpts from theworldofai.org:\n\n${excerpts}\n\nQuestion: ${question}\n\nAnswer using only the excerpts above.`;

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

    // Sources are the pages actually retrieved, deduplicated, in rank order. An
    // answer without them would be an unsourced claim under our own domain.
    const seen = new Set<string>();
    const sources = hits
      .filter((h) => (seen.has(h.url) ? false : (seen.add(h.url), true)))
      .map((h) => ({ title: h.title, url: h.url, score: h.score }));

    // Diagnostic ride-along removed 2026-08-19: it did its job (captured
    // "2021: Invalid User Credentials" live). Failures stay queryable in
    // answer_log.model_errors; the public response names only the model that
    // answered.
    // TEMPORARY DIAGNOSTIC (again): key was added but llama still serves.
    // key_present distinguishes "secret not visible to the Worker" from "the
    // direct call fails". Remove after one probe.
    return json({ answered: true, answer, sources, model: usedModel,
      key_present: Boolean(env.ANTHROPIC_API_KEY),
      model_errors: modelErrors.length ? modelErrors : undefined });
  },
};
