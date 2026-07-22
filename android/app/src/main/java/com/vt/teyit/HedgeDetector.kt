package com.vt.teyit

/**
 * Tereddüt tespiti — tamamen cihazda, ağ turu yok, ~0ms.
 *
 * İki seviye:
 *  EARLY : partial STT'de yakalanır -> SPEKÜLATİF istek (Worker cache'i ısınır)
 *  FINAL : cümle bitince doğrulanır  -> cevap ekrana basılır
 *
 * Spekülatif tetikleme, konuşmacı cümlesini bitirene kadar geçen
 * ~1-1.5 saniyeyi kazandırır.
 */
object HedgeDetector {

    private val HEDGE = listOf(
        "sanırım", "sanıyorum", "galiba", "zannedersem", "zannediyorum",
        "herhalde", "yanılmıyorsam", "yanlış hatırlamıyorsam", "yanlış bilmiyorsam",
        "emin değilim", "emin olamadım", "tam emin değilim", "emin miyim",
        "hatırladığım kadarıyla", "aklımda kaldığı kadarıyla", "tam hatırlamıyorum",
        "neydi", "kaçtı", "kaç yılında", "ne zamandı", "kim demişti",
        "değil miydi", "öyle miydi", "doğru mu", "yanlış mıyım",
        "diye biliyorum", "gibi bir şeydi", "bilmiyorum tam"
    )

    /** Tereddüt olsa da kontrol edilmemesi gereken kalıplar. */
    private val IGNORE = listOf(
        "sanırım öyle", "bilmiyorum ki", "her neyse", "neyse", "bilmiyorum artık"
    )

    /** Ortada doğrulanabilir bir şey var mı? (rakam, ölçü, özel isim) */
    private val CHECKABLE = Regex(
        """(\d|yüzde|milyon|milyar|bin|trilyon|yıl|yılında|tarih|oran|nüfus|enflasyon|kilometre|metre|[A-ZÇĞİÖŞÜ]\p{L}{2,})"""
    )

    data class Hit(val matched: String, val early: Boolean)

    fun detect(text: String, isFinal: Boolean): Hit? {
        val t = text.lowercase().trim()
        if (t.length < 8) return null
        if (IGNORE.any { t.contains(it) }) return null

        val hit = HEDGE.firstOrNull { t.contains(it) } ?: return null

        // Partial'da içerik henüz tamamlanmamış olabilir -> spekülatife izin ver
        if (!isFinal) return Hit(hit, early = true)

        // Final'de doğrulanacak bir şey yoksa boşuna sorgu atma (maliyet + gürültü)
        if (!CHECKABLE.containsMatchIn(text)) return null
        return Hit(hit, early = false)
    }

    fun toQuery(text: String): String =
        text.replace(Regex("""\s+"""), " ").trim().take(300)
}
