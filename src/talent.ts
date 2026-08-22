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
  RESEND_API_KEY?: string;
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
  "models", "frameworks", "agents-mcp", "languages", "apis-integrations",
  "datasets", "infrastructure-hardware", "vector-dbs", "observability", "evaluation",
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
  // Additive migrations: D1 has no IF NOT EXISTS for columns, so each ALTER
  // runs once and thereafter fails with "duplicate column", which is the
  // success condition. Data is never dropped, matching the platform rule.
  for (const col of [
    "pw_salt TEXT", "pw_hash TEXT",
    "pii TEXT NOT NULL DEFAULT '{}'",
    "share_pdf INTEGER NOT NULL DEFAULT 0",
    "photo_type TEXT",
  ]) {
    try { await db.exec(`ALTER TABLE talent_state ADD COLUMN ${col}`); } catch { /* exists */ }
  }
}

// PBKDF2-SHA-256, 100k iterations, per-account random salt, via WebCrypto -
// no dependency, constant-time comparison through crypto.subtle output
// equality on hex strings of fixed length.
// Constant-time string equality for secrets (password hashes, owner tokens).
// A plain !== short-circuits at the first differing character, which is the
// timing side channel SAST flags; Workers ships timingSafeEqual, with an
// XOR-accumulate fallback so the property survives any runtime change.
// Resume-facing skill categories in form order. Mirrors
// talent_questions.short_label (single source is SQL; this copy exists
// because the renderers run in the Worker without a database round trip).
const SKILL_CATS: [string, string][] = [
  ["models", "Foundation Models"],
  ["frameworks", "Application Frameworks"],
  ["agents-mcp", "AI Agents & MCP"],
  ["languages", "Programming Languages & ML Frameworks"],
  ["apis-integrations", "AI APIs & Integrations"],
  ["datasets", "AI Datasets"],
  ["infrastructure-hardware", "AI Infrastructure & Hardware"],
  ["vector-dbs", "Vector Stores & Search"],
  ["observability", "LLM Observability"],
  ["evaluation", "Evaluation Frameworks"],
  ["guardrails", "Guardrails & Safety"],
  ["governance-frameworks", "AI Governance & Compliance"],
  ["deployment", "Cloud AI Platforms & Deployment"],
  ["role-type", "Roles"],
];

function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a), bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  const subtle = crypto.subtle as unknown as { timingSafeEqual?: (x: ArrayBufferView, y: ArrayBufferView) => boolean };
  if (typeof subtle.timingSafeEqual === "function") return subtle.timingSafeEqual(ab, bb);
  let d = 0;
  for (let i = 0; i < ab.length; i++) d |= ab[i] ^ bb[i];
  return d === 0;
}

async function hashPassword(password: string, saltHex: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const salt = new Uint8Array((saltHex.match(/../g) || []).map((h) => parseInt(h, 16)));
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
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
  // Resend first: mail leaves as talent@theworldofai.org, DKIM-signed on our
  // own domain (records verified 2026-08-21), so it lands in inboxes instead
  // of spam the way inkboxmail.com's shared reputation does. Replies still
  // flow to the Inkbox agent mailbox via Reply-To, keeping the relay intact.
  const rk = (env.RESEND_API_KEY || "").trim();
  if (rk) {
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: "Bearer " + rk, "content-type": "application/json" },
        body: JSON.stringify({
          from: "The World of AI <talent@theworldofai.org>",
          to: [to], subject, text, reply_to: MAILBOX,
        }),
      });
      if (r.ok) return "";
      console.log("talent sendMail resend refused:", r.status, (await r.text()).slice(0, 300));
      // Fall through to Inkbox rather than failing the signup outright.
    } catch (e) {
      console.log("talent sendMail resend network:", String(e).slice(0, 200));
    }
  }
  // A key pasted at a PowerShell prompt can carry a trailing CR; fetch throws
  // on a header value containing \r and the catch below would eat it.
  const key = (env.INKBOX_KEY_THEWORLDOFAI || "").trim();
  if (!key) return rk ? "mail_resend_failed" : "mail_key_missing";
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

// Weekly match digest, called from the Worker's scheduled handler. Reads the
// public matches feed the pipeline publishes, joins member emails from D1
// (live members only; addresses never leave this Worker), and sends one short
// digest per member with links to the original postings. Caps sends per run
// well inside Resend's free daily limit.
export async function talentWeeklyDigest(env: TalentEnv): Promise<void> {
  try {
    const r = await fetch("https://theworldofai.org/api/talent-matches.json", {
      headers: { "user-agent": "twoai-worker-digest" },
    });
    if (!r.ok) { console.log("digest: matches feed http", r.status); return; }
    const feed = await r.json() as { members?: Record<string, { first_name?: string; matches?: { title: string; company: string; url: string; location?: string; remote?: boolean }[] }> };
    const members = feed.members || {};
    const ids = Object.keys(members).filter((id) => (members[id].matches || []).length > 0);
    if (ids.length === 0) return;
    const rows = await env.ASSISTANT_DB.prepare(
      "SELECT tai_id, email FROM talent_state WHERE status='live'"
    ).all<{ tai_id: string; email: string }>();
    const emailOf = new Map((rows.results || []).map((x) => [x.tai_id, x.email]));
    let sent = 0;
    for (const id of ids) {
      if (sent >= 50) break;
      const to = emailOf.get(id);
      if (!to) continue;
      const m = members[id];
      const lines = (m.matches || []).slice(0, 8).map((j) =>
        `- ${j.title} — ${j.company}${j.location ? ", " + j.location : ""}${j.remote ? " (Remote)" : ""}\n  ${j.url}`);
      const err = await sendMail(env, to,
        "This week's roles matching your AI Talent profile",
        `Hi${m.first_name ? " " + m.first_name : ""},\n\nFresh openings matching the skills on your profile, pulled from company job boards this week:\n\n${lines.join("\n\n")}\n\nYour full match list: https://theworldofai.org/talent/${id.toLowerCase()}/\n\nEvery link goes to the employer's original posting. To stop these digests, reply with the word stop.\n— The World of AI`);
      if (err) console.log("digest:", id, err); else sent++;
    }
    console.log("digest: sent", sent, "of", ids.length, "eligible");
  } catch (e) {
    console.log("digest error:", String(e).slice(0, 200));
  }
}

