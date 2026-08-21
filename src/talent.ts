/**
 * The AI Talent Network — write path.
 *
 * Static pages render the directory; this module handles the four actions a
 * profile needs: sign up, confirm the address, submit the form, upload a
 * resume. State lives in D1 (the Worker cannot cross the one-IP allow list to
 * Postgres); the pipeline mirrors D1 into talent_profiles daily, Stephen
 * approves in SQL, and the next build renders approved profiles. Postgres is
 * the source of truth for everything PUBLISHED; D1 is the intake tray.
 *
 * PRIVACY DECISIONS, fixed 2026-08-21 and load-bearing:
 *  - The public page shows first name only. The TAI id is the identity.
 *  - Email and resume are never rendered anywhere. Resume goes to a PRIVATE
 *    R2 bucket, never the content bus.
 *  - Contact is relayed: mail theworldofai@inkboxmail.com with the TAI id in
 *    the subject. No address on any page means nothing to scrape.
 *  - Profiles renew every 30 days by email or come down, and coming down
 *    PURGES the PII while keeping the row as a tombstone.
 *
 * EVERY DEPENDENCY IS OPTIONAL AT RUNTIME. Missing secret or binding degrades
 * that one action to a clear 503, never a crash and never a silent success:
 * a dark launch is deliberate (code ships first, secrets follow).
 */

interface TalentEnv {
  ASSISTANT_DB: D1Database;
  TALENT_R2?: R2Bucket;
  INKBOX_KEY_THEWORLDOFAI?: string;
  TURNSTILE_SECRET?: string;
  TALENT_RATE?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
}

const MAILBOX = "theworldofai@inkboxmail.com";
const INKBOX_SEND = `https://inkbox.ai/api/v1/mail/mailboxes/${encodeURIComponent(MAILBOX)}/messages`;
const SITE = "https://theworldofai.org";
// Unambiguous alphabet: no 0/O, 1/I/L, so the id survives being read aloud.
const ID_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const RESUME_MAX = 5 * 1024 * 1024;

const QUESTION_KEYS = new Set([
  "models", "frameworks", "vector-dbs", "observability", "evaluation",
  "guardrails", "governance-frameworks", "deployment", "experience-years", "role-type",
]);
const AVAILABILITY = new Set(["open", "freelance", "not-looking", ""]);

const tJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": SITE,
      "cache-control": "no-store",
    },
  });

function randomFrom(alphabet: string, n: number): string {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

async function ensureSchema(db: D1Database): Promise<void> {
  await db.exec(
    "CREATE TABLE IF NOT EXISTS talent_state (tai_id TEXT PRIMARY KEY, email TEXT NOT NULL, confirm_token TEXT, confirmed_at TEXT, status TEXT NOT NULL DEFAULT 'pending_confirm', profile TEXT NOT NULL DEFAULT '{}', answers TEXT NOT NULL DEFAULT '{}', resume_key TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))"
  );
}

async function verifyTurnstile(env: TalentEnv, token: string, ip: string): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return false; // no secret, no signups: bots would flood an open form
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }),
    });
    const out = (await r.json()) as { success?: boolean };
    return out.success === true;
  } catch {
    return false;
  }
}

// Returns "" on success, otherwise a short reason. The first live test failed
// with only "Signups are not open yet" because every failure path collapsed to
// false: secret absent, header rejected, HTTP refusal and network error were
// indistinguishable, which is the silent-failure shape this codebase keeps
// paying for. The reason string is safe to surface (no key material, no
// recipient) and each failure logs the Inkbox response for Workers Logs.
async function sendMail(env: TalentEnv, to: string, subject: string, text: string): Promise<string> {
  // A key pasted at a PowerShell prompt can carry a trailing CR; fetch throws
  // on a header value containing \r and the catch below would eat it.
  const key = (env.INKBOX_KEY_THEWORLDOFAI || "").trim();
  if (!key) return "mail_key_missing";
  try {
    const r = await fetch(INKBOX_SEND, {
      method: "POST",
      headers: { "X-API-Key": key, "content-type": "application/json" },
      body: JSON.stringify({ recipients: { to: [to] }, subject, body_text: text }),
    });
    if (r.status === 201 || r.status === 200) return "";
    console.log("talent sendMail refused:", r.status, (await r.text()).slice(0, 300));
    return "mail_http_" + r.status;
  } catch (e) {
    console.log("talent sendMail network:", String(e).slice(0, 200));
    return "mail_network";
  }
}

const str = (v: unknown, max: number): string =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

