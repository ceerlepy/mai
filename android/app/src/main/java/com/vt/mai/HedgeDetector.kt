package com.vt.mai

import android.content.Context
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Tereddüt tespiti — tamamen cihazda, ağ turu yok, ~0ms.
 *
 * KELİME LİSTESİ UZAKTAN YÖNETİLİR
 * Liste Worker'daki lexicon.js'ten gelir (GET /lexicon). Uygulama açılışta
 * çeker ve diske yazar. Yeni kelime eklemek için APK derlemeye GEREK YOK:
 * lexicon.js'i düzenle -> wrangler deploy -> uygulama sonraki açılışta alır.
 *
 * Ağ yoksa veya ilk açılışsa aşağıdaki gömülü liste kullanılır.
 *
 * İKİ SEVİYE
 *   EARLY : partial STT'de yakalanır -> SPEKÜLATİF istek (Worker ısınır)
 *   FINAL : cümle bitince doğrulanır -> cevap ekrana basılır
 */
object HedgeDetector {

    /* ---------------- Gömülü yedek liste (ağ yoksa) ---------------- */

    private val FALLBACK_HEDGE = listOf(
        // belirsizlik
        "sanırım", "sanıyorum", "galiba", "zannedersem", "herhalde",
        "yanılmıyorsam", "yanlış hatırlamıyorsam", "emin değilim",
        "tam emin değilim", "kesin değil",
        // hafıza
        "hatırladığım kadarıyla", "tam hatırlamıyorum", "şimdi hatırlayamadım",
        "aklıma gelmiyor", "dilimin ucunda", "ismini unuttum", "adı neydi",
        // soru
        "neydi", "kaçtı", "ne kadardı", "kaç yılında", "hangi yıldı",
        "ne zamandı", "kim demişti",
        // onay
        "değil miydi", "öyle miydi", "doğru mu", "yanılıyor muyum",
        "öyle değil mi",
        // yayıncı
        "teyit edelim", "kontrol edelim", "bir bakalım", "diye biliyorum",
        "gibi hatırlıyorum",
    )

    private val FALLBACK_IGNORE = listOf(
        "sanırım öyle", "bilmiyorum ki", "her neyse", "neyse",
        "boş ver", "hadi canım",
    )

    /**
     * HİÇ TETİKLEMEMESİ gerekenler — tahmin ve retorik ifadeler.
     * Konuşmacı bilgi istemiyor, sadece konuşuyor:
     *   "bu davanın sonucu ne olacak bilmiyorum"
     *   "yarın hep birlikte göreceğiz"
     * Bunlar için ağ turu atmak boşuna maliyet ve ekran gürültüsü.
     * Tam liste Worker'dan gelir (lexicon.js -> noTrigger).
     */
    private val FALLBACK_NO_TRIGGER = listOf(
        "ne olacak", "ne olur", "nasıl biter", "nasıl sonuçlanır",
        "sonucu ne", "sonu ne", "kim kazanır", "kim kaybeder",
        "olur mu acaba", "gelecek mi", "olacak mı", "kaç olur",
        "sizce ne olur", "beklentiniz", "tahmininiz", "ne dersiniz",
        "göreceğiz", "zaman gösterecek", "belli olmaz", "kim bilir",
        "bence", "sence", "bana kalırsa", "bana göre",
    )

    private val FALLBACK_CHECKABLE = listOf(
        "enflasyon", "asgari ücret", "nüfus", "işsizlik", "faiz", "kur",
        "maç", "skor", "gol", "deprem", "konser", "seçim", "zam",
        "kanun", "dava", "grev", "istifa", "anlaşma",
    )

    /* ---------------- Çalışan listeler ---------------- */

    @Volatile private var hedge = FALLBACK_HEDGE
    @Volatile private var ignore = FALLBACK_IGNORE
    @Volatile private var noTrigger = FALLBACK_NO_TRIGGER
    @Volatile private var checkableHints = FALLBACK_CHECKABLE
    @Volatile private var version = 0

