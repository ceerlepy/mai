/**
 * Arama sağlayıcı katmanı.
 *
 * Tek bir sağlayıcıya bağlanmıyoruz — hepsi aynı arayüzü döner:
 *   { text: "kaynak özetleri", refs: [{title, url}] }
 *
 * Seçim: wrangler.toml içindeki SEARCH_PROVIDER değişkeni.
 *
 * ┌──────────┬───────────────┬──────────────┬────────────────────────────┐
 * │ Sağlayıcı│ Fiyat/1000    │ Gecikme      │ Not                        │
 * ├──────────┼───────────────┼──────────────┼────────────────────────────┤
 * │ serper   │ $0.30         │ hızlı        │ VARSAYILAN. En ucuz.       │
 * │ brave    │ $5.00         │ ~669ms (en   │ Harcama tavanı YOK, kart   │
 * │          │ ($5/ay kredi) │ düşük ölçüm) │ zorunlu. Dikkatli ol.      │
 * │ exa      │ orta          │ ~200ms       │ "instant" modu kullanılır  │
 * │ tavily   │ ücretsiz kredi│ basic hızlı  │ advanced modu 5sn+, kullanma│
 * └──────────┴───────────────┴──────────────┴────────────────────────────┘
 *
 * Aylık ~3000 arama (100 yayın) maliyeti:
 *   serper $0.90  ·  brave $15  ·  tavily muhtemelen ücretsiz kredide
 */

const CAP_MS = 950; // aramaya sert tavan — geçerse yol A'ya düşeriz

