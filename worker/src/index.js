/**
 * Teyit Asistanı — Worker
 *
 * Gecikme stratejisi (hedef: ilk kelime ekranda < 600ms)
 *
 *   t=0     istek gelir
 *   t=5ms   KV cache kontrolü — hit ise ANINDA döner, iş biter
 *   t=10ms  İKİ YOL PARALEL başlar:
 *             A) model-only, stream=true  → tokenlar geldikçe "draft" akar
 *             B) arama + model            → bitince "final" ile draft'ı ezer
 *   t~400ms A'nın ilk tokenı ekranda (kullanıcı cevabı okumaya başlar)
 *   t~1.4s  B gelirse final güncellenir; gelmezse A final sayılır
 *   t=2600  sert tavan → "EMİN DEĞİLİM"
 *
 * Ses asla buraya gelmez. Sadece kısa metin.
 */

const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
const HARD_CAP_MS = 2600;
const SEARCH_CAP_MS = 950;
const CACHE_TTL = 60 * 60 * 6; // 6 saat

const SYS = `Sen canlı yayın yapan bir sunucunun kulağındaki yardımcısın.
Sunucu bir bilgiden emin olamadı. TEK CÜMLELİK net cevap ver.

KURALLAR
- En fazla 12 kelime. Ekranda büyük punto tek satır görünecek.
- Rakam sorulduysa rakamı ver. Tarih sorulduysa tarihi ver.
- Emin DEĞİLSEN sadece şunu yaz: EMİN DEĞİLİM
- "sanırım", "galiba", "muhtemelen", "yaklaşık olarak" yazma. Ya net ya EMİN DEĞİLİM.
- Açıklama, gerekçe, selamlama, giriş cümlesi YOK.
- Suçlama yapma, "yanlış" deme. Sadece doğru bilgiyi söyle.
- Türkçe cevap ver.`;

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    switch (url.pathname) {
      case "/health":
        return cors(Response.json({ ok: true, model: MODEL, cache: !!env.CACHE }));

      case "/warm":
        // Uygulama mikrofona basınca çağırır: model + bağlantı ısınır
        ctx.waitUntil(warm(env));
        return cors(Response.json({ ok: true }));

      case "/check":
        if (req.method !== "POST") break;
        return handleCheck(req, env, ctx);

      case "/bench":
        return cors(await bench(env));
    }
    return cors(new Response("not found", { status: 404 }));
  },
};

/* ================================================================== */

async function handleCheck(req, env, ctx) {
  let body;
  try { body = await req.json(); } catch { return cors(bad("json")); }

  const q = String(body.q || "").trim();
  const context = String(body.ctx || "").trim().slice(0, 300);
  const spec = body.spec === true;

  if (!q || q.length > 400) return cors(bad("query"));

  // Spekülatif çağrı: cevabı client'a döndürmüyoruz, sadece cache'i ısıtıyoruz.
  if (spec) {
    ctx.waitUntil(prewarm(env, q, context));
    return cors(Response.json({ ok: true, spec: true }));
  }

  return cors(stream(q, context, env, ctx));
}

/* ------------------------- Ana stream ----------------------------- */

