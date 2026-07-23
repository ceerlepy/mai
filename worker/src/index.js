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
/**
 * Cevap uzunluğu tavanı.
 *
 * 56 token ≈ 14-18 Türkçe kelime. Cümlenin uzunluğunu PROMPT belirlemeli,
 * bu tavan sadece kaçak koruması olmalı — asla cümleyi kesen şey olmamalı.
 *
 * Önceki değer 28 idi ve cümleleri ORTADAN KESİYORDU. Türkçe kelimeler
 * Llama tokenizer'ında 2-5 token: "Fenerbahçe," ~5, "Zabrze'yi" ~5,
 * "maçında" ~4. Ölçülen vaka: 11 kelimelik cevap ~34 token ederek 28
 * sınırına dayandı ve skor yazılamadan kesildi:
 *   "Fenerbahçe, Şampiyonlar Ligi 2. ön eleme turu ilk maçında Gornik Zabrze'yi"
 * Aynı hata intent.js'te de yapılmıştı (bkz. oradaki max_tokens notu).
 *
 * Maliyeti: token başına ~3.5 ms akış. 28 fazladan token ≈ +100 ms en kötü
 * durumda, ama prompt kısa cevap istediği için pratikte kullanılmıyor.
 */
const MAX_TOKENS = 56;
const CACHE_TTL = 21600;

