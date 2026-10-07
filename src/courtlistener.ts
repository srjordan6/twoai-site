// COURTLISTENER DOCKET ALERT WEBHOOKS, 2026-10-07 (bridge rows 526 and 527).
//
// Stephen took a CourtListener Tier 1 membership, which has unlimited docket
// alerts. With an alert on a docket CourtListener POSTs every new entry here
// within seconds of the filing, so the tracker no longer has to poll for it
// out of a daily allowance of calls.
//
// THIS ROUTE ONLY STORES. The Worker's Postgres role is read only, so the
// raw event goes into D1 (cl_webhooks) and the pipeline stage cl_webhooks
// pulls it into srj_audit and applies it to the case (srj-pipeline,
// courtlistener_alerts.go), the same inbox pattern as answer_log. Storing is
// all there is time for anyway: CourtListener abandons a delivery after
// three seconds and retries it later.
//
// WHO MAY POST. CourtListener publishes no signature for webhooks. Its
// documentation names two things instead, and both are required here:
//   - the request comes from one of its two sending addresses,
//     34.210.230.218 and 54.189.59.91 (CL_WEBHOOK_IPS overrides, comma
//     separated, in case they ever change);
//   - the URL carries a long random secret, CL_WEBHOOK_SECRET, set with
//     `npx wrangler secret put CL_WEBHOOK_SECRET` and entered once as part of
//     the endpoint URL on CourtListener's webhooks page.
// Anything else is answered 404, the same as a path that does not exist.
// Each event carries an Idempotency-Key, unique in the table, so a retried
// delivery is stored once.

interface CLEnv {
  ASSISTANT_DB: D1Database;
  CL_WEBHOOK_SECRET?: string;
  CL_WEBHOOK_IPS?: string;
}

const CL_SENDERS = ["34.210.230.218", "54.189.59.91"];
const CL_MAX_BODY = 2_000_000;

let clTableReady = false;

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

// sameSecret compares without stopping at the first difference.
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function handleCLWebhook(request: Request, env: CLEnv): Promise<Response> {
  const secret = env.CL_WEBHOOK_SECRET || "";
  const given = new URL(request.url).pathname.replace(/^\/api\/cl-webhook\/?/, "").replace(/\/$/, "");
  // No secret configured means the route is off, never open.
  if (secret.length < 24 || !sameSecret(given, secret)) return notFound();
  const senders = (env.CL_WEBHOOK_IPS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const allowed = senders.length ? senders : CL_SENDERS;
  const ip = request.headers.get("cf-connecting-ip") || "";
  if (!allowed.includes(ip)) return notFound();
  if (request.method !== "POST") return new Response("POST only", { status: 405 });

  const body = await request.text();
  if (body.length > CL_MAX_BODY) return new Response("too large", { status: 413 });
  let eventType: number | null = null;
  try {
    const parsed = JSON.parse(body);
    const t = parsed?.webhook?.event_type;
    if (typeof t === "number") eventType = t;
  } catch {
    // Kept as received: the pipeline marks it unreadable rather than losing it.
  }
  const key = request.headers.get("idempotency-key") || crypto.randomUUID();
  try {
    if (!clTableReady) {
      await env.ASSISTANT_DB.exec(
        "CREATE TABLE IF NOT EXISTS cl_webhooks (received_at TEXT NOT NULL, idempotency_key TEXT UNIQUE, ip TEXT, event_type INTEGER, body TEXT NOT NULL)",
      );
      clTableReady = true;
    }
    await env.ASSISTANT_DB.prepare(
      "INSERT OR IGNORE INTO cl_webhooks (received_at, idempotency_key, ip, event_type, body) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(new Date().toISOString(), key, ip, eventType, body)
      .run();
  } catch (e) {
    // A 5xx makes CourtListener retry the delivery later, which is what a
    // storage fault should cause.
    console.log("cl-webhook store failed", String(e).slice(0, 200));
    return new Response("store failed", { status: 503 });
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