export async function handleTalent(request: Request, env: TalentEnv): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": SITE,
        "access-control-allow-headers": "content-type",
        "access-control-allow-methods": "GET, POST, OPTIONS",
      },
    });
  }

  // One shared per-IP limiter across all talent actions. Signups cost an
  // outbound email each, so the budget protected here is Inkbox's org send
  // quota (100 recipients/day) as much as our own.
  if (env.TALENT_RATE && request.method === "POST") {
    try {
      const ip = request.headers.get("cf-connecting-ip") || "unknown";
      const { success } = await env.TALENT_RATE.limit({ key: ip });
      if (!success) return tJson({ error: "Too many requests. Wait a minute and try again." }, 429);
    } catch { /* limiter failure never blocks a person */ }
  }

  await ensureSchema(env.ASSISTANT_DB);

  // ---- POST /api/talent/signup {email, turnstile} --------------------------
  if (path === "/api/talent/signup" && request.method === "POST") {
    let email = "", turnstile = "";
    try {
      const b = (await request.json()) as { email?: string; turnstile?: string };
      email = str(b.email, 254).toLowerCase();
      turnstile = str(b.turnstile, 4096);
    } catch { return tJson({ error: "Bad request" }, 400); }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return tJson({ error: "Enter a valid email address." }, 400);
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    if (!(await verifyTurnstile(env, turnstile, ip))) {
      return tJson({ error: "Verification failed. Reload the page and try again." }, 400);
    }

    // One live profile per address. The response is identical whether the
    // address is new or already registered: signup must not be an oracle for
    // who is in the directory.
    const existing = await env.ASSISTANT_DB.prepare(
      "SELECT tai_id, status, confirm_token FROM talent_state WHERE lower(email)=? AND status NOT IN ('deleted','expired') LIMIT 1"
    ).bind(email).first<{ tai_id: string; status: string; confirm_token: string | null }>();

    let taiId: string, token: string;
    if (existing) {
      taiId = existing.tai_id;
      token = existing.confirm_token || randomFrom("abcdefghijklmnopqrstuvwxyz0123456789", 48);
      await env.ASSISTANT_DB.prepare(
        "UPDATE talent_state SET confirm_token=?, updated_at=datetime('now') WHERE tai_id=?"
      ).bind(token, taiId).run();
    } else {
      token = randomFrom("abcdefghijklmnopqrstuvwxyz0123456789", 48);
      for (let attempt = 0; ; attempt++) {
        taiId = "TAI-" + randomFrom(ID_ALPHABET, 6);
        try {
          await env.ASSISTANT_DB.prepare(
            "INSERT INTO talent_state (tai_id, email, confirm_token) VALUES (?,?,?)"
          ).bind(taiId, email, token).run();
          break;
        } catch (e) {
          if (attempt >= 4) return tJson({ error: "Could not create a profile id. Try again." }, 500);
        }
      }
    }

    const link = `${SITE}/talent/join/?t=${token}`;
    const mailErr = await sendMail(env, email,
      "Confirm your AI Talent Network profile",
      `You (or someone using this address) asked to join the AI Talent Network on theworldofai.org.\n\nYour profile id is ${taiId}.\n\nConfirm your address and fill in your profile here:\n${link}\n\nThe link keeps working until you finish. If this wasn't you, ignore this email and nothing is published.\n\nQuestions: reply to this email.\n— The World of AI`);
    if (mailErr) return tJson({ error: "Signups are not open yet. Try again later.", reason: mailErr }, 503);

    return tJson({ ok: true, message: "Check your email for a confirmation link." });
  }

  // ---- GET /api/talent/session?t= ------------------------------------------
  if (path === "/api/talent/session" && request.method === "GET") {
    const t = str(url.searchParams.get("t"), 64);
    if (!t) return tJson({ error: "Missing token" }, 400);
    const row = await env.ASSISTANT_DB.prepare(
      "SELECT tai_id, email, status, profile, answers, resume_key, confirmed_at FROM talent_state WHERE confirm_token=? LIMIT 1"
    ).bind(t).first<{ tai_id: string; email: string; status: string; profile: string; answers: string; resume_key: string | null; confirmed_at: string | null }>();
    if (!row) return tJson({ error: "This link is not valid. Sign up again to get a fresh one." }, 404);

    // Opening the link IS the confirmation: possession of the mailbox proven.
    if (!row.confirmed_at) {
      await env.ASSISTANT_DB.prepare(
        "UPDATE talent_state SET confirmed_at=datetime('now'), status='confirmed', updated_at=datetime('now') WHERE tai_id=?"
      ).bind(row.tai_id).run();
      row.status = "confirmed";
    }
    const at = row.email.indexOf("@");
    const masked = row.email.slice(0, Math.min(2, at)) + "…" + row.email.slice(at);
    let profile = {}, answers = {};
    try { profile = JSON.parse(row.profile); } catch {}
    try { answers = JSON.parse(row.answers); } catch {}
    return tJson({
      tai_id: row.tai_id, email_masked: masked, status: row.status,
      profile, answers, has_resume: !!row.resume_key,
    });
  }

  // ---- POST /api/talent/submit {t, profile, answers} -----------------------
  if (path === "/api/talent/submit" && request.method === "POST") {
    let b: any;
    try { b = await request.json(); } catch { return tJson({ error: "Bad request" }, 400); }
    const t = str(b.t, 64);
    if (!t) return tJson({ error: "Missing token" }, 400);
    const row = await env.ASSISTANT_DB.prepare(
      "SELECT tai_id, status FROM talent_state WHERE confirm_token=? LIMIT 1"
    ).bind(t).first<{ tai_id: string; status: string }>();
    if (!row) return tJson({ error: "This link is not valid." }, 404);

    const p = b.profile || {};
    const availability = str(p.availability, 20);
    const profile = {
      first_name: str(p.first_name, 60),
      headline: str(p.headline, 140),
      location: str(p.location, 80),
      availability: AVAILABILITY.has(availability) ? availability : "",
      rate: str(p.rate, 60),
      // Free-text background, any country's employers and institutions.
      // Reviewed by a person like everything else before any of it renders.
      work_experience: str(p.work_experience, 4000),
      education: str(p.education, 4000),
      publications: str(p.publications, 4000),
    };

    const answers: Record<string, { selections: string[]; na: boolean; other: string }> = {};
    if (b.answers && typeof b.answers === "object") {
      for (const [k, vRaw] of Object.entries(b.answers as Record<string, any>)) {
        if (!QUESTION_KEYS.has(k)) continue;
        const v = vRaw || {};
        const selections = Array.isArray(v.selections)
          ? v.selections.filter((s: unknown) => typeof s === "string").map((s: string) => s.slice(0, 120)).slice(0, 40)
          : [];
        answers[k] = { selections, na: v.na === true, other: str(v.other, 200) };
      }
    }

    await env.ASSISTANT_DB.prepare(
      "UPDATE talent_state SET profile=?, answers=?, status='submitted', updated_at=datetime('now') WHERE tai_id=?"
    ).bind(JSON.stringify(profile), JSON.stringify(answers), row.tai_id).run();

    return tJson({ ok: true, tai_id: row.tai_id, message: "Submitted. Profiles are reviewed by a person before they go live." });
  }

  // ---- POST /api/talent/resume?t=  (body: application/pdf) -----------------
  if (path === "/api/talent/resume" && request.method === "POST") {
    if (!env.TALENT_R2) return tJson({ error: "Resume upload is not open yet. Your profile works without it." }, 503);
    const t = str(url.searchParams.get("t"), 64);
    if (!t) return tJson({ error: "Missing token" }, 400);
    const row = await env.ASSISTANT_DB.prepare(
      "SELECT tai_id FROM talent_state WHERE confirm_token=? LIMIT 1"
    ).bind(t).first<{ tai_id: string }>();
    if (!row) return tJson({ error: "This link is not valid." }, 404);

    const len = Number(request.headers.get("content-length") || "0");
    if (len > RESUME_MAX) return tJson({ error: "PDF too large. 5 MB maximum." }, 413);
    const body = new Uint8Array(await request.arrayBuffer());
    if (body.byteLength > RESUME_MAX) return tJson({ error: "PDF too large. 5 MB maximum." }, 413);
    // Magic bytes, not the client's content-type header: %PDF
    if (body.byteLength < 4 || body[0] !== 0x25 || body[1] !== 0x50 || body[2] !== 0x44 || body[3] !== 0x46) {
      return tJson({ error: "Only PDF files are accepted." }, 415);
    }
    const key = `talent/${row.tai_id}/resume.pdf`;
    await env.TALENT_R2.put(key, body, { httpMetadata: { contentType: "application/pdf" } });
    await env.ASSISTANT_DB.prepare(
      "UPDATE talent_state SET resume_key=?, updated_at=datetime('now') WHERE tai_id=?"
    ).bind(key, row.tai_id).run();
    return tJson({ ok: true, message: "Resume received. It is never shown publicly." });
  }

  return tJson({ error: "Not found" }, 404);
}
