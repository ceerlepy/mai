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

/**
 * Sert tavan. Aşılırsa güvenli tarafa düşülür (wantsInfo = true).
 *
 * 600 ms, canlı ölçümle belirlendi. Önceki değer 400 ms idi ve sınırdaydı:
 * ölçülen niyet süresi 116-335 ms arasında oynuyor, soğuk çağrıda 400'ü
 * aşıp TIMEOUT veriyordu. TIMEOUT'ta karar modelin değil, güvenli
 * varsayılanın oluyor — yani gereksiz tetikleme.
 *
 * Yükseltmenin gecikme maliyeti YOK: niyet kontrolü kanıt toplamayla
 * PARALEL koşuyor ve kanıt toplama tavanı 1500 ms. Yani 600 ms hâlâ
 * aramanın gölgesinde kalıyor, kullanıcıya hiçbir şey yansımıyor.
 */
const CAP_MS = 600;

const SYSTEM =
  "İki satır yaz, başka hiçbir şey yazma. " +
  "Birinci satır: EVET veya HAYIR. " +
  "İkinci satır: arama motoruna yazılacak sorgu (sadece anahtar kelimeler).";

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
Cümle: "{TEXT}"

Cevabını İKİ SATIR olarak yaz:

1. satır: EVET veya HAYIR

2. satır: Bu bilgiyi bulmak için arama motoruna ne yazardın?
   Sadece anahtar kelimeler yaz, soru cümlesi yazma.
   Konuşmacının ne öğrenmek istediğini yakala:
     "maçı ne oldu"      -> skor arıyor  -> "... maç sonucu skor"
     "ne zaman açıklandı"-> tarih arıyor -> "... açıklanma tarihi"
     "kaç oldu"          -> rakam arıyor -> "... son rakam"
   Özel isimleri (takım, kişi, kurum) mutlaka koru.
   HAYIR yazdıysan ikinci satıra sadece "-" yaz.

Örnek:
Cümle: "dünkü fenerbahçe maçı ne oldu"
EVET
Fenerbahçe maç sonucu skor

Cümle: "bence enflasyon çok yüksek"
HAYIR
-`;

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
        max_tokens: 40,    // 1. satır karar + 2. satır sorgu
        temperature: 0,    // deterministik
      }),
      sleep(CAP_MS).then(() => null),
    ]);

    if (!r) return { wantsInfo: true, searchQuery: null, latencyMs: Date.now() - t0, raw: "TIMEOUT" };

    const raw = String(r.response || "").trim();
    const satirlar = raw.split("\n").map((x) => x.trim()).filter(Boolean);

    const karar = (satirlar[0] || "").toUpperCase().replace(/[^A-ZİĞÜŞÖÇ]/g, "");
    // İkinci satır arama sorgusu. "-" veya boşsa regex sorgusuna düşülür.
    const ham = (satirlar[1] || "").replace(/^["'\-\s]+|["'\s]+$/g, "");
    const searchQuery = ham.length > 4 ? ham.slice(0, 120) : null;

    if (karar.startsWith("HAYIR")) {
      return { wantsInfo: false, searchQuery: null, latencyMs: Date.now() - t0, raw };
    }
    // EVET veya beklenmedik cevap -> güvenli taraf (tetikle)
    return { wantsInfo: true, searchQuery, latencyMs: Date.now() - t0, raw };
  } catch (e) {
    return {
      wantsInfo: true,
      searchQuery: null,
      latencyMs: Date.now() - t0,
      raw: `ERROR: ${String(e?.message || e)}`,
    };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