// ---------------------------------------------------------------------------
// Automated mailbox answering. A cron every five minutes reads unread inbound
// mail on the relay mailbox and answers through the same Haiku RAG pipeline
// that powers /api/ask, replying in-thread from the relay address. Rules that
// keep this safe:
//  - Member-relay mail (a TAI id in the subject) is NEVER auto-answered;
//    it is starred and left for a person, because it is addressed to a
//    member, not to the site.
//  - Bounce/auto-reply senders are skipped to prevent loops, and each
//    message id is answered at most once (D1 ledger), even if mark-read
//    ever fails.
//  - "Not covered" questions get one honest holding reply and a star so a
//    person follows up; the assistant never guesses in mail any more than
//    it does on the site.
const MAIL_ANSWER_CAP = 5;
const SKIP_SENDER = /no-?reply|mailer-daemon|postmaster|notification|bounce|do-?not-?reply/i;
const SKIP_SUBJECT = /^(auto:|automatic reply|autoreply|out of office|delivery status|undeliver)/i;

export async function talentMailAnswer(env: TalentEnv): Promise<void> {
  const key = (env.INKBOX_KEY_THEWORLDOFAI || "").trim();
  if (!key) return;
  const base = `https://inkbox.ai/api/v1/mail/mailboxes/${encodeURIComponent(MAILBOX)}/messages`;
  const H = { "X-API-Key": key, "content-type": "application/json" };
  try {
    await env.ASSISTANT_DB.exec(
      "CREATE TABLE IF NOT EXISTS talent_mail_log (message_id TEXT PRIMARY KEY, from_addr TEXT, subject TEXT, action TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))"
    );
    const lr = await fetch(base + "?limit=25", { headers: H });
    if (!lr.ok) { console.log("mail-answer list http", lr.status); return; }
    const list = (await lr.json()) as { items?: any[] };
    const inbound = (list.items || []).filter((m) => m.direction === "inbound" && m.is_read === false);
    let handled = 0;
    for (const m of inbound) {
      if (handled >= MAIL_ANSWER_CAP) break;
      const already = await env.ASSISTANT_DB.prepare(
        "SELECT 1 FROM talent_mail_log WHERE message_id=?").bind(m.id).first();
      if (already) continue;
      const log = (action: string) => env.ASSISTANT_DB.prepare(
        "INSERT OR IGNORE INTO talent_mail_log (message_id, from_addr, subject, action) VALUES (?,?,?,?)"
      ).bind(m.id, str(m.from_address, 254), str(m.subject, 300), action).run();

      const from = String(m.from_address || "");
      const subject = String(m.subject || "");
      if (SKIP_SENDER.test(from) || SKIP_SUBJECT.test(subject) || from.endsWith("@inkboxmail.com")) {
        await log("skipped"); handled++; continue;
      }
      // Mail meant for a member goes to the member, not to a bot.
      if (/TAI-[2-9A-HJ-NP-Z]{6}/i.test(subject)) {
        await fetch(`${base}/${m.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ is_starred: true }) });
        await log("relay_starred"); handled++; continue;
      }
      // Fetch the body; a GET with the API key also marks the message read.
      const gr = await fetch(`${base}/${m.id}`, { headers: H });
      if (!gr.ok) { console.log("mail-answer get http", gr.status, m.id); continue; }
      const full = (await gr.json()) as any;
      const bodyText = str(full.body_text || full.snippet || "", 4000);
      const question = (subject + "\n\n" + bodyText).trim();
      if (question.length < 8) { await log("empty"); handled++; continue; }

      // Same brain as the site: retrieval, guardrails, citations, logging.
      let answer = "", answered = false; const links: string[] = [];
      try {
        const ar = await fetch("https://theworldofai.org/api/ask", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ question: question.slice(0, 1500) }),
        });
        if (ar.ok) {
          const a = (await ar.json()) as any;
          answered = a.answered === true && !!a.answer;
          answer = String(a.answer || "");
          for (const s of (a.sources || []).slice(0, 5)) if (s?.url) links.push(String(s.url));
        }
      } catch (e) { console.log("mail-answer ask", String(e).slice(0, 120)); }

      let reply: string;
      if (answered) {
        reply = `${answer}\n\n` +
          (links.length ? `Sources on theworldofai.org:\n${links.map((u) => "- " + u).join("\n")}\n\n` : "") +
          `--\nThis answer was generated from the published pages of theworldofai.org. A person reviews this mailbox; reply if anything needs a human.`;
      } else {
        reply = `Thanks for writing. The site does not cover that question yet, so rather than guess, a person will read your message and follow up.\n\n--\ntheworldofai.org`;
        await fetch(`${base}/${m.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ is_starred: true }) });
      }
      const sr = await fetch(base, {
        method: "POST", headers: H,
        body: JSON.stringify({
          recipients: { to: [from] },
          subject: subject.toLowerCase().startsWith("re:") ? subject : "Re: " + subject,
          body_text: reply,
          in_reply_to_message_id: m.id,
        }),
      });
      if (!sr.ok) console.log("mail-answer send http", sr.status, (await sr.text()).slice(0, 200));
      await log(answered ? "answered" : "held_for_human");
      handled++;
    }
    if (handled) console.log("mail-answer handled", handled, "of", inbound.length, "unread");
  } catch (e) {
    console.log("mail-answer error", String(e).slice(0, 200));
  }
}

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
      "SELECT tai_id, email, status, profile, answers, resume_key, confirmed_at, pii, share_pdf, photo_type, pw_hash FROM talent_state WHERE confirm_token=? LIMIT 1"
    ).bind(t).first<{ tai_id: string; email: string; status: string; profile: string; answers: string; resume_key: string | null; confirmed_at: string | null; pii: string; share_pdf: number; photo_type: string | null; pw_hash: string | null }>();
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
    let profile = {}, answers = {}, pii = {};
    try { profile = JSON.parse(row.profile); } catch {}
    try { answers = JSON.parse(row.answers); } catch {}
    try { pii = JSON.parse(row.pii || "{}"); } catch {}
    return tJson({
      tai_id: row.tai_id, email_masked: masked, email: row.email, status: row.status,
      profile, answers, pii, share_pdf: row.share_pdf === 1,
      has_photo: !!row.photo_type, has_password: !!row.pw_hash,
      has_resume: !!row.resume_key,
    });
  }

  // ---- POST /api/talent/submit {t, profile, answers} -----------------------
  if (path === "/api/talent/submit" && request.method === "POST") {
    let b: any;
    try { b = await request.json(); } catch { return tJson({ error: "Bad request" }, 400); }
    const t = str(b.t, 64);
    if (!t) return tJson({ error: "Missing token" }, 400);
    const row = await env.ASSISTANT_DB.prepare(
      "SELECT tai_id, status, email FROM talent_state WHERE confirm_token=? LIMIT 1"
    ).bind(t).first<{ tai_id: string; status: string; email: string }>();
    if (!row) return tJson({ error: "This link is not valid." }, 404);

    const p = b.profile || {};
    const availability = str(p.availability, 20);
    // Structured resume: repeatable jobs and education entries, individual
    // fields. This IS published (page + PDF) with the person's identity
    // removed - first name only, no last name, address, phone, or email -
    // so nothing here may carry contact data by construction; PII has its
    // own column. Reviewed by a person before any of it renders.
    const jobs = (Array.isArray(p.jobs) ? p.jobs : []).slice(0, 15).map((j: any) => ({
      employer: str(j?.employer, 120),
      title: str(j?.title, 120),
      location: str(j?.location, 80),
      start: str(j?.start, 30),
      end: str(j?.end, 30),
      description: str(j?.description, 2000),
    })).filter((j) => j.employer || j.title || j.description);
    const projectsItems = (Array.isArray(p.projects_items) ? p.projects_items : []).slice(0, 15).map((x: any) => ({
      company: str(x?.company, 120),
      title: str(x?.title, 140),
      year: str(x?.year, 30),
      description: str(x?.description, 2000),
    })).filter((x) => x.company || x.title || x.description);
    const educationItems = (Array.isArray(p.education_items) ? p.education_items : []).slice(0, 10).map((e: any) => ({
      institution: str(e?.institution, 140),
      degree: str(e?.degree, 120) || str(e?.credential, 120),
      major: str(e?.major, 120),
      minor: str(e?.minor, 120),
      years: str(e?.years, 30),
      comments: str(e?.comments, 500),
    })).filter((e) => e.institution || e.degree || e.major);
    const dated = (arr: unknown, keys: [string, number][], cap: number) =>
      (Array.isArray(arr) ? arr : []).slice(0, cap).map((v: any) => {
        const o: Record<string, string> = {};
        for (const [k, max] of keys) o[k] = str(v?.[k], max);
        return o;
      }).filter((o) => Object.values(o).some(Boolean));
    const certItems = dated(p.certifications_items, [["name", 140], ["year", 20], ["expires", 20]], 15);
    const pubItems = dated(p.publications_items, [["title", 200], ["date", 20]], 20);
    const patItems = dated(p.patents_items, [["title", 200], ["date", 20]], 15);
    const awardItems = dated(p.awards_items, [["title", 200], ["date", 20]], 15);
    const profile = {
      first_name: str(p.first_name, 60),
      headline: str(p.headline, 140),
      location: str(p.location, 80),
      availability: AVAILABILITY.has(availability) ? availability : "",
      rate: str(p.rate, 60),
      summary: str(p.summary, 2000),
      jobs,
      projects_items: projectsItems,
      education_items: educationItems,
      certifications_items: certItems,
      publications_items: pubItems,
      patents_items: patItems,
      awards_items: awardItems,
      // Legacy text forms, still readable on old rows.
      certifications: str(p.certifications, 2000),
      publications: str(p.publications, 4000),
      awards: str(p.awards, 2000),
      // Legacy free-text fields, kept so pre-builder submissions round-trip.
      work_experience: str(p.work_experience, 4000),
      education: str(p.education, 4000),
    };

    // PII lives in its own column, never in the published profile: the
    // profile JSON is what talent_build will render publicly, pii is what the
    // PDF generator reads. Structural separation, same reasoning as the
    // private resume bucket.
    const piiIn = b.pii || {};
    const links = Array.isArray(piiIn.links)
      ? piiIn.links.filter((u: unknown) => typeof u === "string" && /^https?:\/\//.test(u)).map((u: string) => u.slice(0, 200)).slice(0, 3)
      : [];
    const pii = {
      // Name split three ways; legal name for the resume, independent of the
      // public display first name.
      name_first: str(piiIn.name_first, 60),
      name_middle: str(piiIn.name_middle, 60),
      name_last: str(piiIn.name_last, 60),
      // International phone in three parts: calling code from the dropdown,
      // then area/city code and number as the person writes them locally.
      phone_cc: str(piiIn.phone_cc, 6),
      phone_area: str(piiIn.phone_area, 10),
      phone_num: str(piiIn.phone_num, 20),
      // Address, international shape: free-text lines, region covers state,
      // province, prefecture, or county, postal covers ZIP and equivalents.
      addr_street: str(piiIn.addr_street, 160),
      addr_city: str(piiIn.addr_city, 80),
      addr_region: str(piiIn.addr_region, 80),
      addr_postal: str(piiIn.addr_postal, 20),
      country: str(piiIn.country, 60),
      // The contact email is the VERIFIED signup address, set by the server
      // and locked in the form - a client cannot write someone else's inbox
      // onto a profile that this mailbox confirmed.
      contact_email: row.email,
      links,
      // Legacy fields kept readable for rows written before the split.
      full_name: str(piiIn.full_name, 120),
      phone: str(piiIn.phone, 40),
    };
    const sharePdf = b.share_pdf === true ? 1 : 0;

    // Optional password: set or change only when a non-empty one arrives, so
    // resubmitting the form without typing one never clears an account.
    let pwSet = "";
    const password = typeof b.password === "string" ? b.password : "";
    if (password) {
      if (password.length < 10) return tJson({ error: "Password must be at least 10 characters." }, 400);
      const salt = [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, "0")).join("");
      pwSet = JSON.stringify([salt, await hashPassword(password, salt)]);
    }

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

    if (pwSet) {
      const [salt, hash] = JSON.parse(pwSet);
      await env.ASSISTANT_DB.prepare(
        "UPDATE talent_state SET profile=?, answers=?, pii=?, share_pdf=?, pw_salt=?, pw_hash=?, status='submitted', updated_at=datetime('now') WHERE tai_id=?"
      ).bind(JSON.stringify(profile), JSON.stringify(answers), JSON.stringify(pii), sharePdf, salt, hash, row.tai_id).run();
    } else {
      await env.ASSISTANT_DB.prepare(
        "UPDATE talent_state SET profile=?, answers=?, pii=?, share_pdf=?, status='submitted', updated_at=datetime('now') WHERE tai_id=?"
      ).bind(JSON.stringify(profile), JSON.stringify(answers), JSON.stringify(pii), sharePdf, row.tai_id).run();
    }

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


  // ---- POST /api/talent/login {email, password} -> {t} ----------------------
  // Password is the return path for people who lost the email link; the token
  // it returns IS the account's confirm_token, so both entrances open the
  // same session and nothing forks.
  if (path === "/api/talent/login" && request.method === "POST") {
    let b: any;
    try { b = await request.json(); } catch { return tJson({ error: "Bad request" }, 400); }
    const email = str(b.email, 254).toLowerCase();
    const password = typeof b.password === "string" ? b.password : "";
    if (!email || !password) return tJson({ error: "Email and password required." }, 400);
    const row = await env.ASSISTANT_DB.prepare(
      "SELECT confirm_token, pw_salt, pw_hash FROM talent_state WHERE lower(email)=? AND status != 'deleted' LIMIT 1"
    ).bind(email).first<{ confirm_token: string; pw_salt: string | null; pw_hash: string | null }>();
    // One failure message for every miss: which part was wrong is exactly the
    // enumeration signal the signup path already refuses to give.
    if (!row || !row.pw_salt || !row.pw_hash) return tJson({ error: "Email or password not recognized." }, 401);
    const hash = await hashPassword(password, row.pw_salt);
    if (!safeEqual(hash, row.pw_hash)) return tJson({ error: "Email or password not recognized." }, 401);
    return tJson({ ok: true, t: row.confirm_token });
  }

  // ---- POST /api/talent/photo?t=  (body: image/jpeg|png) --------------------
  if (path === "/api/talent/photo" && request.method === "POST") {
    if (!env.TALENT_R2) return tJson({ error: "Photo upload is not open yet." }, 503);
    const t = str(url.searchParams.get("t"), 64);
    if (!t) return tJson({ error: "Missing token" }, 400);
    const row = await env.ASSISTANT_DB.prepare(
      "SELECT tai_id FROM talent_state WHERE confirm_token=? LIMIT 1"
    ).bind(t).first<{ tai_id: string }>();
    if (!row) return tJson({ error: "This link is not valid." }, 404);
    const buf = new Uint8Array(await request.arrayBuffer());
    if (buf.length > 2 * 1024 * 1024) return tJson({ error: "Image too large, 2 MB maximum." }, 413);
    // Magic bytes, not the client's content-type: same rule as the resume.
    let type = "";
    if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) type = "jpeg";
    else if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) type = "png";
    if (!type) return tJson({ error: "JPEG or PNG only." }, 415);
    await env.TALENT_R2.put(`photos/${row.tai_id}.${type}`, buf, {
      httpMetadata: { contentType: `image/${type}` },
    });
    await env.ASSISTANT_DB.prepare(
      "UPDATE talent_state SET photo_type=?, updated_at=datetime('now') WHERE tai_id=?"
    ).bind(type, row.tai_id).run();
    return tJson({ ok: true, message: "Headshot saved. It shows on your public page once the profile is live." });
  }

  // ---- GET /api/talent/photo/{TAI-...} --------------------------------------
  // Public only for a LIVE profile; the owner can always preview with ?t=.
  // Serving through the Worker instead of a public bucket means an expired or
  // removed profile takes its photo offline with it.
  if (path.startsWith("/api/talent/photo/") && request.method === "GET") {
    if (!env.TALENT_R2) return new Response("Not found", { status: 404 });
    const taiId = str(decodeURIComponent(path.slice("/api/talent/photo/".length)).toUpperCase(), 12);
    const t = str(url.searchParams.get("t"), 64);
    const row = await env.ASSISTANT_DB.prepare(
      "SELECT status, photo_type, confirm_token FROM talent_state WHERE tai_id=? LIMIT 1"
    ).bind(taiId).first<{ status: string; photo_type: string | null; confirm_token: string }>();
    if (!row || !row.photo_type) return new Response("Not found", { status: 404 });
    const allowed = row.status === "live" || (!!t && safeEqual(t, row.confirm_token));
    if (!allowed) return new Response("Not found", { status: 404 });
    const obj = await env.TALENT_R2.get(`photos/${taiId}.${row.photo_type}`);
    if (!obj) return new Response("Not found", { status: 404 });
    return new Response(obj.body, {
      headers: {
        "content-type": `image/${row.photo_type}`,
        "cache-control": "public, max-age=3600",
        "x-content-type-options": "nosniff",
      },
    });
  }

  // ---- GET /api/talent/pdf/{TAI-...} ----------------------------------------
  // The candidate (by token) can always generate their own resume PDF; the
  // public gets it only from a LIVE profile whose owner opted in. Everything
  // in it is the person's own submitted data - composition, not invention.
  if (path.startsWith("/api/talent/pdf/") && request.method === "GET") {
    const taiId = str(decodeURIComponent(path.slice("/api/talent/pdf/".length)).toUpperCase(), 12);
    const t = str(url.searchParams.get("t"), 64);
    const row = await env.ASSISTANT_DB.prepare(
      "SELECT status, profile, answers, pii, share_pdf, confirm_token FROM talent_state WHERE tai_id=? LIMIT 1"
    ).bind(taiId).first<{ status: string; profile: string; answers: string; pii: string; share_pdf: number; confirm_token: string }>();
    if (!row) return new Response("Not found", { status: 404 });
    const isOwner = !!t && safeEqual(t, row.confirm_token);
    const isPublic = row.status === "live";
    if (!isOwner && !isPublic) return new Response("Not found", { status: 404 });
    // Everyone can download a LIVE profile's resume; what varies is identity.
    // Redacted copy: first name only, no last name, address, phone, or email,
    // relay contact instead. Full contact details appear only for the owner
    // or when the owner ticked the share box.
    const includePii = isOwner || row.share_pdf === 1;
    let profile: any = {}, answers: any = {}, pii: any = {};
    try { profile = JSON.parse(row.profile); } catch {}
    try { answers = JSON.parse(row.answers); } catch {}
    try { pii = JSON.parse(row.pii || "{}"); } catch {}
    const pdf = talentResumePdf(taiId, profile, answers, includePii ? pii : {});
    return new Response(pdf, {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${taiId}-resume.pdf"`,
        "cache-control": "no-store",
      },
    });
  }

  // ---- GET /api/talent/docx/{TAI-...} ---------------------------------------
  // Same document, same auth and redaction rules as the PDF, delivered as a
  // real .docx so the person can edit their resume in Word. Built by the
  // store-only zip writer below - no dependency, same reasoning as the PDF.
  if (path.startsWith("/api/talent/docx/") && request.method === "GET") {
    const taiId = str(decodeURIComponent(path.slice("/api/talent/docx/".length)).toUpperCase(), 12);
    const t = str(url.searchParams.get("t"), 64);
    const row = await env.ASSISTANT_DB.prepare(
      "SELECT status, profile, answers, pii, share_pdf, confirm_token FROM talent_state WHERE tai_id=? LIMIT 1"
    ).bind(taiId).first<{ status: string; profile: string; answers: string; pii: string; share_pdf: number; confirm_token: string }>();
    if (!row) return new Response("Not found", { status: 404 });
    const isOwner = !!t && safeEqual(t, row.confirm_token);
    const isPublic = row.status === "live";
    if (!isOwner && !isPublic) return new Response("Not found", { status: 404 });
    const includePii = isOwner || row.share_pdf === 1;
    let profile: any = {}, answers: any = {}, pii: any = {};
    try { profile = JSON.parse(row.profile); } catch {}
    try { answers = JSON.parse(row.answers); } catch {}
    try { pii = JSON.parse(row.pii || "{}"); } catch {}
    const docx = talentResumeDocx(taiId, profile, answers, includePii ? pii : {});
    return new Response(docx, {
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "content-disposition": `attachment; filename="${taiId}-resume.docx"`,
        "cache-control": "no-store",
      },
    });
  }

  return tJson({ error: "Not found" }, 404);
}

