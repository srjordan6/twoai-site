/**
 * POST /api/translate: page translation through Microsoft Translator.
 *
 * WHY THIS EXISTS. Until 2026-09-19 the language selector in the topbar drove a
 * hidden Google Website Translator widget. That night the widget stopped
 * translating: Google's browser script, release TE_20260916, throws inside its
 * own code before it requests a word, on this site, on W3Schools' demo of the
 * widget and on example.com through Google's own translate.goog proxy, while
 * Google's translation backend answered a direct call correctly. Google's
 * Search Central blog also carries a notice dated 2026-09-01 that the widget is
 * unsupported from 2026-10-01. Stephen chose Microsoft Translator's free tier
 * (F0, 2 million characters a month) to replace it.
 *
 * THE KEY NEVER REACHES THE BROWSER. The old widget could run client side
 * because Google paid for it. A metered key in page source is a key anyone can
 * spend, so the browser sends the page's text here, this module calls
 * Microsoft, and the key lives in a Worker secret.
 *
 * EVERY STRING IS TRANSLATED ONCE. The allowance is small next to the site:
 * 14,000 pages times 60 languages is not something 2 million characters a
 * month can cover by brute force. So the cache is per string and per language,
 * keyed on a hash of the English text, in KV namespace twoai-translations. The
 * navigation, the footer and every repeated label are paid for once for the
 * whole site, a page that is rebuilt every day with one changed date costs one
 * string and not the page, and the second reader of any page in any language
 * costs Microsoft nothing at all.
 *
 * WHAT STOPS IT BEING DRAINED. An open translation endpoint is a free
 * translation service for whoever finds it. Four limits, in the order they are
 * checked: the request must come from this site's own origin; a per-IP rate
 * limit; hard caps on strings and characters per request; and a monthly
 * character budget held in KV that stops calling Microsoft at 1.9 million. The
 * budget counter is not atomic and may undercount under load, which is
 * acceptable because the F0 tier is itself a hard stop: past 2 million
 * Microsoft refuses rather than bills. When any of these says no, the reader
 * gets the strings already cached and the rest stay in English. A partly
 * translated page is a worse experience than a fully translated one and a far
 * better one than an error.
 *
 * Secrets: MS_TRANSLATOR_KEY, and MS_TRANSLATOR_REGION for a regional Azure
 * resource (leave unset, or set to global, for a Global one). Without the key
 * this route answers 503 and nothing else on the site is affected.
 */

interface KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

export interface TranslateEnv {
  TRANSLATE_KV?: KV;
  TRANSLATE_RATE?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
  MS_TRANSLATOR_KEY?: string;
  MS_TRANSLATOR_REGION?: string;
}

const ORIGIN = "https://theworldofai.org";
const MS_ENDPOINT = "https://api.cognitive.microsofttranslator.com/translate";
const MAX_STRINGS = 150;
const MAX_CHARS = 20000;
const MAX_STRING_LEN = 8000;
const MONTHLY_BUDGET = 1_900_000;

