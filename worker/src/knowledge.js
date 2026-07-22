/**
 * Yerel bilgi katmanı — Cloudflare Vectorize
 *
 * NEDEN VAR:
 * Yayında geçen tereddütlerin büyük kısmı aslında öngörülebilir:
 *   - Sabit bilgiler (tarihler, coğrafya, kurumlar) -> model zaten biliyor
 *   - Yarı-güncel sayısallar (enflasyon, asgari ücret, nüfus, faiz) ->
 *     SINIRLI SAYIDA ve ayda bir güncelleniyor. Bunları önceden yükle.
 *   - Gerçekten canlı (dün akşamki maç, bu sabahki haber) -> sadece bunlar web'e
 *
 * Sonuç: web aramasına ayda ~3000 değil ~100-300 sorgu gider.
 * Her sağlayıcının ücretsiz kredisi bunu rahat karşılar.
 *
 * GECİKME:
 *   Vectorize sorgusu   ~40-90 ms
 *   Web araması        ~600-1800 ms
 * Yani vector hit, aramaya göre 10-20 kat hızlı.
 */

const EMBED_MODEL = "@cf/baai/bge-m3";   // çok dilli, Türkçe destekli
const MIN_SCORE = 0.62;                   // altı güvenilmez -> web'e düş

/**
 * Yerel bilgi tabanında ara.
 * @returns {{text, refs, score}|null}
 */
export async function lookupLocal(env, query) {
  if (!env.VEC) return null;

  try {
    const emb = await env.AI.run(EMBED_MODEL, { text: [query] });
    const vector = emb.data?.[0];
    if (!vector) return null;

    const res = await env.VEC.query(vector, {
      topK: 3,
      returnMetadata: "all",
    });

    const hits = (res.matches || []).filter((m) => m.score >= MIN_SCORE);
    if (!hits.length) return null;

    return {
      text: hits
        .map((m, i) => `[${i + 1}] ${m.metadata?.title || ""} — ${m.metadata?.text || ""}`)
        .join("\n"),
      refs: hits.map((m) => ({
        title: m.metadata?.title || "",
        url: m.metadata?.source || "",
      })),
      score: hits[0].score,
      fresh: hits[0].metadata?.updated || null,
    };
  } catch {
    return null;
  }
}

/**
 * Bilgi tabanına kayıt ekler.
 * POST /ingest  { items: [{id, title, text, source, updated}] }
 * Korumalı: INGEST_TOKEN gerekir.
 */
export async function ingest(env, items) {
  if (!env.VEC) return { ok: false, error: "Vectorize bağlı değil" };

  const texts = items.map((x) => `${x.title}. ${x.text}`);
  const emb = await env.AI.run(EMBED_MODEL, { text: texts });

  const vectors = items.map((x, i) => ({
    id: String(x.id),
    values: emb.data[i],
    metadata: {
      title: String(x.title || "").slice(0, 200),
      text: String(x.text || "").slice(0, 900),
      source: String(x.source || ""),
      updated: String(x.updated || new Date().toISOString().slice(0, 10)),
    },
  }));

  await env.VEC.upsert(vectors);
  return { ok: true, count: vectors.length };
}

/**
 * Bir kaydın ne kadar taze olduğunu kontrol eder.
 * Eski veri, güncel soruya yanlış cevap vermekten kötüdür.
 */
export function isStale(updated, maxDays = 45) {
  if (!updated) return true;
  const d = Date.parse(updated);
  if (isNaN(d)) return true;
  return (Date.now() - d) / 86400000 > maxDays;
}