// ---------------------------------------------------------------------------
// Minimal PDF writer for the resume download. Hand-rolled rather than a
// dependency: the document is text-only Helvetica in a fixed layout, and a
// generator we wrote is deterministic in the Workers runtime, adds zero bytes
// of third-party code to the bundle, and cannot break on an npm update.
//
// The layout follows the SRJ universal resume format: name, title line,
// contact line, then letterspaced section headings - SUMMARY, CORE
// COMPETENCIES (the person's role and governance selections as a dot-run),
// PROFESSIONAL EXPERIENCE, PUBLICATIONS, EDUCATION, and FRAMEWORKS, TOOLS &
// PLATFORMS (their tool selections as a dot-run). A section with no data is
// omitted entirely - the page says less rather than padding.
//
// Text is WinAnsi (Latin-1): characters outside it are transliterated to '?'
// so a CJK or Arabic name degrades visibly rather than corrupting the file.
// A richer Unicode font is a later improvement, noted, not pretended.
// ---------------------------------------------------------------------------

function pdfEscape(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) || 63;
    if (ch === "(" || ch === ")" || ch === "\\") out += "\\" + ch;
    else if (c === 0x2019 || c === 0x2018) out += "'";
    else if (c === 0x201c || c === 0x201d) out += '"';
    else if (c === 0x2013 || c === 0x2014) out += "-";
    else if (c === 0x2022 || c === 0x00b7) out += "\\267"; // middle dot in WinAnsi
    else if (c === 0x20ac) out += "\\200"; // euro sign, WinAnsi 0x80
    else if (c === 0x2122) out += "\\231"; // trademark, WinAnsi 0x99
    else if (c >= 32 && c <= 126) out += ch;
    else if (c >= 0xa0 && c <= 0xff) out += "\\" + c.toString(8).padStart(3, "0");
    else out += "?";
  }
  return out;
}

