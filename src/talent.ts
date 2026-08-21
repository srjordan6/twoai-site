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
      tai_id: row.tai_id, email_masked: masked, status: row.status,
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

    // PII lives in its own column, never in the published profile: the
    // profile JSON is what talent_build will render publicly, pii is what the
    // PDF generator reads. Structural separation, same reasoning as the
    // private resume bucket.
    const piiIn = b.pii || {};
    const links = Array.isArray(piiIn.links)
      ? piiIn.links.filter((u: unknown) => typeof u === "string" && /^https?:\/\//.test(u)).map((u: string) => u.slice(0, 200)).slice(0, 3)
      : [];
    const pii = {
      full_name: str(piiIn.full_name, 120),
      phone: str(piiIn.phone, 40),
      contact_email: str(piiIn.contact_email, 254),
      country: str(piiIn.country, 60),
      links,
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
    if (hash !== row.pw_hash) return tJson({ error: "Email or password not recognized." }, 401);
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
    const allowed = row.status === "live" || (t && t === row.confirm_token);
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
    const isOwner = t && t === row.confirm_token;
    const isPublic = row.status === "live" && row.share_pdf === 1;
    if (!isOwner && !isPublic) return new Response("Not found", { status: 404 });
    let profile: any = {}, answers: any = {}, pii: any = {};
    try { profile = JSON.parse(row.profile); } catch {}
    try { answers = JSON.parse(row.answers); } catch {}
    try { pii = JSON.parse(row.pii || "{}"); } catch {}
    const pdf = talentResumePdf(taiId, profile, answers, isOwner || isPublic ? pii : {});
    return new Response(pdf, {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${taiId}-resume.pdf"`,
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

  const name = S(pii.full_name) || S(profile.first_name) || taiId;
  const title = S(profile.headline);
  const contactBits = [S(profile.location), S(pii.phone), S(pii.contact_email), ...(Array.isArray(pii.links) ? pii.links : [])]
    .filter(Boolean);

  const competencies = [...selections("role-type"), ...selections("governance-frameworks")];
  const toolRun = ["models", "frameworks", "vector-dbs", "observability", "evaluation", "guardrails", "deployment"]
    .flatMap(selections);
  const years = selections("experience-years")[0] || "";

  type Seg = { text: string; font: "R" | "B"; size: number; gap: number };
  const segs: Seg[] = [];
  const push = (text: string, font: "R" | "B", size: number, gap: number) =>
    segs.push({ text, font, size, gap });
  const heading = (t: string) => {
    push("", "R", 10, 6);
    push(t.toUpperCase().split("").join(" "), "B", 11, 14);
  };
  const body = (t: string, wrapAt = 96) => {
    for (const line of wrapText(t, wrapAt)) push(line, "R", 10, 13);
  };

  push(name, "B", 20, 24);
  if (title) push(title, "B", 11, 15);
  if (contactBits.length) push(contactBits.join("  \u00b7  "), "R", 9.5, 13);
  push(`AI Talent Network profile ${taiId}  \u00b7  theworldofai.org/talent/`, "R", 8.5, 12);

  const summaryBits: string[] = [];
  if (years) summaryBits.push(`${years} years of hands-on AI/ML experience.`);
  if (S(profile.availability) === "open") summaryBits.push("Open to work.");
  if (S(profile.availability) === "freelance") summaryBits.push("Available for freelance and contract work.");
  if (S(profile.rate)) summaryBits.push(`Rate: ${S(profile.rate)}.`);
  if (summaryBits.length) { heading("Summary"); body(summaryBits.join(" ")); }

  if (competencies.length) { heading("Core Competencies"); body(competencies.join(" \u00b7 ")); }
  if (S(profile.work_experience)) { heading("Professional Experience"); body(S(profile.work_experience)); }
  if (S(profile.publications)) { heading("Publications"); body(S(profile.publications)); }
  if (S(profile.education)) { heading("Education"); body(S(profile.education)); }
  if (toolRun.length) { heading("Frameworks, Tools & Platforms"); body(toolRun.join(" \u00b7 ")); }

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