// Kısa tutuldu: uzun prompt = uzun prefill = geç ilk token.
// Kısa tutuldu: uzun prompt = uzun prefill = geç ilk token.
// Örnekler yine de duruyor çünkü model onlarsız bağlamı öne alıp
// cevabı sona bırakıyor ("Fenerbahçe, Şampiyonlar Ligi 2. ön eleme
// turu ilk maçında Gornik Zabrze'yi..." gibi).
//
// ÖRNEKLERDE GERÇEK, GÜNCEL VARLIK KULLANMA. İlk sürümde örnek
// "Fenerbahçe 1-0 kazandı (Talisca 37')" idi ve model Fenerbahçe
// sorulduğunda kanıta bakmadan bu örneği KOPYALADI.
//
// AMA "..." İLE DE BAŞLATMA. İkinci sürümde örnek "... 2-1 kazandı"
// idi; model "..."yi "özneyi yazma" talimatı sanıp "1-0 kazandı."
// üretti — kimin kazandığı belirsiz kaldı. Çözüm: uydurma ama SOMUT
// bir özne kullanmak (Aksaray/Demirspor gerçek güncel takım değil).
const SYS = `Canlı yayında sunucunun kulağındaki yardımcısın.
Ekranda saniyeler kalacak: EN KISA cevabı ver, hikâye anlatma.
ÖZNEYİ MUTLAKA YAZ — kimin/neyin olduğu belli olsun.
Biçim örnekleri (içeriği DEĞİL, biçimi taklit et):
  "Aksaray 2-1 kazandı (Yılmaz 62')."
  "Yıllık oran %12,34."
  "Toplantı 8 Mart'ta."
TEK cümle, en fazla 10 kelime, Türkçe.
Sadece KANITTAKİ bilgiyi yaz; örnekteki isim/rakamları asla kullanma.
Skoru TAM yaz ("2-1"), "2-" yazma.
Emin değilsen sadece: EMİN DEĞİLİM
"sanırım/galiba" yazma. Giriş, açıklama, selamlama yok.`;

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
          queryWriter: String(env.QUERY_WRITER || "model").toLowerCase(),
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
      evidenceP = gatherEvidence(env, q, context, topic, plan, null);
    } else {
      // Paralel mod (varsayılan): ikisi birlikte başlar.
      // intentP geçiliyor -> web araması modelin yazdığı sorguyu kullanır.
      evidenceP = gatherEvidence(env, q, context, topic, plan, intentP);
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
        // Yarım kalan skoru kanıttan tamamla (bkz. repairScore).
        // Kanıtta tam skor yoksa cevaba dokunulmaz.
        const onarilmis = repairScore(clean(a), ev.text);

        // Onarımdan SONRA doğrula: cevaptaki her sayı kanıtta geçmeli.
        // Geçmiyorsa model uydurmuş demektir -> sus.
        if (!numbersGrounded(onarilmis, ev.text)) {
          return finish({ ...common, text: "EMİN DEĞİLİM", source: "none", latencyMs: ms(), sources: [] });
        }

        const out = { ...common, text: onarilmis, source: ev.src, latencyMs: ms(), sources: ev.refs || [] };
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
/**
 * Kanıt toplar. Yerel önce, sonra web.
 *
 * @param intentP  niyet kontrolü sözü (Promise). Model hem "istiyor mu"
 *                 kararını hem ARAMA SORGUSUNU aynı çağrıda döndürüyor.
 *
 * PARALELLİK KORUNUYOR: Vectorize sorgusu ham cümleyle yapılıyor, modelin
 * yazdığı sorguya ihtiyacı yok — bu yüzden niyeti BEKLEMEDEN başlıyor.
 * Sadece web araması niyeti bekliyor, çünkü doğru sorguyu o üretiyor.
 * Yerel isabet olursa web'e hiç gidilmiyor ve bekleme de yaşanmıyor.
 */
async function gatherEvidence(env, q, context, topic, plan, intentP = null) {
  // ÖNCE YEREL — çok hızlı (~80ms) ve ücretsiz.
  // Yerel bilgi tabanı (Vectorize) enflasyon, asgari ücret gibi ayda bir
  // değişen rakamları tutuyor. Bulursa web'e HİÇ gitmiyoruz: ne gecikme,
  // ne arama ücreti.
  if (plan.local) {
    const local = await lookupLocal(env, q).catch((e) => {
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
  }

  // Yerelde bulunamadıysa web.
  // NEDEN SERİ (paralel değil): yerel zaten 80ms, kaybetse bile az kayıp.
  // Paralel olsaydı yerel kazandığında bile web araması yapılmış olurdu
  // (boşa ücret). Seri: yerel varsa web hiç başlamaz.
  if (plan.web) {
    // Modelin yazdığı sorguyu bekle. Niyet çağrısı zaten paralel koşuyordu,
    // yerel arama sırasında ilerledi; kalan bekleme kısa.
    // QUERY_WRITER="model" ise sorguyu model yazar ve arama onu bekler
    // (+~370ms). "regex" (varsayılan) ise beklemeden regex sorgusuyla
    // arama başlar — ölçümde regex sorgusu da doğru sayfaları buldu.
    const modelYazsin = String(env.QUERY_WRITER || "model").toLowerCase() === "model";
    const intent = modelYazsin && intentP ? await intentP.catch(() => null) : null;

    // Model "istemiyor" dediyse arama yapmaya gerek yok — para tasarrufu.
    if (intent && intent.wantsInfo === false) {
      console.log(`[evidence] niyet HAYIR -> arama yapılmadı`);
      return null;
    }

    // Modelin sorgusu varsa onu kullan; yoksa regex sorgusuna düş.
    // Regex yedeği şart: model timeout olabilir ya da sorgu satırını
    // atlayabilir. O durumda arama yapmamaktansa zayıf sorgu daha iyi.
    const modelQuery = intent?.searchQuery || null;
    const qq = modelQuery
      ? addTimeContext(modelQuery, topic, q)
      : addTimeContext(buildQuery(q, context), topic, q);

    console.log(`[evidence] arama sorgusu (${modelQuery ? "model" : "regex"}): "${qq}"`);

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
        // DİKKAT — `if (j.response)` YAZMA.
        //
        // Token sayı olarak gelebiliyor: {"response": 0}. JavaScript'te
        // sayı 0 falsy olduğu için o token SESSİZCE ATLANIR ve skorun
        // ikinci hanesi kaybolur: "1-0" yerine "1-" çıkar.
        // Üç bağımsız denemede tekrarlanan davranış buydu.
        //
        // Boş string atlanmalı (bilgi taşımıyor), ama 0 ve "0" geçmeli.
        const tok = j.response;
        if (tok !== undefined && tok !== null && tok !== "") {
          yield String(tok);
        }
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
  // Niyet sözünü tek kez oluşturup hem karar hem sorgu için kullan.
  const intentP = checkIntent(env, q, context);
  const [intent, ev] = await Promise.all([
    intentP,
    gatherEvidence(env, q, context, topic, plan, intentP),
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

  // Niyet ve Vectorize paralel; web araması niyeti bekler çünkü sorguyu
  // artık model yazıyor (canlı akıştaki davranışın aynısı).
  const intentP = precheck === PRECHECK.SKIP ? Promise.resolve(null) : checkIntent(env, q, context);

  const [intent, vec, webResult] = await Promise.all([
    intentP,
    debugQuery(env, q),
    (async () => {
      const it = await intentP.catch(() => null);
      const modelQuery = it?.searchQuery || null;
      const sq = modelQuery
        ? addTimeContext(modelQuery, topic, q)
        : addTimeContext(buildQuery(q, context), topic, q);
      const t = Date.now();
      try {
        const r = await search(env, sq);
        return { query: sq, writtenBy: modelQuery ? "model" : "regex", ms: Date.now() - t, error: null, result: r };
      } catch (e) {
        return { query: sq, writtenBy: modelQuery ? "model" : "regex", ms: Date.now() - t, error: String(e?.message || e), result: null };
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
      queryWrittenBy: webResult.writtenBy,   // model | regex (yedek)
      searchMs: webResult.ms,
      error: webResult.error,
      resultFound: !!webResult.result,
      // Modele giden kanıtın TAMAMI. Kırpmıyoruz: eksik bilgi teşhisi
      // (ör. skorun kanıtta olup olmadığı) ancak tam metinle yapılabiliyor.
      evidenceFull: webResult.result?.text || null,
      evidenceLength: webResult.result?.text?.length || 0,
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
    // 200 karakter: MAX_TOKENS=56 yaklaşık 200 karaktere denk geliyor.
    // Bu sınır da cümleyi kesen şey OLMAMALI — uzunluğu prompt belirliyor,
    // buradaki tavan sadece kaçak koruması. 140 iken 56 token'lık bir
    // cevabı ortadan kesebilirdi (aynı hata MAX_TOKENS'ta yaşandı).
    .slice(0, 200);
}

/**
 * SAYI DOĞRULAMA — uydurmaya karşı genel ağ.
 *
 * Teyit uygulamasında en tehlikeli hata, kanıtta olmayan bir sayının
 * güvenle söylenmesi. Model kanıttan sapıp kendi eğitim verisindeki bir
 * rakamı yazabiliyor.
 *
 * Kural: cevaptaki HER sayı kanıt metninde de geçmeli. Geçmiyorsa cevap
 * güvenilmez sayılır ve "EMİN DEĞİLİM" gösterilir.
 *
 * Tolerans: ondalık ayraç farkları (32,11 / 32.11) ve binlik ayraçlar
 * normalize ediliyor. Yıl gibi bağlam sayıları da kanıtta genelde geçtiği
 * için sorun çıkarmıyor; çıkarsa istisna listesi eklenir.
 */
function numbersGrounded(answer, evidenceText) {
  if (!answer || !evidenceText) return true;

  const norm = (x) => x.replace(/[.,]/g, "");
  const kanit = norm(evidenceText);

  // 2+ haneli sayılar kontrol edilir. Tek haneliler ("1-0" gibi zaten
  // repairScore'un alanı) çok yaygın, yanlış alarm üretir.
  const sayilar = answer.match(/\d[\d.,]{1,}/g) || [];
  for (const sy of sayilar) {
    if (!kanit.includes(norm(sy))) {
      console.log(`[grounding] cevaptaki "${sy}" kanıtta yok -> güvenilmez`);
      return false;
    }
  }
  return true;
}

/**
 * YARIM SKOR ONARIMI.
 *
 * Küçük model tireli sayılarda ikinci rakamı atlayabiliyor: kanıtta
 * "1-0 galip ayrıldı" yazmasına rağmen "maçı 1- bitti" üretiyor.
 * Ölçülen, tekrarlanabilir bir davranış (iki bağımsız denemede aynı).
 *
 * Burada modeli düzeltmiyoruz, sadece EKSİK KALAN rakamı KANITTAN
 * tamamlıyoruz. Uydurma yok: kanıtta tam skor yoksa cevaba dokunulmuyor.
 *
 * Örnek: cevap "... maçı 1- bitti", kanıt "... 1-0 galip ayrıldı"
 *        -> "... maçı 1-0 bitti"
 */
function repairScore(answer, evidenceText) {
  if (!answer || !evidenceText) return answer;

  // Cevapta "rakam + tire" var ama ardından rakam YOK mu?
  const yarim = answer.match(/(\d{1,2})-(?!\d)/);
  if (!yarim) return answer;

  const ilkSayi = yarim[1];

  // Kanıtta aynı ilk sayıyla başlayan TAM skor ara: "1-0", "2-1" ...
  const tam = evidenceText.match(new RegExp(`\\b${ilkSayi}-(\\d{1,2})\\b`));
  if (!tam) return answer;   // kanıtta yok -> dokunma

  return answer.replace(`${ilkSayi}-`, `${ilkSayi}-${tam[1]}`);
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