function wrapText(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    if (para.trim() === "") { lines.push(""); continue; }
    let cur = "";
    for (const word of para.split(/\s+/)) {
      if (cur && (cur + " " + word).length > maxChars) { lines.push(cur); cur = word; }
      else cur = cur ? cur + " " + word : word;
    }
    if (cur) lines.push(cur);
  }
  return lines;
}

export function talentResumePdf(taiId: string, profile: any, answers: any, pii: any): Uint8Array {
  const S = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const selections = (key: string): string[] => {
    const a = answers && answers[key];
    if (!a) return [];
    const out = Array.isArray(a.selections) ? a.selections.slice() : [];
    if (S(a.other)) out.push(S(a.other));
    return out;
  };

  const fullName = [S(pii.name_first), S(pii.name_middle), S(pii.name_last)].filter(Boolean).join(" ") || S(pii.full_name);
  const phone = [S(pii.phone_cc), S(pii.phone_area), S(pii.phone_num)].filter(Boolean).join(" ") || S(pii.phone);
  const address = [S(pii.addr_street), S(pii.addr_city), S(pii.addr_region), S(pii.addr_postal), S(pii.country)].filter(Boolean).join(", ");
  const redacted = !fullName && !phone && !S(pii.contact_email);
  const name = fullName || S(profile.first_name) || taiId;
  const title = S(profile.headline);
  const contactBits = redacted
    ? [S(profile.location), `Contact: theworldofai@inkboxmail.com, subject ${taiId}`].filter(Boolean)
    : [address || S(profile.location), phone, S(pii.contact_email), ...(Array.isArray(pii.links) ? pii.links : [])].filter(Boolean);

  const aiSkills = SKILL_CATS.map(([k, l]) => ({ l, items: selections(k) })).filter((x) => x.items.length);
  const years = selections("experience-years")[0] || "";

  type Seg = { text: string; font: "R" | "B"; size: number; gap: number };
  const segs: Seg[] = [];
  const push = (text: string, font: "R" | "B", size: number, gap: number) =>
    segs.push({ text, font, size, gap });
  const heading = (t: string) => {
    push("", "R", 10, 6);
    push(t.toUpperCase(), "B", 14, 16);
  };
  const body = (t: string, wrapAt = 96) => {
    for (const line of wrapText(t, wrapAt)) push(line, "R", 10, 13);
  };

  push(name, "B", 20, 24);
  if (title) push(title, "B", 11, 15);
  if (contactBits.length) push(contactBits.join("  \u00b7  "), "R", 9.5, 13);
  push(`AI Talent Network profile ${taiId}  \u00b7  theworldofai.org/talent/`, "R", 8.5, 12);

  const summaryBits: string[] = [];
  if (S(profile.summary)) summaryBits.push(S(profile.summary));
  if (years) summaryBits.push(`${years} years of hands-on AI/ML experience.`);
  if (S(profile.availability) === "open") summaryBits.push("Open to work.");
  if (S(profile.availability) === "freelance") summaryBits.push("Available for freelance and contract work.");
  if (S(profile.rate)) summaryBits.push(`Rate: ${S(profile.rate)}.`);
  if (summaryBits.length) { heading("Professional Summary"); body(summaryBits.join(" ")); }

  if (aiSkills.length) {
    heading("AI Skills");
    for (const c of aiSkills) body(`${c.l}: ${c.items.join(" \u00b7 ")}`);
  }

  const jobs: any[] = Array.isArray(profile.jobs) ? profile.jobs : [];
  if (jobs.length || S(profile.work_experience)) {
    heading("Professional Experience");
    for (const j of jobs) {
      const head = [S(j.title), S(j.employer)].filter(Boolean).join(", ");
      if (head) push(head, "B", 10.5, 14);
      const meta = [S(j.location), [S(j.start), S(j.end)].filter(Boolean).join(" \u2013 ")].filter(Boolean).join(" | ");
      if (meta) push(meta, "R", 9, 12);
      if (S(j.description)) body(S(j.description));
      push("", "R", 10, 5);
    }
    if (!jobs.length) body(S(profile.work_experience)); // legacy free text
  }

  const projects: any[] = Array.isArray(profile.projects_items) ? profile.projects_items : [];
  if (projects.length) {
    heading("Projects");
    for (const x of projects) {
      const head = [S(x.title), S(x.company)].filter(Boolean).join(" \u2014 ");
      if (head) push(head, "B", 10.5, 14);
      if (S(x.year)) push(S(x.year), "R", 9, 12);
      if (S(x.description)) body(S(x.description));
      push("", "R", 10, 5);
    }
  }

  const pubs: any[] = Array.isArray(profile.publications_items) ? profile.publications_items : [];
  if (pubs.length || S(profile.publications)) {
    heading("Publications");
    for (const it of pubs) body([S(it.title), S(it.date)].filter(Boolean).join(" \u2014 "));
    if (!pubs.length) body(S(profile.publications));
  }

  const pats: any[] = Array.isArray(profile.patents_items) ? profile.patents_items : [];
  if (pats.length) {
    heading("Patents & Trademarks");
    for (const it of pats) body([S(it.title), S(it.date)].filter(Boolean).join(" \u2014 "));
  }

  const edu: any[] = Array.isArray(profile.education_items) ? profile.education_items : [];
  if (edu.length || S(profile.education)) {
    heading("Education");
    for (const e of edu) {
      const deg = [S(e.degree) || S(e.credential), S(e.major)].filter(Boolean).join(", ")
        + (S(e.minor) ? ` (minor: ${S(e.minor)})` : "");
      const line = [deg, S(e.institution)].filter(Boolean).join(" \u2014 ") + (S(e.years) ? `, ${S(e.years)}` : "");
      if (line.trim()) body(line);
      if (S(e.comments)) push(S(e.comments), "R", 9, 12);
    }
    if (!edu.length) body(S(profile.education)); // legacy free text
  }

  const certs: any[] = Array.isArray(profile.certifications_items) ? profile.certifications_items : [];
  if (certs.length || S(profile.certifications)) {
    heading("Certifications");
    for (const c of certs) {
      const bits = [S(c.name), S(c.year)].filter(Boolean).join(" \u2014 ")
        + (S(c.expires) ? `, expires ${S(c.expires)}` : "");
      if (bits.trim()) body(bits);
    }
    if (!certs.length) body(S(profile.certifications));
  }

  const awards: any[] = Array.isArray(profile.awards_items) ? profile.awards_items : [];
  if (awards.length || S(profile.awards)) {
    heading("Awards & Honors");
    for (const a of awards) body([S(a.title), S(a.date)].filter(Boolean).join(" \u2014 "));
    if (!awards.length) body(S(profile.awards));
  }

  // Paginate: US Letter, 54pt margins, top-down cursor.
  const pageH = 792, pageW = 612, margin = 54;
  const pages: string[] = [];
  let y = pageH - margin;
  let cur = "";
  const emit = (s2: Seg) => {
    if (s2.text === "") { y -= s2.gap; return; }
    if (y - s2.size < margin) { pages.push(cur); cur = ""; y = pageH - margin; }
    y -= s2.size;
    cur += `BT /F${s2.font === "B" ? 2 : 1} ${s2.size} Tf 1 0 0 1 ${margin} ${y.toFixed(1)} Tm (${pdfEscape(s2.text)}) Tj ET\n`;
    y -= s2.gap - s2.size;
  };
  for (const s2 of segs) emit(s2);
  if (cur.trim()) pages.push(cur);
  if (pages.length === 0) pages.push(`BT /F1 10 Tf 1 0 0 1 ${margin} ${pageH - margin - 10} Tm (${pdfEscape("Profile " + taiId)}) Tj ET\n`);

  // Assemble the PDF object graph.
  const enc = new TextEncoder();
  const objects: string[] = [];
  const n = () => objects.length + 1;
  const catalogId = n(); objects.push(""); // placeholder, filled after pages
  const pagesId = n(); objects.push("");
  const fontR = n(); objects.push(`${fontR} 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >> endobj\n`);
  const fontB = n(); objects.push(`${fontB} 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >> endobj\n`);
  const pageIds: number[] = [];
  for (const content of pages) {
    const stream = enc.encode(content);
    const contentId = n();
    objects.push(`${contentId} 0 obj << /Length ${stream.length} >> stream\n${content}endstream endobj\n`);
    const pageId = n();
    pageIds.push(pageId);
    objects.push(`${pageId} 0 obj << /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /Font << /F1 ${fontR} 0 R /F2 ${fontB} 0 R >> >> /Contents ${contentId} 0 R >> endobj\n`);
  }
  objects[catalogId - 1] = `${catalogId} 0 obj << /Type /Catalog /Pages ${pagesId} 0 R >> endobj\n`;
  objects[pagesId - 1] = `${pagesId} 0 obj << /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(" ")}] /Count ${pageIds.length} >> endobj\n`;

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const o of objects) { offsets.push(enc.encode(out).length); out += o; }
  const xref = enc.encode(out).length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${off.toString().padStart(10, "0")} 00000 n \n`;
  out += `trailer << /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return enc.encode(out);
}

