/**
 * Triyaj — regex kararsız kaldığında devreye giren model turu.
 *
 * NEDEN VAR
 * router.js regex tabanlı, hızlı (~0ms) ama kelime listesine bağlı.
 * Listede olmayan güncel olayları kaçırır:
 *
 *     "grev bitmiş miydi acaba"   -> listede "grev" yok
 *                                 -> STATIC sanılır
 *                                 -> model eski bilgiyle "evet bitti" der  ❌
 *
 * Bu, canlı yayında en tehlikeli hata tipi: güvenle söylenmiş yanlış bilgi.
 *
 * NEDEN FULL FUNCTION CALLING DEĞİL
 * Standart "tool use" yaklaşımında model bir JSON tool-call üretir:
 *     {"tool":"web_search","q":"grev durumu 2026"}      ~15-20 token  -> ~500ms
 *
 * Bizim tek aracımız var (web araması), seçim yok. Sorulacak tek soru:
 * "arayayım mı?" Bu ikili bir karar, cevabı TEK token:
 *     EVET                                                1 token    -> ~150-250ms
 *
 * Aynı faydanın yarı maliyeti. Function calling'in esnekliği (araç seçimi,
 * parametre üretimi) bu problemde kullanılmıyor, o yüzden bedelini ödemiyoruz.
 *
 * MALİYET DAĞILIMI
 *   %90 soru  -> regex kesin karar verir  ->  ek gecikme 0 ms
 *   %10 soru  -> triyaj turu çalışır      ->  ek gecikme ~150-250 ms
 */

const TRIAGE_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

const TRIAGE_SYS =
  "Tek kelime cevap ver: EVET veya HAYIR. Başka hiçbir şey yazma.";

/** Triyaj kararı için sert tavan. Geçerse güvenli tarafa (web) düşeriz. */
const TRIAGE_CAP_MS = 400;

/**
 * Bu ifade güncel/taze bir olay hakkında mı?
 *
 * @returns {"fresh"|"static"} — hata veya zaman aşımında "fresh" döner
 *          (güvenli taraf: aramak, uydurmaktan iyidir)
 */
export async function triage(env, text) {
  const prompt =
    `Bu ifade son günlerde olan bir olay, haber veya değişen bir veri hakkında mı?\n` +
    `İfade: "${text.slice(0, 160)}"`;

  try {
    const r = await Promise.race([
      env.AI.run(TRIAGE_MODEL, {
        messages: [
          { role: "system", content: TRIAGE_SYS },
          { role: "user", content: prompt },
        ],
        max_tokens: 3,       // "EVET" tek token; 3 emniyet payı
        temperature: 0,      // deterministik olsun
      }),
      sleep(TRIAGE_CAP_MS).then(() => null),
    ]);

    if (!r) return "fresh";  // zaman aşımı -> güvenli taraf

    const t = String(r.response || "").trim().toUpperCase();
    if (t.startsWith("HAYIR") || t.startsWith("HAYIR")) return "static";
    if (t.startsWith("EVET")) return "fresh";

    // Model beklenmedik bir şey yazdıysa güvenli tarafa düş
    return "fresh";
  } catch {
    return "fresh";
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