function stream(q, context, env, ctx) {
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter();
  const enc = new TextEncoder();
  const t0 = Date.now();

  const send = (ev, d) =>
    w.write(enc.encode(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`)).catch(() => {});

  ctx.waitUntil((async () => {
    let published = false;

    // ---- 0. Cache ----
    const key = cacheKey(q);
    const cached = await kvGet(env, key);
    if (cached) {
      await send("answer", { text: cached.text, src: "cache", ms: Date.now() - t0, final: true, refs: cached.refs || [] });
      await send("done", { ms: Date.now() - t0 });
      return w.close().catch(() => {});
    }

    // ---- YOL A: model-only, token token akar ----
    const pathA = (async () => {
      let acc = "";
      try {
        const s = await env.AI.run(MODEL, {
          messages: msgs(q, context, null),
          max_tokens: 40, temperature: 0.1, stream: true,
        });
        for await (const tok of sseTokens(s)) {
          acc += tok;
          // Taslağı canlı akıt — kullanıcı 400ms'de okumaya başlar
          await send("draft", { text: clean(acc), ms: Date.now() - t0 });
        }
      } catch {}
      return acc.trim();
    })();

    // ---- YOL B: arama + model ----
    const pathB = (async () => {
      const s = await search(env, q, context);
      if (!s) return null;
      try {
        const r = await env.AI.run(MODEL, {
          messages: msgs(q, context, s.text),
          max_tokens: 40, temperature: 0.1,
        });
        return { text: (r.response || "").trim(), refs: s.refs };
      } catch { return null; }
    })();

    // B'yi tavanla yarıştır
    const b = await Promise.race([pathB, sleep(HARD_CAP_MS).then(() => null)]);

    if (b && confident(b.text)) {
      const out = { text: clean(b.text), src: "web", ms: Date.now() - t0, final: true, refs: b.refs };
      await send("answer", out);
      published = true;
      ctx.waitUntil(kvPut(env, key, { text: out.text, refs: out.refs }));
    } else {
      const a = await Promise.race([pathA, sleep(400).then(() => "")]);
      if (confident(a)) {
        const out = { text: clean(a), src: "model", ms: Date.now() - t0, final: true, refs: [] };
        await send("answer", out);
        published = true;
        ctx.waitUntil(kvPut(env, key, { text: out.text, refs: [] }));
      }
    }

    if (!published) {
      await send("answer", { text: "EMİN DEĞİLİM", src: "none", ms: Date.now() - t0, final: true, refs: [] });
    }

    await send("done", { ms: Date.now() - t0 });
    w.close().catch(() => {});
  })());

  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    },
  });
}

/* ------------------------- Model ---------------------------------- */

function msgs(q, context, evidence) {
  const p = [];
  if (context) p.push(`Önceki cümleler: ${context}`);
  if (evidence) p.push(`Güncel web kaynakları:\n${evidence}`);
  p.push(`Sunucunun emin olamadığı ifade: "${q}"`);
  p.push("Tek cümlelik net cevap:");
  return [
    { role: "system", content: SYS },
    { role: "user", content: p.join("\n\n") },
  ];
}

/** Workers AI stream'inden token çıkarır. */
async function* sseTokens(stream) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const d = line.slice(5).trim();
      if (!d || d === "[DONE]") continue;
      try {
        const j = JSON.parse(d);
        if (j.response) yield j.response;
      } catch {}
    }
  }
}

/* ------------------------- Arama ---------------------------------- */

async function search(env, q, context) {
  if (!env.BRAVE_KEY) return null;
  const u = new URL("https://api.search.brave.com/res/v1/web/search");
  u.searchParams.set("q", buildQuery(q, context));
  u.searchParams.set("count", "3");
  u.searchParams.set("country", "TR");
  u.searchParams.set("search_lang", "tr");

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), SEARCH_CAP_MS);
  try {
    const r = await fetch(u, {
      headers: { Accept: "application/json", "X-Subscription-Token": env.BRAVE_KEY },
      signal: ac.signal,
    });
    clearTimeout(t);
    if (!r.ok) return null;
    const j = await r.json();
    const res = (j.web?.results || []).slice(0, 3);
    if (!res.length) return null;
    return {
      text: res.map((x, i) => `[${i + 1}] ${x.title} — ${strip(x.description)}`).join("\n"),
      refs: res.map((x) => ({ title: x.title, url: x.url })),
    };
  } catch { clearTimeout(t); return null; }
}

/** Sorgu üretimi LLM'siz — regex, ~0ms. */
function buildQuery(q, context) {
  const HEDGE = /\b(sanırım|sanıyorum|galiba|zannedersem|herhalde|yanılmıyorsam|yanlış hatırlamıyorsam|emin değilim|hatırladığım kadarıyla|neydi|değil miydi|doğru mu)\b/gi;
  const FILLER = /\b(şey|yani|işte|hani|falan|filan|bir|bu|şu|çok|daha|ama|için|ile|olarak|gibi|kadar)\b/gi;
  let s = ((context ? context + " " : "") + q)
    .replace(HEDGE, " ").replace(FILLER, " ")
    .replace(/[^\p{L}\p{N}\s%.,]/gu, " ").replace(/\s+/g, " ").trim();
  return s.split(" ").filter((x) => x.length > 2).slice(0, 8).join(" ");
}

/* ------------------------- Cache ---------------------------------- */

function cacheKey(q) {
  const n = q.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "").slice(0, 120);
  let h = 5381;
  for (let i = 0; i < n.length; i++) h = ((h << 5) + h + n.charCodeAt(i)) >>> 0;
  return `a:${h.toString(36)}`;
}
async function kvGet(env, k) {
  if (!env.CACHE) return null;
  try { return await env.CACHE.get(k, "json"); } catch { return null; }
}
async function kvPut(env, k, v) {
  if (!env.CACHE) return;
  try { await env.CACHE.put(k, JSON.stringify(v), { expirationTtl: CACHE_TTL }); } catch {}
}

/* ------------------------- Isıtma / bench ------------------------- */

async function warm(env) {
  try { await env.AI.run(MODEL, { messages: [{ role: "user", content: "ok" }], max_tokens: 1 }); } catch {}
}

async function prewarm(env, q, context) {
  const key = cacheKey(q);
  if (await kvGet(env, key)) return;
  const s = await search(env, q, context);
  if (!s) return;
  try {
    const r = await env.AI.run(MODEL, { messages: msgs(q, context, s.text), max_tokens: 40, temperature: 0.1 });
    const t = clean((r.response || "").trim());
    if (confident(t)) await kvPut(env, key, { text: t, refs: s.refs });
  } catch {}
}

/** GET /bench — 8 örnek sorgu, p50/p95 döner. */
async function bench(env) {
  const qs = [
    "Türkiye nüfusu sanırım 85 milyon civarıydı",
    "enflasyon galiba yüzde 35ti",
    "Çanakkale Savaşı hangi yıldı emin değilim",
    "İstanbul'un yüzölçümü neydi",
    "Cumhuriyet kaç yılında ilan edildi tam hatırlamıyorum",
    "asgari ücret sanırım 22 bin lira",
    "Ay'a ilk iniş hangi yıl emin değilim",
    "Türkiye'nin en yüksek dağı neydi",
  ];
  const times = [];
  for (const q of qs) {
    const t = Date.now();
    try {
      const s = await search(env, q, "");
      await env.AI.run(MODEL, { messages: msgs(q, "", s?.text || null), max_tokens: 40, temperature: 0.1 });
    } catch {}
    times.push(Date.now() - t);
  }
  times.sort((a, b) => a - b);
  return Response.json({
    n: times.length,
    p50: times[Math.floor(times.length * 0.5)],
    p95: times[Math.floor(times.length * 0.95)],
    all: times,
  });
}

/* ------------------------- Yardımcılar ---------------------------- */

function confident(t) {
  if (!t || t.length < 2) return false;
  const s = t.toLowerCase();
  return !["emin değil", "bilmiyorum", "bilgim yok", "veri yok"].some((x) => s.includes(x));
}
function clean(t) {
  return String(t).replace(/^["'`\s\-–]+|["'`\s]+$/g, "").split("\n")[0].replace(/\s+/g, " ").slice(0, 140);
}
function strip(s) { return String(s || "").replace(/<[^>]*>/g, "").slice(0, 200); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bad = (m) => new Response(m, { status: 400 });
function cors(r) {
  const h = new Headers(r.headers);
  h.set("access-control-allow-origin", "*");
  h.set("access-control-allow-headers", "content-type");
  h.set("access-control-allow-methods", "GET, POST, OPTIONS");
  return new Response(r.body, { status: r.status, headers: h });
}