// ---------------------------------------------------------------------------
// Minimal DOCX writer: a .docx is a zip of XML parts, and a zip written with
// STORE (no compression) needs only local headers, a CRC-32, and a central
// directory - about eighty lines, zero dependencies, deterministic in the
// Workers runtime. The document mirrors the PDF's sections exactly, sourced
// from the same data, so the two downloads can never disagree.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zipStore(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const u16 = (v: number) => new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
  const u32 = (v: number) => new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]);
  const cat = (...parts: Uint8Array[]) => {
    const total = parts.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };
  for (const f of files) {
    const nameB = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = cat(u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(f.data.length), u32(f.data.length), u16(nameB.length), u16(0), nameB, f.data);
    central.push(cat(u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(f.data.length), u32(f.data.length), u16(nameB.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), nameB));
    chunks.push(local);
    offset += local.length;
  }
  const centralAll = cat(...central);
  const end = cat(u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(centralAll.length), u32(offset), u16(0));
  return cat(...chunks, centralAll, end);
}

function xmlEsc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
}

export function talentResumeDocx(taiId: string, profile: any, answers: any, pii: any): Uint8Array {
  const S = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const selections = (key: string): string[] => {
    const a = answers && answers[key];
    if (!a) return [];
    const out = Array.isArray(a.selections) ? a.selections.slice() : [];
    if (S(a.other)) out.push(S(a.other));
    return out;
  };
  const fullName = [S(pii.name_first), S(pii.name_middle), S(pii.name_last)].filter(Boolean).join(" ") || S(pii.full_name);
  const phone = [S(pii.phone_cc), S(pii.phone_area), S(pii.phone_num)].filter(Boolean).join(" ") || S(pii.phone);
  const address = [S(pii.addr_street), S(pii.addr_city), S(pii.addr_region), S(pii.addr_postal), S(pii.country)].filter(Boolean).join(", ");
  const redacted = !fullName && !phone && !S(pii.contact_email);
  const name = fullName || S(profile.first_name) || taiId;
  const contactBits = redacted
    ? [S(profile.location), `Contact: theworldofai@inkboxmail.com, subject ${taiId}`].filter(Boolean)
    : [address || S(profile.location), phone, S(pii.contact_email), ...(Array.isArray(pii.links) ? pii.links : [])].filter(Boolean);
  const aiSkills = SKILL_CATS.map(([k, l]) => ({ l, items: selections(k) })).filter((x) => x.items.length);
  const years = selections("experience-years")[0] || "";

  const paras: string[] = [];
  const para = (text: string, opts: { bold?: boolean; size?: number; caps?: boolean; spaceBefore?: number } = {}) => {
    const size = (opts.size || 21); // half-points
    const props = `<w:rPr>${opts.bold ? "<w:b/>" : ""}<w:sz w:val="${size}"/>${opts.caps ? '<w:caps w:val="true"/><w:spacing w:val="30"/>' : ""}</w:rPr>`;
    const ppr = opts.spaceBefore ? `<w:pPr><w:spacing w:before="${opts.spaceBefore}"/></w:pPr>` : "";
    for (const line of text.split("\n")) {
      paras.push(`<w:p>${ppr}<w:r>${props}<w:t xml:space="preserve">${xmlEsc(line)}</w:t></w:r></w:p>`);
    }
  };
  const headingP = (t: string) => para(t, { bold: true, size: 28, caps: true, spaceBefore: 240 });

  para(name, { bold: true, size: 40 });
  if (S(profile.headline)) para(S(profile.headline), { bold: true, size: 22 });
  if (contactBits.length) para(contactBits.join("  \u00b7  "), { size: 19 });
  para(`AI Talent Network profile ${taiId}  \u00b7  theworldofai.org/talent/`, { size: 17 });

  const summaryBits: string[] = [];
  if (S(profile.summary)) summaryBits.push(S(profile.summary));
  if (years) summaryBits.push(`${years} years of hands-on AI/ML experience.`);
  if (S(profile.availability) === "open") summaryBits.push("Open to work.");
  if (S(profile.availability) === "freelance") summaryBits.push("Available for freelance and contract work.");
  if (S(profile.rate)) summaryBits.push(`Rate: ${S(profile.rate)}.`);
  if (summaryBits.length) { headingP("Professional Summary"); para(summaryBits.join(" ")); }
  if (aiSkills.length) {
    headingP("AI Skills");
    for (const c of aiSkills) para(`${c.l}: ${c.items.join(" \u00b7 ")}`);
  }

  const jobs: any[] = Array.isArray(profile.jobs) ? profile.jobs : [];
  if (jobs.length || S(profile.work_experience)) {
    headingP("Professional Experience");
    for (const j of jobs) {
      const head = [S(j.title), S(j.employer)].filter(Boolean).join(", ");
      if (head) para(head, { bold: true, spaceBefore: 160 });
      const meta = [S(j.location), [S(j.start), S(j.end)].filter(Boolean).join(" \u2013 ")].filter(Boolean).join(" | ");
      if (meta) para(meta, { size: 18 });
      if (S(j.description)) para(S(j.description));
    }
    if (!jobs.length) para(S(profile.work_experience));
  }
  const projects: any[] = Array.isArray(profile.projects_items) ? profile.projects_items : [];
  if (projects.length) {
    headingP("Projects");
    for (const x of projects) {
      const head = [S(x.title), S(x.company)].filter(Boolean).join(" \u2014 ");
      if (head) para(head, { bold: true, spaceBefore: 160 });
      if (S(x.year)) para(S(x.year), { size: 18 });
      if (S(x.description)) para(S(x.description));
    }
  }
  const pubs: any[] = Array.isArray(profile.publications_items) ? profile.publications_items : [];
  if (pubs.length || S(profile.publications)) {
    headingP("Publications");
    for (const it of pubs) para([S(it.title), S(it.date)].filter(Boolean).join(" \u2014 "));
    if (!pubs.length) para(S(profile.publications));
  }
  const pats: any[] = Array.isArray(profile.patents_items) ? profile.patents_items : [];
  if (pats.length) {
    headingP("Patents & Trademarks");
    for (const it of pats) para([S(it.title), S(it.date)].filter(Boolean).join(" \u2014 "));
  }
  const edu: any[] = Array.isArray(profile.education_items) ? profile.education_items : [];
  if (edu.length || S(profile.education)) {
    headingP("Education");
    for (const e of edu) {
      const deg = [S(e.degree) || S(e.credential), S(e.major)].filter(Boolean).join(", ")
        + (S(e.minor) ? ` (minor: ${S(e.minor)})` : "");
      const line = [deg, S(e.institution)].filter(Boolean).join(" \u2014 ") + (S(e.years) ? `, ${S(e.years)}` : "");
      if (line.trim()) para(line);
      if (S(e.comments)) para(S(e.comments), { size: 18 });
    }
    if (!edu.length) para(S(profile.education));
  }
  const certs: any[] = Array.isArray(profile.certifications_items) ? profile.certifications_items : [];
  if (certs.length || S(profile.certifications)) {
    headingP("Certifications");
    for (const c of certs) {
      const bits = [S(c.name), S(c.year)].filter(Boolean).join(" \u2014 ")
        + (S(c.expires) ? `, expires ${S(c.expires)}` : "");
      if (bits.trim()) para(bits);
    }
    if (!certs.length) para(S(profile.certifications));
  }
  const awardsD: any[] = Array.isArray(profile.awards_items) ? profile.awards_items : [];
  if (awardsD.length || S(profile.awards)) {
    headingP("Awards & Honors");
    for (const a of awardsD) para([S(a.title), S(a.date)].filter(Boolean).join(" \u2014 "));
    if (!awardsD.length) para(S(profile.awards));
  }

  const enc = new TextEncoder();
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras.join("")}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080"/></w:sectPr></w:body></w:document>`;
  return zipStore([
    { name: "[Content_Types].xml", data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`) },
    { name: "_rels/.rels", data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`) },
    { name: "word/document.xml", data: enc.encode(documentXml) },
  ]);
}
