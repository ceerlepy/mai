/**
 * Teyit Asistanı — Worker
 *
 * AKIŞ (soru tipine göre; router.js belirler)
 *
 *   cache hit ─────────────────────────────────────── 10-30 ms
 *   SUBJ   (bence/sence)       -> sus                     ~0 ms
 *   STATIC (tarih/coğrafya)    -> model streaming     400-700 ms
 *   SEMI   (enflasyon/nüfus)   -> yerel ∥ web          80-1400 ms
 *   FRESH  (dünkü maç/konser)  -> web + streaming    1100-1600 ms
 *
 * GECİKME OPTİMİZASYONLARI
 *   - Sistem promptu kısa (her token = prefill süresi)
 *   - max_tokens 28 (12 kelime Türkçe ≈ 24-30 token)
 *   - SEMI'de yerel ve web PARALEL koşar
 *   - TÜM yollarda token streaming -> ilk kelime ~350-450ms'de ekranda
 *   - FRESH'te model-only yolu HİÇ çalışmaz (uydurma riski)
 */

import { search, buildQuery } from "./search.js";
import { lookupLocal, ingest, isStale } from "./knowledge.js";
import { classify, route, addTimeContext, CLASS } from "./router.js";
import { triage } from "./triage.js";
import { lexiconPayload, VERSION as LEX_VERSION } from "./lexicon.js";

const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
const HARD_CAP_MS = 2400;
const MAX_TOKENS = 28;
const CACHE_TTL = 21600;

