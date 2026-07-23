/**
 * MAI — canlı yayın teyit asistanı, Cloudflare Worker
 *
 * MİMARİ: İKİ AYRI SORU, PARALEL CEVAP
 *
 *   KONU  (nesnel, regex, 0 ms)   : hangi tür bilgi? fresh / semi / static
 *   NİYET (öznel, model, ~200 ms) : konuşmacı bilgi istiyor mu?
 *
 * Bunlar bağımsız sorulardır ve PARALEL çalışır. Niyet kontrolü her zaman
 * kanıt toplamadan kısa sürdüğü için ek gecikme yaratmaz:
 *
 *   ┌─ niyet kontrolü ────────── 200 ms ──┐
 *   ├─ kanıt toplama ─────────── 80-900 ms ┤──> birleş
 *   └─ (paralel)                           ┘
 *
 *   static : model 500-700 ms  -> niyet gizlenir, ek gecikme YOK
 *   semi   : yerel+model 580ms -> niyet gizlenir, ek gecikme YOK
 *   fresh  : web+model 1200ms  -> niyet gizlenir, ek gecikme YOK
 *
 * Niyet "hayır" derse toplanan kanıt çöpe gider — para kaybı ama kullanıcı
 * hiçbir gecikme görmez. INTENT_BEFORE_SEARCH=true ile seri çalıştırılabilir
 * (para tasarrufu, +200 ms).
 *
 * AKIŞ
 *   1. Ön kontrol (regex)     -> kesin elenecekler burada, 0 ms
 *   2. Cache                  -> 10-30 ms
 *   3. Paralel: niyet + kanıt
 *   4. Niyet hayır  -> sessizce dön (ekrana bir şey basılmaz)
 *      Niyet evet   -> kanıtla cevap üret, token token akıt
 */

