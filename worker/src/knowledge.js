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
// Kosinüs benzerliği eşiği. Altındakiler güvenilmez sayılıp web'e düşülür.
//
// 0.48 Türkçe kısa sorular için gerçek ölçümle ayarlandı. 0.62 (varsayılan)
// fazla katıydı: "enflasyon kacti" ↔ "Yıllık tüketici enflasyonu" gerçek
// eşleşmesi 0.526 skor veriyordu ama 0.62'yi geçemeyip web'e düşüyordu.
//
// bge-m3 çok dilli; Türkçe kısa soru + kısa başlık çiftlerinde skorlar
// doğal olarak 0.45-0.55 bandında oturuyor. İngilizce uzun metinlerdeki
// 0.62+ skorlar Türkçe'de nadir. Ölçüm: /debug?q= çıktısındaki
// similarityScore değerlerine bakarak ayarla.
const MIN_SCORE = 0.48;

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
      // Her kaydın kendi tazelik ömrü olabilir (aşağıya bak)
      maxDays: Number(hits[0].metadata?.maxDays) || null,
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
  if (!env.VEC) return { ok: false, error: "Vectorize not bound" };

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
      // Kaydın kaç gün sonra bayat sayılacağı. Verilmezse 45.
      // Aylık açıklanan veriler (enflasyon, işsizlik) için 45 uygun.
      // Yıllık açıklananlar (nüfus) için 400 vermek gerekir, yoksa
      // her ay boşuna web aramasına düşer.
      maxDays: Number(x.maxDays) || 45,
    },
  }));

  await env.VEC.upsert(vectors);
  return { ok: true, count: vectors.length };
}

/**
 * TEŞHİS: eşik uygulamadan ham sonuçları döner.
 * MIN_SCORE'un doğru ayarlanıp ayarlanmadığını görmek için.
 */
export async function debugQuery(env, query) {
  if (!env.VEC) return { error: "Vectorize not bound (env.VEC missing)" };
  try {
    const t0 = Date.now();
    const emb = await env.AI.run(EMBED_MODEL, { text: [query] });
    const embMs = Date.now() - t0;

    const t1 = Date.now();
    const res = await env.VEC.query(emb.data[0], { topK: 5, returnMetadata: "all" });
    const queryMs = Date.now() - t1;

    const matches = (res.matches || []).map((m) => ({
      recordId: m.id,
      similarityScore: Number(m.score?.toFixed(4)),   // 1.0 = aynı anlam, 0 = ilgisiz
      passesThreshold: m.score >= MIN_SCORE,          // false ise bu kayıt kullanılmaz
      title: m.metadata?.title,
      lastUpdated: m.metadata?.updated,
      maxAgeDays: m.metadata?.maxDays,                // bu kaydın tazelik ömrü
      isStale: isStale(m.metadata?.updated, m.metadata?.maxDays),
      usable: m.score >= MIN_SCORE && !isStale(m.metadata?.updated, m.metadata?.maxDays),
    }));

    return {
      embeddedText: query,
      similarityThreshold: MIN_SCORE,
      embeddingMs: embMs,          // soruyu vektöre çevirme süresi
      vectorSearchMs: queryMs,     // index'te arama süresi
      totalMatches: matches.length,
      usableMatches: matches.filter((m) => m.usable).length,   // 0 ise web'e düşülür
      matches,
    };
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

/**
 * Bir kaydın bayatlayıp bayatlamadığını kontrol eder.
 *
 * Bayat veri, canlı yayında yanlış cevap demektir — o yüzden bayatsa
 * kayıt kullanılmaz, soru otomatik web aramasına düşer.
 *
 * Ömür kaydın kendisinde tanımlı (metadata.maxDays):
 *   enflasyon, işsizlik, faiz  -> aylık açıklanır  ->  45 gün
 *   asgari ücret               -> yıllık/6 aylık   -> 200 gün
 *   nüfus                      -> yıllık           -> 400 gün
 *
 * @param {string} updated  ISO tarih ("2026-07-03")
 * @param {number} maxDays  kaydın kendi ömrü; yoksa varsayılan 45
 */
export function isStale(updated, maxDays) {
  if (!updated) return true;
  const d = Date.parse(updated);
  if (isNaN(d)) return true;
  const limit = Number(maxDays) || 45;
  return (Date.now() - d) / 86400000 > limit;
}
