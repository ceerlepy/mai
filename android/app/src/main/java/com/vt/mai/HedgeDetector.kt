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
     * HİÇ TETİKLEMEMESİ gerekenler — sadece TARTIŞMASIZ görüş bildirimi.
     *
     * Kısa tutuldu ve sunucudaki HARD_SKIP ile aynı: "sonucu ne",
     * "göreceğiz", "ne olacak" gibi belirsiz kalıplar BURADA DEĞİL, çünkü
     * bağlama göre gerçek soru olabiliyorlar ("maçın sonucu ne oldu").
     * Onları sunucudaki niyet modeli eliyor.
     *
     * Tam liste Worker'dan gelir (lexicon.js -> noTrigger).
     */
    private val FALLBACK_NO_TRIGGER = listOf(
        "bence", "sence", "sizce", "bana kalırsa", "bana göre", "kanaatimce",
        "sizce ne olur", "sizce ne olacak", "beklentiniz", "tahmininiz",
        "ne dersiniz", "katılıyor musunuz",
        "kim kazanır", "kim kaybeder", "kim şampiyon olur",
    )

    /**
     * DOĞRUDAN SORU KALIPLARI — tereddüt olmadan da bilgi istenebilir.
     * "maçın sonucu ne oldu" diyen sunucu "acaba" demese de cevap bekler.
     * Tam liste Worker'dan gelir (lexicon.js -> question).
     */
    private val FALLBACK_QUESTION = listOf(
        "ne oldu", "ne olmuş", "neydi", "ne kadar", "ne zaman", "ne vakit",
        "kaç oldu", "kaçtı", "kaçta", "kaç kişi", "kaç yıl",
        "kim oldu", "kimdi", "kim kazandı", "kim yaptı",
        "hangi yıl", "hangi gün", "hangi tarih", "hangisi",
        "nerede", "nereden", "nasıl oldu",
        "var mıydı", "var mı", "oldu mu", "olmuş mu", "bitti mi",
        "açıklandı mı", "kesinleşti mi", "doğru mu",
        "sonucu ne", "sonuç ne", "skor ne",
    )

    /**
     * SORU DESENİ — liste tek başına yetmez, gerçek konuşmada varyasyon
     * sonsuz. Türkçe'de soru ya soru ekiyle (mı/mi/mu/mü) ya soru
     * sözcüğü + çekimli fiille kurulur. İki desen yüzlerce cümleyi kapsar.
     *
     * NOT: \b kullanılmıyor — Kotlin/Java regex'inde de ASCII tabanlı
     * davranır ve Türkçe harflerde (ı, ş, ğ) sınır tutmaz.
     * Sunucudan güncel desenler gelir (lexicon.js -> questionPattern).
     */
    private val FALLBACK_QUESTION_PATTERN = listOf(
        Regex("(?<!\\p{L})(mı|mi|mu|mü|mısın|misin|musun|müsün|mıydı|miydi|muydu|müydü)(?!\\p{L})"),
        Regex("(?<!\\p{L})(ne|kim|kaç|hangi|nerede|nereden|nasıl|niye|neden)\\s+\\p{L}+(dı|di|du|dü|tı|ti|tu|tü|mış|miş|muş|müş|yor|dık|dik)(?!\\p{L})"),
        Regex("(?<!\\p{L})(ne zaman|ne kadar|kaç tane|kaç kişi|hangi yıl)(?!\\p{L})"),
    )

    /**
     * TAKVİM İŞARETİ — gelecek zaman ekiyle birlikte gelirse cümle
     * tahmin değil tarih sorusudur, elenmemeli.
     *   "seçim ne zaman yapılacak" -> cevaplanabilir
     *   "zam ne kadar olacak"      -> tahmin
     */
    private val FALLBACK_SCHEDULE = listOf(
        "ne zaman", "saat kaç", "kaçta", "hangi gün", "hangi tarih",
        "ne vakit", "günü belli", "tarihi belli", "açıklanacak mı",
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
    @Volatile private var question = FALLBACK_QUESTION
    @Volatile private var questionPattern = FALLBACK_QUESTION_PATTERN
    @Volatile private var schedule = FALLBACK_SCHEDULE
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
        arr("question")?.let { question = it }
        arr("questionPattern")?.let { pats ->
            val compiled = pats.mapNotNull { runCatching { Regex(it) }.getOrNull() }
            if (compiled.isNotEmpty()) questionPattern = compiled
        }
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

        // Yok sayılacak kalıplar ("neyse", "boş ver") -> konuyu kapatıyor
        if (ignore.any { t.contains(it) }) return null

        // Tartışmasız görüş bildirimi ("bence") -> bilgi isteği değil
        if (noTrigger.any { t.contains(it) }) return null

        // Gelecek zaman -> henüz olmamış, doğrulanamaz.
        // AMA takvim işareti varsa ("seçim ne zaman yapılacak") bu bir
        // tarih sorusudur, tahmin değil -> elemiyoruz.
        val isSchedule = schedule.any { t.contains(it) }
        if (FUTURE_TENSE.containsMatchIn(t) && !isSchedule) return null

        // KAPI: tereddüt VEYA doğrudan soru. Biri yeterli.
        // Sadece tereddüt aramak gerçek kullanımda çok soru kaçırıyordu:
        // sunucu "acaba" demeden "maçın sonucu ne oldu" diye sorabiliyor.
        val hedgeHit = hedge.firstOrNull { t.contains(it) }
        val questionHit = question.firstOrNull { t.contains(it) }
            ?: questionPattern.firstOrNull { it.containsMatchIn(t) }?.let { "soru-deseni" }
        val hit = hedgeHit ?: questionHit ?: return null

        // Partial'da içerik henüz tamamlanmamış olabilir -> spekülatife izin ver
        if (!isFinal) return Hit(hit, early = true)

        // Doğrudan soru zaten güçlü bir sinyal; ek şart aramıyoruz.
        // ("Çanakkale Boğazı ne zaman kuruldu" içinde rakam da yok,
        //  bilinen konu kelimesi de yok — ama apaçık bir soru.)
        if (questionHit != null) return Hit(hit, early = false)

        // Sadece tereddüt varsa (soru kalıbı yoksa) doğrulanacak bir şey
        // olduğundan emin ol: rakam VEYA bilinen konu kelimesi.
        val hasNumeric = NUMERIC.containsMatchIn(text)
        val hasTopic = checkableHints.any { t.contains(it) }
        if (!hasNumeric && !hasTopic) return null

        return Hit(hit, early = false)
    }

    fun toQuery(text: String): String =
        text.replace(Regex("""\s+"""), " ").trim().take(300)
}