import { search } from "./search.js";
import { lookupLocal, ingest, isStale, debugQuery } from "./knowledge.js";
import {
  classifyTopic, precheckIntent, route, addTimeContext, buildQuery,
  TOPIC, PRECHECK,
} from "./topic.js";
import { checkIntent } from "./intent.js";
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
          answerModel: MODEL,
          searchProvider: env.SEARCH_PROVIDER || "brave",
          searchKeyConfigured: !!(env.BRAVE_KEY || env.SERPER_KEY || env.EXA_KEY || env.TAVILY_KEY),
          kvCacheBound: !!env.CACHE,
          vectorizeBound: !!env.VEC,
          ingestProtected: !!env.INGEST_TOKEN,
          lexiconVersion: LEX_VERSION,
          intentBeforeSearch: env.INTENT_BEFORE_SEARCH === "true",
        }));

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

      case "/debug":
        return cors(await debugEndpoint(env, url));

      case "/classify":
        return cors(await classifyEndpoint(req, env, url));

      case "/bench":
        return cors(await bench(env, url));

      case "/ingest": {
        if (req.method !== "POST") break;
        const auth = req.headers.get("authorization") || "";
        if (!env.INGEST_TOKEN || auth !== `Bearer ${env.INGEST_TOKEN}`)
          return cors(new Response("unauthorized", { status: 401 }));
        const b = await req.json().catch(() => null);
        if (!b?.items?.length) return cors(bad("items required"));
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
    // Tek satırlık teşhis logu — `npx wrangler tail` ile canlı izlenir.
    // Her istek için: soru, konu sınıfı, niyet kararı, kaynak, süre.
    // Kaynak "no-request" ise ekrana hiçbir şey basılmadı demektir.
    // Soruyu 80 karakterle sınırlıyoruz; log satırı okunabilir kalsın.
    console.log(
      `[check] q="${String(q).slice(0, 80)}" ` +
      `topic=${payload.topicClass} ` +
      `wants=${payload.speakerWantsInfo} ` +
      `by=${payload.intentCheckedBy} ` +
      `src=${payload.source} ` +
      `intentMs=${payload.intentLatencyMs ?? "-"} ` +
      `totalMs=${payload.latencyMs}` +
      (payload.sources?.length ? ` refs=${payload.sources.length}` : "")
    );
    await send("answer", payload);
    await send("done", { latencyMs: ms() });
    return w.close().catch(() => {});
  };

  ctx.waitUntil((async () => {
    /* --- 1. Konu ve niyet ön kontrolü: regex, 0 ms --- */
    const topic = classifyTopic(q);
    const precheck = precheckIntent(q);

    // Kesin bilgi isteği değil -> hiç uğraşma
    if (precheck === PRECHECK.SKIP) {
      return finish({
        text: "", source: "no-request", topicClass: topic,
        intentCheckedBy: "regex", speakerWantsInfo: false,
        latencyMs: ms(), isFinal: true, sources: [],
      });
    }

    const plan = route(topic);

    /* --- 2. Cache --- */
    const key = cacheKey(q);
    if (plan.cache) {
      const hit = await kvGet(env, key);
      if (hit) {
        return finish({
          text: hit.text, source: "cache", topicClass: topic,
          intentCheckedBy: "cache", speakerWantsInfo: true,
          latencyMs: ms(), isFinal: true, sources: hit.refs || [],
        });
      }
    }

    /* --- 3. PARALEL: niyet kontrolü + kanıt toplama --- */
    // Niyet ~200 ms, kanıt 80-900 ms. Paralel koştukları için niyet
    // kontrolü kullanıcıya hiç gecikme yansıtmaz.
    const intentP = checkIntent(env, q, context);

    let evidenceP;
    if (env.INTENT_BEFORE_SEARCH === "true") {
      // Seri mod: önce niyet, sonra arama. Para tasarrufu, +200 ms.
      const intentFirst = await intentP;
      if (!intentFirst.wantsInfo) {
        return finish({
          text: "", source: "no-request", topicClass: topic,
          intentCheckedBy: "model", speakerWantsInfo: false,
          intentLatencyMs: intentFirst.latencyMs,
          latencyMs: ms(), isFinal: true, sources: [],
        });
      }
      evidenceP = gatherEvidence(env, q, context, topic, plan);
    } else {
      // Paralel mod (varsayılan): ikisi birlikte başlar.
      evidenceP = gatherEvidence(env, q, context, topic, plan);
    }

    /* --- 4. Model kendi bilgisiyle cevaplayabiliyorsa (STATIC) --- */
    //
    // ÖNEMLİ: Taslak tokenları niyet ONAYLANMADAN ekrana GÖNDERİLMEZ.
    // Yoksa niyet "hayır" dese bile ekranda bir an metin görünür — tam
    // kaçınmaya çalıştığımız şey (sunucu sormadığı halde metin belirmesi).
    //
    // Çözüm: tokenlar biriktirilir, niyet onaylanınca toplu gönderilir.
    // Gecikme kaybı yok: niyet ~200 ms'de, modelin ilk tokenı ~350 ms'de
    // geliyor. Yani niyet zaten önce dönüyor, bekleme yaratmıyor.
    let intentApproved = null;      // null = henüz bilinmiyor
    const pendingDrafts = [];

    const gatedSend = async (ev, d) => {
      if (ev !== "draft") return send(ev, d);
      if (intentApproved === true) return send(ev, d);
      if (intentApproved === false) return;      // sessizce yut
      pendingDrafts.push(d);                     // henüz bilinmiyor -> beklet
    };

    // Niyet gelir gelmez kuyruğu boşalt
    const gateP = intentP.then(async (r) => {
      intentApproved = r.wantsInfo;
      if (r.wantsInfo) {
        // Sadece en son taslağı gönder — arada kalanlar zaten eskimiş
        const last = pendingDrafts[pendingDrafts.length - 1];
        if (last) await send("draft", last);
      }
      pendingDrafts.length = 0;
      return r;
    });

    let modelAnswer = null;
    if (plan.modelOK) {
      modelAnswer = await runStreaming(env, q, context, null, gatedSend, ms);
    }

    /* --- 5. Niyet sonucunu bekle --- */
    const intent = await gateP;
    if (!intent.wantsInfo) {
      // Konuşmacı bir şey sormamış. Toplanan kanıt çöpe gider ama
      // ekrana hiçbir şey basılmaz — asıl önemli olan bu.
      return finish({
        text: "", source: "no-request", topicClass: topic,
        intentCheckedBy: "model", speakerWantsInfo: false,
        intentLatencyMs: intent.latencyMs, intentRawResponse: intent.raw,
        latencyMs: ms(), isFinal: true, sources: [],
      });
    }

    /* --- 6. Cevap üret --- */
    const common = {
      topicClass: topic, intentCheckedBy: "model", speakerWantsInfo: true,
      intentLatencyMs: intent.latencyMs, isFinal: true,
    };

    if (modelAnswer && confident(modelAnswer)) {
      const out = { ...common, text: clean(modelAnswer), source: "model", latencyMs: ms(), sources: [] };
      if (plan.ttl) ctx.waitUntil(kvPut(env, key, { text: out.text, refs: [] }, plan.ttl));
      return finish(out);
    }

    const ev = await Promise.race([evidenceP, sleep(HARD_CAP_MS).then(() => null)]);
    if (ev) {
      const a = await runStreaming(env, q, context, ev.text, gatedSend, ms);
      if (confident(a)) {
        const out = { ...common, text: clean(a), source: ev.src, latencyMs: ms(), sources: ev.refs || [] };
        if (plan.ttl) ctx.waitUntil(kvPut(env, key, { text: out.text, refs: out.sources }, plan.ttl));
        return finish(out);
      }
    }

    // Kanıt yok / model emin değil -> sus. Uydurmaktan iyidir.
    return finish({ ...common, text: "EMİN DEĞİLİM", source: "none", latencyMs: ms(), sources: [] });
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
 * SEMI'de ikisi paralel koşar; yerel öncelikli (çok daha hızlı, ücretsiz).
 */
async function gatherEvidence(env, q, context, topic, plan) {
  // ÖNCE YEREL — çok hızlı (~80ms) ve ücretsiz.
  // Yerel bilgi tabanı (Vectorize) enflasyon, asgari ücret gibi ayda bir
  // değişen rakamları tutuyor. Bulursa web'e HİÇ gitmiyoruz: ne gecikme,
  // ne arama ücreti.
  if (plan.local) {
    const local = await lookupLocal(env, q).catch((e) => {
      // Sessizce yutmuyoruz: Vectorize bağlanamadıysa/hata verdiyse
      // görünsün, yoksa "neden hep web'e düşüyor" diye aranır.
      console.error(`[evidence] vectorize hata: ${e?.message || e}`);
      return null;
    });
    if (local && !isStale(local.fresh, local.maxDays)) {
      return { ...local, src: "local" };
    }
    if (local) {
      console.log(`[evidence] yerel kayıt BAYAT (maxDays=${local.maxDays}) -> web'e düşülüyor`);
    } else {
      console.log(`[evidence] yerel eşleşme yok -> web'e düşülüyor`);
    }
    // Yerelde yok veya bayat -> web'e düş (aşağıda)
  }

  // Yerelde bulunamadıysa web.
  // NEDEN SERİ (paralel değil): yerel zaten 80ms, kaybetse bile az kayıp.
  // Paralel olsaydı yerel kazandığında bile web araması yapılmış olurdu
  // (boşa ücret). Seri: yerel varsa web hiç başlamaz.
  if (plan.web) {
    const qq = addTimeContext(buildQuery(q, context), topic);
    const web = await search(env, qq).catch((e) => {
      console.error(`[evidence] web arama hata: ${e?.message || e}`);
      return null;
    });
    if (web) return { ...web, src: "web" };
    console.log(`[evidence] web sonuç döndürmedi: "${qq}"`);
  }

  // Hiçbir kaynak bulunamadı. plan.modelOK false ise cevap verilmeyecek.
  console.log(`[evidence] kanıt YOK (local=${plan.local} web=${plan.web} modelOK=${plan.modelOK})`);
  return null;
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
      await send("draft", { text: clean(acc), latencyMs: ms() });
    }
  } catch {
    try {
      const r = await env.AI.run(MODEL, {
        messages: msgs(q, context, evidence),
        max_tokens: MAX_TOKENS, temperature: 0.1,
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
  if (precheckIntent(q) === PRECHECK.SKIP) return;

  const topic = classifyTopic(q);
  const plan = route(topic);
  const key = cacheKey(q);
  if (await kvGet(env, key)) return;

  // Spekülatif turda niyet kontrolü yapılır; "hayır" ise cache'e
  // hiçbir şey yazılmaz, asıl istek geldiğinde de yazılmayacak.
  const [intent, ev] = await Promise.all([
    checkIntent(env, q, context),
    gatherEvidence(env, q, context, topic, plan),
  ]);
  if (!intent.wantsInfo) return;
  if (!ev && !plan.modelOK) return;

  try {
    const r = await env.AI.run(MODEL, {
      messages: msgs(q, context, ev?.text || null),
      max_tokens: MAX_TOKENS, temperature: 0.1,
    });
    const t = clean((r.response || "").trim());
    if (confident(t)) await kvPut(env, key, { text: t, refs: ev?.refs || [] }, plan.ttl);
  } catch {}
}

/* ------------------------- Teşhis uçları -------------------------- */

async function debugEndpoint(env, url) {
  const q = url.searchParams.get("q");
  if (!q) return bad("q required");
  const context = url.searchParams.get("ctx") || "";

  const topic = classifyTopic(q);
  const precheck = precheckIntent(q);
  const plan = route(topic);

  // Niyet ve kanıt paralel — canlı akıştaki davranışın aynısı
  const [intent, vec, webResult] = await Promise.all([
    precheck === PRECHECK.SKIP ? null : checkIntent(env, q, context),
    debugQuery(env, q),
    (async () => {
      const sq = addTimeContext(buildQuery(q, context), topic);
      const t = Date.now();
      try {
        const r = await search(env, sq);
        return { query: sq, ms: Date.now() - t, error: null, result: r };
      } catch (e) {
        return { query: sq, ms: Date.now() - t, error: String(e?.message || e), result: null };
      }
    })(),
  ]);

  return Response.json({
    question: q,

    // EKSEN 1 — niyet: konuşmacı bilgi istiyor mu
    intent: {
      regexPrecheck: precheck,              // skip = regex kesin eledi, model çağrılmadı
      decidedBy: precheck === PRECHECK.SKIP ? "regex" : "model",
      speakerWantsInfo: precheck === PRECHECK.SKIP ? false : intent.wantsInfo,
      latencyMs: intent?.latencyMs ?? 0,
      rawResponse: intent?.raw ?? null,
    },

    // EKSEN 2 — konu: hangi tür bilgi
    topic: {
      topicClass: topic,
      routingPlan: {
        willCheckCache: plan.cache,
        willCheckVectorize: plan.local,
        willSearchWeb: plan.web,
        modelMayAnswerAlone: plan.modelOK,
        cacheTtlSeconds: plan.ttl,
      },
    },

    vectorizeLookup: vec,

    webSearch: {
      provider: env.SEARCH_PROVIDER || "brave",
      apiKeyConfigured: !!(env.BRAVE_KEY || env.SERPER_KEY || env.EXA_KEY || env.TAVILY_KEY),
      generatedQuery: webResult.query,
      searchMs: webResult.ms,
      error: webResult.error,
      resultFound: !!webResult.result,
      evidencePreview: webResult.result?.text?.slice(0, 400) || null,
    },
  });
}

async function classifyEndpoint(req, env, url) {
  const texts =
    req.method === "POST"
      ? (await req.json().catch(() => ({}))).texts || []
      : [url.searchParams.get("q") || ""].filter(Boolean);

  if (!texts.length) return bad("q or texts required");

  const out = [];
  for (const text of texts.slice(0, 40)) {
    const topic = classifyTopic(text);
    const precheck = precheckIntent(text);
    const intent = precheck === PRECHECK.SKIP ? null : await checkIntent(env, text);
    const plan = route(topic);

    out.push({
      text,
      topicClass: topic,
      intentRegexPrecheck: precheck,
      intentDecidedBy: precheck === PRECHECK.SKIP ? "regex" : "model",
      speakerWantsInfo: precheck === PRECHECK.SKIP ? false : intent.wantsInfo,
      intentLatencyMs: intent?.latencyMs ?? 0,
      intentRawResponse: intent?.raw ?? null,
      willAnswer: precheck !== PRECHECK.SKIP && intent.wantsInfo,
      routingPlan: {
        willCheckVectorize: plan.local,
        willSearchWeb: plan.web,
        modelMayAnswerAlone: plan.modelOK,
        cacheTtlSeconds: plan.ttl,
      },
    });
  }

  const modelChecked = out.filter((x) => x.intentDecidedBy === "model");
  const answered = out.filter((x) => x.willAnswer);

  return Response.json({
    questionsAnalyzed: out.length,
    regexResolvedCount: out.length - modelChecked.length,
    modelCheckedCount: modelChecked.length,
    willAnswerCount: answered.length,
    intentAvgLatencyMs: modelChecked.length
      ? Math.round(modelChecked.reduce((a, b) => a + b.intentLatencyMs, 0) / modelChecked.length)
      : 0,
    results: out,
  });
}

/* ------------------------- Bench ---------------------------------- */

async function bench(env, url) {
  const QS = [
    "dünkü maç ne olmuş acaba",
    "Veysel asgari ücret ne oldu",
    "enflasyon galiba yüzde 35ti",
    "Çanakkale Savaşı hangi yıldı emin değilim",
    "grev bitmiş miydi acaba",
    "Türkiye'nin en yüksek dağı neydi",
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
    const byTopic = {};
    let intentTotal = 0, intentCount = 0;

    for (const q of QS) {
      const t = Date.now();
      const topic = classifyTopic(q);
      const plan = route(topic);

      // Canlı akıştaki gibi paralel
      const [intent, ev] = await Promise.all([
        checkIntent(scoped, q, ""),
        gatherEvidence(scoped, q, "", topic, plan),
      ]);
      intentTotal += intent.latencyMs; intentCount++;

      try {
        await env.AI.run(MODEL, {
          messages: msgs(q, "", ev?.text || null),
          max_tokens: MAX_TOKENS, temperature: 0.1,
        });
      } catch {}

      const d = Date.now() - t;
      all.push(d);
      (byTopic[topic] ||= []).push(d);
    }

    report[p] = {
      latencyP50Ms: pct(all, 0.5),
      latencyP95Ms: pct(all, 0.95),
      latencyByTopicMs: Object.fromEntries(
        Object.entries(byTopic).map(([k, v]) => [k, pct(v, 0.5)])
      ),
      intentAvgLatencyMs: intentCount ? Math.round(intentTotal / intentCount) : 0,
    };
  }

  const best = Object.entries(report)
    .filter(([k]) => k !== "none")
    .sort((a, b) => a[1].latencyP95Ms - b[1].latencyP95Ms)[0];
  const p95 = best?.[1]?.latencyP95Ms;

  return Response.json({
    activeProvider: env.SEARCH_PROVIDER || "brave",
    kvCacheBound: !!env.CACHE,
    vectorizeBound: !!env.VEC,
    intentBeforeSearch: env.INTENT_BEFORE_SEARCH === "true",
    latencyByProvider: report,
    fastestProvider: best?.[0] || null,
    verdict: !best ? "NO_PROVIDER"
      : p95 < 2500 ? "VIABLE"
      : p95 < 4000 ? "DISABLE_WEB_SEARCH"
      : "DROP_LIVE_MODE",
    recommendation: !best
      ? "No search provider configured. Set a key or SEARCH_PROVIDER=none."
      : p95 < 2500
        ? `p95 ${p95}ms — live mode is viable, continue building.`
        : p95 < 4000
        ? `p95 ${p95}ms — too slow with web search. Set SEARCH_PROVIDER="none" and rely on Vectorize + model.`
        : `p95 ${p95}ms — live mode is not viable. Switch to post-recording reports.`,
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