    /**
     * Gelecek zaman fiil eki — henüz olmamış bir şey doğrulanamaz.
     * Dilbilgisi kuralı, tek desen yüzlerce fiili kapsıyor.
     *   "bitecek", "gelecek", "açıklanacak" -> tetiklemez
     *   "bitti", "geldi", "açıklandı"       -> tetikler
     */
    private val FUTURE_TENSE = Regex("""\b\p{L}+(acak|ecek|acağ|eceğ)\b""")

    /** Rakam / ölçü / özel isim — doğrulanabilir içerik işareti. */
    private val NUMERIC = Regex(
        """(\d|yüzde|milyon|milyar|bin|trilyon|kilometre|metre|[A-ZÇĞİÖŞÜ]\p{L}{2,})"""
    )

    /* ---------------- Uzaktan güncelleme ---------------- */

    private val http = OkHttpClient.Builder()
        .connectTimeout(3, TimeUnit.SECONDS)
        .readTimeout(4, TimeUnit.SECONDS)
        .build()

    /**
     * Açılışta çağrılır. Önce diskteki kopyayı yükler (anında hazır olsun),
     * sonra arka planda Worker'dan tazesini çeker.
     */
    fun init(ctx: Context, endpoint: String) {
        loadCached(ctx)
        Thread {
            runCatching {
                val req = Request.Builder().url("$endpoint/lexicon").build()
                http.newCall(req).execute().use { r ->
                    if (!r.isSuccessful) return@use
                    val body = r.body?.string() ?: return@use
                    apply(JSONObject(body))
                    ctx.getSharedPreferences("mai", Context.MODE_PRIVATE)
                        .edit().putString("lexicon", body).apply()
                }
            }
        }.start()
    }

    private fun loadCached(ctx: Context) {
        runCatching {
            val s = ctx.getSharedPreferences("mai", Context.MODE_PRIVATE)
                .getString("lexicon", null) ?: return
            apply(JSONObject(s))
        }
    }

    private fun apply(j: JSONObject) {
        fun arr(k: String): List<String>? =
            j.optJSONArray(k)?.let { a ->
                (0 until a.length()).map { a.optString(it) }.filter { it.isNotBlank() }
            }?.takeIf { it.isNotEmpty() }

        arr("hedge")?.let { hedge = it }
        arr("hedgeIgnore")?.let { ignore = it }
        arr("noTrigger")?.let { noTrigger = it }
        arr("checkableHints")?.let { checkableHints = it }
        version = j.optInt("version", 0)
    }

    fun lexiconVersion() = version

    /* ---------------- Tespit ---------------- */

    data class Hit(val matched: String, val early: Boolean)

    /**
     * @param text    STT çıktısı
     * @param isFinal cümle tamamlandı mı
     */
    fun detect(text: String, isFinal: Boolean): Hit? {
        val t = text.lowercase().trim()
        if (t.length < 8) return null

        // Yok sayılacak kalıplar ("neyse", "boş ver")
        if (ignore.any { t.contains(it) }) return null

        // Görüş bildirimi -> hiçbir bağlamda bilgi isteği değil
        if (noTrigger.any { t.contains(it) }) return null

        // Gelecek zaman -> henüz olmamış, doğrulanamaz
        if (FUTURE_TENSE.containsMatchIn(t)) return null

        val hit = hedge.firstOrNull { t.contains(it) } ?: return null

        // Partial'da içerik henüz tamamlanmamış olabilir -> spekülatife izin ver
        if (!isFinal) return Hit(hit, early = true)

        // Final'de doğrulanacak bir şey yoksa boşuna sorgu atma.
        // İki sinyalden biri yeterli: rakam/özel isim VEYA bilinen konu kelimesi.
        val hasNumeric = NUMERIC.containsMatchIn(text)
        val hasTopic = checkableHints.any { t.contains(it) }
        if (!hasNumeric && !hasTopic) return null

        return Hit(hit, early = false)
    }

    fun toQuery(text: String): String =
        text.replace(Regex("""\s+"""), " ").trim().take(300)
}
