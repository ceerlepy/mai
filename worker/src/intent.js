/**
 * NİYET KONTROLÜ — konuşmacı benden bilgi istiyor mu?
 *
 * NEDEN MODEL, NEDEN LİSTE DEĞİL
 * Bu soru bağlama bağlıdır ve kelime listesiyle çözülemez. Denendi:
 *
 *   "asgari ücret ne oldu bilmiyorum"       -> istek DEĞİL, bilmediğini söylüyor
 *   "arkadaşlar asgari ücret ne oldu"       -> istek, hitap var
 *   "Veysel asgari ücret ne oldu"           -> istek, hitap var
 *   "bu bilmem kimin olayı en son ne oldu"  -> istek, dolaylı ama cevap arıyor
 *   "sonucu ne oldu göreceğiz"              -> istek DEĞİL, bakıp görecek
 *
 * Beşinde de neredeyse aynı kelimeler var. Ayıran şey hitap, yönlendirme ve
 * cümlenin nereye bağlandığı. Liste 40 maddeye çıktı, hâlâ yanlış sonuç
 * veriyordu. Model bağlamla birlikte daha isabetli.
 *
 * GECİKME NASIL SIFIRLANIYOR
 * Bu kontrol kanıt toplamayla PARALEL koşar (bkz. index.js). Niyet kontrolü
 * ~200 ms, kanıt toplama her durumda daha uzun:
 *
 *   static : model cevabı     500-700 ms   -> niyet gizlenir
 *   semi   : vectorize+model  580 ms       -> niyet gizlenir
 *   fresh  : web+model        1200 ms      -> niyet gizlenir
 *
 * Yani doğruluk kazancı gecikmeye mal olmuyor.
 *
 * BEDELİ
 * Niyet "hayır" derse yapılmış arama çöpe gider — para kaybı. Cihazdaki
 * tereddüt kapısı çoğunu zaten eliyor, kalan israf ücretsiz kotaya sığıyor.
 * İstenirse INTENT_BEFORE_SEARCH=true ile seri çalıştırılabilir
 * (para tasarrufu, +200 ms gecikme).
 */

const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

/** Sert tavan. Aşılırsa güvenli tarafa düşülür. */
const CAP_MS = 400;

const SYSTEM =
  "Sadece 'EVET' veya 'HAYIR' yaz. Başka hiçbir şey yazma.";

const PROMPT = `Canlı yayında konuşan bir sunucunun cümlesini değerlendir.

Sunucu bir bilgiyi hatırlayamıyor ve CEVAP ARIYOR mu?

EVET olanlar:
- Doğrudan soru soruyor
- Birine hitap ederek soruyor ("Veysel...", "arkadaşlar...")
- Dolaylı da olsa cevap arıyor, bilgiyi öğrenmek istiyor
- Söylediği bir rakamdan/tarihten emin değil, doğrulanmasını istiyor

HAYIR olanlar:
- Yorum yapıyor, görüş belirtiyor
- Tahmin yürütüyor, henüz olmamış bir şeyden bahsediyor
- "Bilmiyorum" diyerek konuyu bırakıyor
- Sohbeti kapatıyor, "bakalım/göreceğiz" diyor
- Sadece düşünüyor, kimseden cevap beklemiyor

Örnekler:
"Veysel asgari ücret ne oldu" -> EVET
"arkadaşlar asgari ücret ne oldu" -> EVET
"bu bilmem kimin olayı en son ne oldu" -> EVET
"grev bitmiş miydi acaba" -> EVET
"enflasyon sanırım yüzde 35ti" -> EVET
"Lozan hangi yıl imzalandı emin değilim" -> EVET
"asgari ücret ne oldu bilmiyorum" -> HAYIR
"sonucu ne oldu göreceğiz" -> HAYIR
"bunun sonucu ne olacak bilmiyorum" -> HAYIR
"dünkü maçı sonra konuşuruz" -> HAYIR
"neyse konumuza dönelim" -> HAYIR
{CONTEXT}
Cümle: "{TEXT}"`;

/**
 * @param {object} env
 * @param {string} text      Değerlendirilecek cümle
 * @param {string} [context] Önceki 1-2 cümle. Niyet çoğu zaman buradan anlaşılır.
 *
 * @returns {{ wantsInfo: boolean, latencyMs: number, raw: string }}
 *
 * Hata veya zaman aşımında `wantsInfo: true` döner — güvenli taraf:
 * gereksiz cevap vermek, gerçek soruyu kaçırmaktan iyidir.
 */
export async function checkIntent(env, text, context = "") {
  const t0 = Date.now();

  const ctxLine = context ? `\nÖnceki cümleler: "${context.slice(-200)}"\n` : "\n";
  const prompt = PROMPT.replace("{CONTEXT}", ctxLine).replace("{TEXT}", text.slice(0, 200));

  try {
    const r = await Promise.race([
      env.AI.run(MODEL, {
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: prompt },
        ],
        max_tokens: 3,     // "EVET" tek token
        temperature: 0,    // deterministik
      }),
      sleep(CAP_MS).then(() => null),
    ]);

    if (!r) return { wantsInfo: true, latencyMs: Date.now() - t0, raw: "TIMEOUT" };

    const raw = String(r.response || "").trim();
    const t = raw.toUpperCase().replace(/[^A-ZİĞÜŞÖÇ]/g, "");

    if (t.startsWith("HAYIR")) {
      return { wantsInfo: false, latencyMs: Date.now() - t0, raw };
    }
    if (t.startsWith("EVET")) {
      return { wantsInfo: true, latencyMs: Date.now() - t0, raw };
    }

    // Beklenmedik cevap -> güvenli taraf
    return { wantsInfo: true, latencyMs: Date.now() - t0, raw };
  } catch (e) {
    return {
      wantsInfo: true,
      latencyMs: Date.now() - t0,
      raw: `ERROR: ${String(e?.message || e)}`,
    };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