export async function search(env, query, opts = {}) {
  const provider = (env.SEARCH_PROVIDER || "serper").toLowerCase();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.capMs || CAP_MS);

  try {
    switch (provider) {
      case "brave":  return await brave(env, query, ac.signal);
      case "exa":    return await exa(env, query, ac.signal);
      case "tavily": return await tavily(env, query, ac.signal);
      case "none":   return null;
      default:       return await serper(env, query, ac.signal);
    }
  } catch {
    return null; // arama başarısız -> model kendi bilgisiyle devam eder
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------------------------------------------- */
/* Serper — VARSAYILAN. $0.30/1000, Google SERP sarmalayıcı          */
/* Anahtar: serper.dev (kayıtta 2500 ücretsiz sorgu)                 */
/* ---------------------------------------------------------------- */
async function serper(env, q, signal) {
  if (!env.SERPER_KEY) return null;
  const r = await fetch("https://google.serper.dev/search", {
    method: "POST",
    signal,
    headers: { "X-API-KEY": env.SERPER_KEY, "content-type": "application/json" },
    body: JSON.stringify({ q, gl: "tr", hl: "tr", num: 3 }),
  });
  if (!r.ok) return null;
  const j = await r.json();

  const out = [];
  // answerBox varsa altın değerinde — doğrudan cevap, en hızlı yol
  if (j.answerBox) {
    const a = j.answerBox;
    out.push({
      title: a.title || "Doğrudan sonuç",
      snippet: a.answer || a.snippet || "",
      url: a.link || "",
    });
  }
  if (j.knowledgeGraph?.description) {
    out.push({
      title: j.knowledgeGraph.title || "Bilgi",
      snippet: j.knowledgeGraph.description,
      url: j.knowledgeGraph.descriptionLink || "",
    });
  }
  (j.organic || []).slice(0, 3).forEach((x) =>
    out.push({ title: x.title, snippet: x.snippet || "", url: x.link })
  );

  return pack(out.slice(0, 3));
}

/* ---------------------------------------------------------------- */
/* Brave — Search planı, LLM Context endpoint'i                       */
/*                                                                    */
/* ÖNEMLİ: Brave'in iki planı var, karıştırma:                        */
/*   Search  ($5/1000)  -> bu. AI üretmez, hazır parça verir. p90<600ms│
/*   Answers ($4/1000+  -> AI cevap üretir AMA ortalama 4.5sn.        */
/*            token)       Canlı yayın için ÇOK YAVAŞ. Kullanma.      */
/*                                                                    */
/* Aylık $5 kredi ~1000 sorguya denk gelir. Harcama tavanı YOK.       */
/* ---------------------------------------------------------------- */
async function brave(env, q, signal) {
  if (!env.BRAVE_KEY) return null;

  // LLM Context: sayfalardan ilgili parçaları çıkarıp sıralı verir.
  // Basit faktüel sorularda token bütçesini düşük tut -> daha hızlı.
  const u = new URL("https://api.search.brave.com/res/v1/llm/context");
  u.searchParams.set("q", q);
  u.searchParams.set("country", "TR");
  u.searchParams.set("search_lang", "tr");
  u.searchParams.set("count", "5");
  u.searchParams.set("maximum_number_of_tokens", "900");
  u.searchParams.set("context_threshold_mode", "strict");

  // Goggles ile güvenilir Türkçe kaynaklara ağırlık verilebilir:
  // if (env.BRAVE_GOGGLE) u.searchParams.set("goggles", env.BRAVE_GOGGLE);

  const r = await fetch(u, {
    signal,
    headers: { Accept: "application/json", "X-Subscription-Token": env.BRAVE_KEY },
  });

  if (r.status === 404 || r.status === 403) {
    // Bu uç hesabın planında yok -> klasik aramaya düş
    console.log(`[brave] llm/context ${r.status} -> klasik aramaya düşülüyor`);
    return braveClassic(env, q, signal);
  }
  if (!r.ok) {
    // Sessizce yutma: 401 (anahtar geçersiz), 429 (kota doldu) gibi
    // durumlar görünmezse "neden hiç sonuç yok" diye günlerce aranır.
    const body = await r.text().catch(() => "");
    console.error(`[brave] llm/context HTTP ${r.status}: ${body.slice(0, 200)}`);
    // 401/429 kalıcı sorun; yine de klasik ucu deneyelim, belki farklı yetki
    return braveClassic(env, q, signal);
  }

  const j = await r.json();

  // GERÇEK CEVAP YAPISI (curl ile doğrulandı, 23 Tem 2026):
  //   { "grounding": { "generic": [ { url, title, snippets: [...] } ] } }
  //
  // Eskiden `j.generic` okunuyordu — öyle bir alan YOK. Sonuçlar hep boş
  // görünüyor, klasik aramaya düşülüyor, o da ücretsiz plandaki
  // saniyede-1-istek limitine takılıp 429 alıyordu. Sonuç: her sorguda
  // "kaynak bulunamadı" -> ekranda "EMİN DEĞİLİM".
  const items =
    j.grounding?.generic ||
    j.grounding?.results ||
    j.generic ||
    j.results ||
    [];

  if (!items.length) {
    console.log(`[brave] llm/context boş döndü -> klasik aramaya düşülüyor`);
    return braveClassic(env, q, signal);
  }

  return pack(
    items.slice(0, 3).map((x) => ({
      title: x.title || "",
      // snippets bir DİZİ; tek metne çeviriyoruz.
      snippet: Array.isArray(x.snippets)
        ? x.snippets.join(" ")
        : x.snippets || x.context || x.description || x.text || "",
      url: x.url || "",
    }))
  );
}

/** LLM Context erişilemezse klasik web/search'e düş. */
async function braveClassic(env, q, signal) {
  const u = new URL("https://api.search.brave.com/res/v1/web/search");
  u.searchParams.set("q", q);
  u.searchParams.set("count", "3");
  u.searchParams.set("country", "TR");
  u.searchParams.set("search_lang", "tr");
  const r = await fetch(u, {
    signal,
    headers: { Accept: "application/json", "X-Subscription-Token": env.BRAVE_KEY },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    console.error(`[brave] web/search HTTP ${r.status}: ${body.slice(0, 200)}`);
    return null;
  }
  const j = await r.json();
  const hits = j.web?.results || [];
  if (!hits.length) console.log(`[brave] web/search 0 sonuç: "${q}"`);
  return pack(
    hits.slice(0, 3).map((x) => ({
      title: x.title, snippet: x.description || "", url: x.url,
    }))
  );
}

/* ---------------------------------------------------------------- */
/* Exa — semantik, "fast" modu ~200ms                                */
/* ---------------------------------------------------------------- */
async function exa(env, q, signal) {
  if (!env.EXA_KEY) return null;
  const r = await fetch("https://api.exa.ai/search", {
    method: "POST",
    signal,
    headers: { "x-api-key": env.EXA_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      query: q,
      numResults: 3,
      type: "fast",
      contents: { text: { maxCharacters: 300 } },
    }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  return pack(
    (j.results || []).slice(0, 3).map((x) => ({
      title: x.title || "", snippet: (x.text || "").slice(0, 250), url: x.url,
    }))
  );
}

/* ---------------------------------------------------------------- */
/* Tavily — ücretsiz kredi var; SADECE basic mod (advanced 5sn+)     */
/* ---------------------------------------------------------------- */
async function tavily(env, q, signal) {
  if (!env.TAVILY_KEY) return null;
  const r = await fetch("https://api.tavily.com/search", {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: env.TAVILY_KEY,
      query: q,
      search_depth: "basic",   // advanced KULLANMA — 5sn+ sürebiliyor
      max_results: 3,
      include_answer: true,
    }),
  });
  if (!r.ok) return null;
  const j = await r.json();

  const out = [];
  if (j.answer) out.push({ title: "Özet", snippet: j.answer, url: "" });
  (j.results || []).slice(0, 3).forEach((x) =>
    out.push({ title: x.title, snippet: x.content || "", url: x.url })
  );
  return pack(out.slice(0, 3));
}

/* ---------------------------------------------------------------- */

function pack(items) {
  const clean = items.filter((x) => x.snippet || x.title);
  if (!clean.length) return null;
  return {
    text: clean
      .map((x, i) => `[${i + 1}] ${x.title} — ${strip(x.snippet)}`)
      .join("\n"),
    refs: clean.map((x) => ({ title: x.title, url: x.url })),
  };
}

function strip(s) {
  return String(s || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").slice(0, 220);
}

// buildQuery topic.js'e taşındı — HEDGE listesiyle senkron kalması için
// sözlükle aynı modülde durması gerekiyordu.