// Kısa tutuldu: uzun prompt = uzun prefill = geç ilk token.
const SYS = `Canlı yayın sunucusunun kulağındaki yardımcısın.
TEK cümle, en fazla 12 kelime, Türkçe.
Rakam sorulduysa rakam, tarih sorulduysa tarih ver.
Emin değilsen sadece: EMİN DEĞİLİM
"sanırım/galiba/muhtemelen" yazma. Açıklama, giriş, selamlama yok.
Kimseyi yalanlama; sadece doğru bilgiyi yaz.`;

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    switch (url.pathname) {
      case "/health":
        return cors(Response.json({
          ok: true,
          model: MODEL,
          provider: env.SEARCH_PROVIDER || "brave",
          cache: !!env.CACHE,
          vectorize: !!env.VEC,
        }));

      /**
       * GET /lexicon — Android uygulaması açılışta çeker.
       * Kelime listesi güncellemek için APK derlemeye gerek yok:
       * lexicon.js'i düzenle, deploy et, uygulama sonraki açılışta alır.
       */
      case "/lexicon":
        return cors(new Response(JSON.stringify(lexiconPayload()), {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "public, max-age=3600",
            "x-lexicon-version": String(LEX_VERSION),
          },
        }));

      case "/warm":
        ctx.waitUntil(warm(env));
        return cors(Response.json({ ok: true }));

      case "/check":
        if (req.method !== "POST") break;
        return handleCheck(req, env, ctx);

      case "/bench":
        return cors(await bench(env, url));

      /**
       * GET /classify?q=...   tek cümleyi sınıflandırır
       * POST /classify {texts:[...]}  toplu test
       *
       * Triyaj GERÇEKTEN çalıştırılır -> modelin ne dediğini ve kaç ms
       * sürdüğünü görürsün. Deploy sonrası triage.js'i doğrulamak için.
       */
      case "/classify": {
        const texts =
          req.method === "POST"
            ? (await req.json().catch(() => ({}))).texts || []
            : [url.searchParams.get("q") || ""].filter(Boolean);

        if (!texts.length) return cors(bad("q veya texts gerekli"));

        const out = [];
        for (const text of texts.slice(0, 40)) {
          const t = Date.now();
          const regexCls = classify(text);
          const regexMs = Date.now() - t;

          let finalCls = regexCls, triageMs = 0, triageRan = false;
          if (regexCls === CLASS.UNSURE) {
            const t2 = Date.now();
            finalCls = await triage(env, text);
            triageMs = Date.now() - t2;
            triageRan = true;
          }

          const p = route(finalCls);
          out.push({
            metin: text,
            regex_sinif: regexCls,
            triyaj_calisti: triageRan,
            triyaj_sonuc: triageRan ? finalCls : null,
            triyaj_ms: triageMs,
            regex_ms: regexMs,
            plan: { yerel: p.local, web: p.web, model: p.modelOK, ttl: p.ttl },
          });
        }

        const triyajlilar = out.filter((x) => x.triyaj_calisti);
        return cors(Response.json({
          toplam: out.length,
          triyaj_orani: `${triyajlilar.length}/${out.length}`,
          triyaj_ortalama_ms: triyajlilar.length
            ? Math.round(triyajlilar.reduce((a, b) => a + b.triyaj_ms, 0) / triyajlilar.length)
            : 0,
          sonuclar: out,
        }));
      }

      case "/ingest": {
        if (req.method !== "POST") break;
        const auth = req.headers.get("authorization") || "";
        if (!env.INGEST_TOKEN || auth !== `Bearer ${env.INGEST_TOKEN}`)
          return cors(new Response("yetkisiz", { status: 401 }));
        const b = await req.json().catch(() => null);
        if (!b?.items?.length) return cors(bad("items gerekli"));
        return cors(Response.json(await ingest(env, b.items)));
      }
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
  if (!q || q.length > 400) return cors(bad("query"));

  // Spekülatif: cevap dönmez, sadece cache ısıtılır.
  if (body.spec === true) {
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
  const ms = () => Date.now() - t0;

  const send = (ev, d) =>
    w.write(enc.encode(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`)).catch(() => {});

  const finish = async (payload) => {
    await send("answer", payload);
    await send("done", { ms: ms() });
    return w.close().catch(() => {});
  };

  ctx.waitUntil((async () => {
    // ---- 0. Sınıflandırma: LLM'siz, regex, ~0ms ----
    let cls = classify(q);
    let triaged = false;

    // ---- 0b. Triyaj: regex karar veremediyse modele TEK ikili soru ----
    // Sadece UNSURE sınıfında çalışır (~%10). Diğer %90 hiç etkilenmez.
    // Ek gecikme ~150-250ms; full function calling olsaydı ~500ms olurdu.
    if (cls === CLASS.UNSURE) {
      cls = await triage(env, q);
      triaged = true;
    }

    const plan = route(cls);

    if (cls === CLASS.SUBJ) {
      return finish({ text: "EMİN DEĞİLİM", src: "öznel", cls, triaged, ms: ms(), final: true, refs: [] });
    }

    // ---- 1. Cache ----
    const key = cacheKey(q);
    if (plan.cache) {
      const hit = await kvGet(env, key);
      if (hit) {
        return finish({ text: hit.text, src: "cache", cls, triaged, ms: ms(), final: true, refs: hit.refs || [] });
      }
    }

    // ---- 2. Kanıt toplama (arka planda başlasın) ----
    const evidenceP = gatherEvidence(env, q, context, cls, plan);

    // ---- 3a. STATIC: model kendi bilgisiyle, hemen streaming ----
    if (plan.modelOK) {
      const a = await runStreaming(env, q, context, null, send, ms);
      if (confident(a)) {
        const out = { text: clean(a), src: "model", cls, triaged, ms: ms(), final: true, refs: [] };
        if (plan.ttl) ctx.waitUntil(kvPut(env, key, { text: out.text, refs: [] }, plan.ttl));
        return finish(out);
      }
      // Model bilmiyorsa kanıtla tekrar dener
    }

    // ---- 3b. Kanıtlı cevap, yine streaming ----
    const ev = await Promise.race([evidenceP, sleep(HARD_CAP_MS).then(() => null)]);

    if (ev) {
      const a = await runStreaming(env, q, context, ev.text, send, ms);
      if (confident(a)) {
        const out = { text: clean(a), src: ev.src, cls, triaged, ms: ms(), final: true, refs: ev.refs || [] };
        if (plan.ttl) ctx.waitUntil(kvPut(env, key, { text: out.text, refs: out.refs }, plan.ttl));
        return finish(out);
      }
    }

    // Kanıt yok / model emin değil -> sus. Uydurmaktan iyidir.
    return finish({ text: "EMİN DEĞİLİM", src: "yok", cls, triaged, ms: ms(), final: true, refs: [] });
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

/* ------------------------- Kanıt toplama -------------------------- */

/**
 * plan.local / plan.web'e göre kanıt toplar.
 * SEMI'de ikisi PARALEL koşar; yerel öncelikli (çok daha hızlı).
 */
async function gatherEvidence(env, q, context, cls, plan) {
  const tasks = [];

  if (plan.local) {
    tasks.push(
      lookupLocal(env, q)
        .then((r) => (r && !isStale(r.fresh) ? { ...r, src: "yerel", prio: 0 } : null))
        .catch(() => null)
    );
  }

  if (plan.web) {
    const qq = addTimeContext(buildQuery(q, context), cls);
    tasks.push(
      search(env, qq)
        .then((r) => (r ? { ...r, src: "web", prio: 1 } : null))
        .catch(() => null)
    );
  }

  if (!tasks.length) return null;

  const results = await Promise.all(tasks);
  const ok = results.filter(Boolean).sort((a, b) => a.prio - b.prio);
  return ok[0] || null;
}

/* ------------------------- Model ---------------------------------- */

function msgs(q, context, evidence) {
  const p = [];
  if (context) p.push(`Önceki: ${context}`);
  if (evidence) p.push(`Kaynaklar:\n${evidence}`);
  p.push(`Emin olunamayan ifade: "${q}"`);
  return [
    { role: "system", content: SYS },
    { role: "user", content: p.join("\n\n") },
  ];
}

/** Modeli streaming çalıştırır, tokenları "draft" olarak akıtır. */
async function runStreaming(env, q, context, evidence, send, ms) {
  let acc = "";
  try {
    const s = await env.AI.run(MODEL, {
      messages: msgs(q, context, evidence),
      max_tokens: MAX_TOKENS,
      temperature: 0.1,
      stream: true,
    });
    for await (const tok of sseTokens(s)) {
      acc += tok;
      await send("draft", { text: clean(acc), ms: ms() });
    }
  } catch {
    try {
      const r = await env.AI.run(MODEL, {
        messages: msgs(q, context, evidence),
        max_tokens: MAX_TOKENS,
        temperature: 0.1,
      });
      acc = r.response || "";
    } catch {}
  }
  return acc.trim();
}

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
async function kvPut(env, k, v, ttl) {
  if (!env.CACHE) return;
  try { await env.CACHE.put(k, JSON.stringify(v), { expirationTtl: ttl || CACHE_TTL }); } catch {}
}

/* ------------------------- Isıtma / prewarm ----------------------- */

async function warm(env) {
  try {
    await env.AI.run(MODEL, { messages: [{ role: "user", content: "ok" }], max_tokens: 1 });
  } catch {}
}

/** Spekülatif: cümle bitmeden kanıtı toplar, cevabı cache'e yazar. */
async function prewarm(env, q, context) {
  let cls = classify(q);
  // Spekülatif turda da triyaj yapılır; sonucu cache'e yazıldığı için
  // asıl istek geldiğinde triyaj bedeli HİÇ ödenmez.
  if (cls === CLASS.UNSURE) cls = await triage(env, q);
  const plan = route(cls);
  if (cls === CLASS.SUBJ || !plan.cache) return;

  const key = cacheKey(q);
  if (await kvGet(env, key)) return;

  const ev = await gatherEvidence(env, q, context, cls, plan);
  if (!ev && !plan.modelOK) return;

  try {
    const r = await env.AI.run(MODEL, {
      messages: msgs(q, context, ev?.text || null),
      max_tokens: MAX_TOKENS,
      temperature: 0.1,
    });
    const t = clean((r.response || "").trim());
    if (confident(t)) await kvPut(env, key, { text: t, refs: ev?.refs || [] }, plan.ttl);
  } catch {}
}

/* ------------------------- Bench ---------------------------------- */

/**
 * GET /bench         — aktif sağlayıcı, sınıf bazında p50/p95
 * GET /bench?full=1  — anahtarı olan tüm sağlayıcıları yarıştırır
 */
async function bench(env, url) {
  const QS = [
    "dünkü maç ne olmuş acaba",
    "dün konserde bir problem olmuş mu",
    "enflasyon galiba yüzde 35ti",
    "asgari ücret sanırım 22 bin lira",
    "Çanakkale Savaşı hangi yıldı emin değilim",
    "Türkiye'nin en yüksek dağı neydi",
    "grev bitmiş miydi acaba",
    "Kanal İstanbul onaylandı mı emin değilim",
  ];

  const full = url?.searchParams.get("full") === "1";
  const provs = full
    ? ["brave", "serper", "exa", "tavily", "none"].filter(
        (p) =>
          p === "none" ||
          (p === "brave" && env.BRAVE_KEY) ||
          (p === "serper" && env.SERPER_KEY) ||
          (p === "exa" && env.EXA_KEY) ||
          (p === "tavily" && env.TAVILY_KEY)
      )
    : [(env.SEARCH_PROVIDER || "brave").toLowerCase()];

  const report = {};

  for (const p of provs) {
    const scoped = { ...env, SEARCH_PROVIDER: p };
    const all = [];
    const byClass = {};

    for (const q of QS) {
      const t = Date.now();
      let cls = classify(q);
      if (cls === CLASS.UNSURE) cls = await triage(env, q);
      const plan = route(cls);

      const ev = await gatherEvidence(scoped, q, "", cls, plan);
      try {
        await env.AI.run(MODEL, {
          messages: msgs(q, "", ev?.text || null),
          max_tokens: MAX_TOKENS,
          temperature: 0.1,
        });
      } catch {}

      const d = Date.now() - t;
      all.push(d);
      (byClass[cls] ||= []).push(d);
    }

    report[p] = {
      toplam_p50: pct(all, 0.5),
      toplam_p95: pct(all, 0.95),
      sinif_bazinda: Object.fromEntries(
        Object.entries(byClass).map(([k, v]) => [k, `${pct(v, 0.5)}ms`])
      ),
    };
  }

  const best = Object.entries(report)
    .filter(([k]) => k !== "none")
    .sort((a, b) => a[1].toplam_p95 - b[1].toplam_p95)[0];

  return Response.json({
    aktif: env.SEARCH_PROVIDER || "brave",
    cache: !!env.CACHE,
    vectorize: !!env.VEC,
    sonuclar: report,
    karar: best
      ? best[1].toplam_p95 < 2500
        ? `p95 ${best[1].toplam_p95}ms — canlı özellik yaşayabilir, devam`
        : best[1].toplam_p95 < 4000
        ? `p95 ${best[1].toplam_p95}ms — SEARCH_PROVIDER="none" yap, Vectorize+model yoluna geç`
        : `p95 ${best[1].toplam_p95}ms — canlıyı bırak, kayıt-sonrası rapora dön`
      : "sağlayıcı yok",
  });
}

function pct(a, p) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

/* ------------------------- Yardımcılar ---------------------------- */

function confident(t) {
  if (!t || t.length < 2) return false;
  const s = t.toLowerCase();
  return !["emin değil", "bilmiyorum", "bilgim yok", "veri yok", "belirtilmemiş"]
    .some((x) => s.includes(x));
}

function clean(t) {
  return String(t)
    .replace(/^["'`\s\-–]+|["'`\s]+$/g, "")
    .split("\n")[0]
    .replace(/\s+/g, " ")
    .slice(0, 140);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bad = (m) => new Response(m, { status: 400 });

function cors(r) {
  const h = new Headers(r.headers);
  h.set("access-control-allow-origin", "*");
  h.set("access-control-allow-headers", "content-type, authorization");
  h.set("access-control-allow-methods", "GET, POST, OPTIONS");
  return new Response(r.body, { status: r.status, headers: h });
}