// Microsoft's codes, not Google's: he not iw, zh-Hans not zh-CN, fil not tl,
// nb not no. The selector in Topbar.astro sends exactly these.
const LANGS = new Set([
  "af", "sq", "ar", "bn", "bg", "zh-Hans", "zh-Hant", "hr", "cs", "da", "nl", "et", "fil", "fi",
  "fr", "de", "el", "gu", "he", "hi", "hu", "id", "it", "ja", "kn", "ko", "lv", "lt", "ms", "mr",
  "nb", "fa", "pl", "pt", "pa", "ro", "ru", "sr-Cyrl", "sk", "sl", "es", "sw", "sv", "ta", "te",
  "th", "tr", "uk", "ur", "vi",
]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function sha(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
}

export async function handleTranslate(request: Request, env: TranslateEnv, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  // Same-origin fetches send Origin on a POST. It can be forged by a script,
  // which is why it is the first limit and not the only one.
  if (request.headers.get("origin") !== ORIGIN) return json({ error: "forbidden" }, 403);
  if (!env.MS_TRANSLATOR_KEY || !env.TRANSLATE_KV) return json({ error: "translation is not configured" }, 503);

  if (env.TRANSLATE_RATE) {
    try {
      const ip = request.headers.get("cf-connecting-ip") || "unknown";
      const { success } = await env.TRANSLATE_RATE.limit({ key: ip });
      if (!success) return json({ error: "rate limited" }, 429);
    } catch { /* a limiter fault must not take translation down */ }
  }

  let body: { to?: unknown; texts?: unknown };
  try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  const to = typeof body.to === "string" ? body.to : "";
  if (!LANGS.has(to)) return json({ error: "unsupported language" }, 400);
  if (!Array.isArray(body.texts) || body.texts.length === 0 || body.texts.length > MAX_STRINGS) {
    return json({ error: `texts must hold 1 to ${MAX_STRINGS} strings` }, 400);
  }
  const texts: string[] = [];
  let chars = 0;
  for (const t of body.texts) {
    if (typeof t !== "string" || t.length === 0 || t.length > MAX_STRING_LEN) return json({ error: "bad string" }, 400);
    chars += t.length;
    texts.push(t);
  }
  if (chars > MAX_CHARS) return json({ error: `more than ${MAX_CHARS} characters` }, 400);

  const kv = env.TRANSLATE_KV;
  const keys = await Promise.all(texts.map(async (t) => `s:${to}:${await sha(t)}`));
  const out: (string | null)[] = await Promise.all(keys.map((k) => kv.get(k).catch(() => null)));

  // What is still missing, each distinct string once.
  const missing = new Map<string, number[]>();
  out.forEach((v, i) => {
    if (v !== null) return;
    const list = missing.get(texts[i]);
    if (list) list.push(i); else missing.set(texts[i], [i]);
  });
  const cached = texts.length - [...missing.values()].reduce((n, l) => n + l.length, 0);
  if (missing.size === 0) return json({ to, translations: out, cached, fresh: 0, partial: false });

  const need = [...missing.keys()];
  const needChars = need.reduce((n, t) => n + t.length, 0);
  const month = new Date().toISOString().slice(0, 7);
  const budgetKey = `budget:${month}`;
  const used = parseInt((await kv.get(budgetKey).catch(() => null)) || "0", 10) || 0;
  if (used + needChars > MONTHLY_BUDGET) {
    return json({ to, translations: out, cached, fresh: 0, partial: true, reason: "monthly allowance used" });
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "Ocp-Apim-Subscription-Key": env.MS_TRANSLATOR_KEY,
  };
  const region = (env.MS_TRANSLATOR_REGION || "").trim();
  if (region && region.toLowerCase() !== "global") headers["Ocp-Apim-Subscription-Region"] = region;

  let translated: string[] | null = null;
  let reason = "";
  let retryAfter = 0;
  try {
    // textType=html because a unit is a whole sentence WITH its inline markup:
    // the selector sends "covers <b>76 frameworks</b> that govern" as one
    // string and Microsoft puts the <b> where it belongs in the target
    // sentence. It also honours translate="no", which the selector sets on
    // code inside a sentence.
    const res = await fetch(`${MS_ENDPOINT}?api-version=3.0&from=en&to=${encodeURIComponent(to)}&textType=html`, {
      method: "POST",
      headers,
      body: JSON.stringify(need.map((t) => ({ Text: t }))),
    });
    if (res.ok) {
      const data = (await res.json()) as { translations?: { text?: string }[] }[];
      if (Array.isArray(data) && data.length === need.length) {
        translated = data.map((d, i) => d?.translations?.[0]?.text || need[i]);
      } else reason = "translator returned an unexpected shape";
    } else if (res.status === 429) {
      // The F0 tier is metered by the minute as well as the month: three
      // pages in quick succession trip it. This is a wait, not a failure, and
      // the selector sends the refused blocks again after the pause.
      reason = "translator busy";
      retryAfter = parseInt(res.headers.get("retry-after") || "", 10) || 20;
    } else {
      // 403 with code 403001 is the free tier's monthly stop.
      reason = res.status === 403 ? "monthly allowance used" : `translator answered ${res.status}`;
    }
  } catch {
    reason = "translator unreachable";
  }
  if (!translated) {
    return json({ to, translations: out, cached, fresh: 0, partial: true, reason, ...(retryAfter ? { retry_after: retryAfter } : {}) });
  }

  const writes: Promise<unknown>[] = [];
  need.forEach((t, n) => {
    const value = translated![n];
    for (const i of missing.get(t)!) out[i] = value;
    writes.push(kv.put(keys[missing.get(t)![0]], value).catch(() => undefined));
  });
  writes.push(kv.put(budgetKey, String(used + needChars), { expirationTtl: 60 * 60 * 24 * 70 }).catch(() => undefined));
  ctx.waitUntil(Promise.all(writes));

  return json({ to, translations: out, cached, fresh: need.length, partial: false });
}
