package com.vt.mai

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.*

data class QA(val q: String, val a: String, val src: String, val ms: Long, val at: Long)

data class Session(
    val id: String,
    var name: String,
    val start: Long,
    var end: Long,
    val items: MutableList<QA> = mutableListOf()
) {
    val durationMin: Long get() = ((end - start) / 60000).coerceAtLeast(0)
}

/**
 * SES KAYDEDİLMEZ. Sadece tetiklenen cümle + verilen cevap saklanır.
 * 2 saatlik tipik bir yayın ~15 kayıt = birkaç KB.
 */
class Store(ctx: Context) {

    private val file = File(ctx.filesDir, "sessions.json")
    private val fmt = SimpleDateFormat("d MMM · HH:mm", Locale("tr"))

    var current: Session? = null
        private set

    fun startSession(): Session {
        val now = System.currentTimeMillis()
        return Session(now.toString(), fmt.format(Date(now)), now, now).also { current = it }
    }

    fun add(q: String, a: String, src: String, ms: Long) {
        current?.let {
            it.items.add(QA(q, a, src, ms, System.currentTimeMillis()))
            it.end = System.currentTimeMillis()
        }
    }

    fun endSession(name: String?): Session? {
        val s = current ?: return null
        s.end = System.currentTimeMillis()
        if (!name.isNullOrBlank()) s.name = name.trim().take(60)
        current = null
        if (s.items.isEmpty()) return s
        save((listOf(s) + load()).take(200))
        return s
    }

    fun load(): List<Session> {
        if (!file.exists()) return emptyList()
        return runCatching {
            val arr = JSONArray(file.readText())
            (0 until arr.length()).map { i ->
                val o = arr.getJSONObject(i)
                val it2 = o.getJSONArray("items")
                Session(
                    o.getString("id"), o.getString("name"),
                    o.getLong("start"), o.getLong("end"),
                    (0 until it2.length()).map { k ->
                        val x = it2.getJSONObject(k)
                        QA(
                            x.getString("q"), x.getString("a"),
                            x.optString("src", "model"), x.optLong("ms"), x.optLong("at")
                        )
                    }.toMutableList()
                )
            }
        }.getOrDefault(emptyList())
    }

    fun rename(id: String, name: String) =
        save(load().onEach { if (it.id == id) it.name = name.take(60) })

    fun delete(id: String) = save(load().filterNot { it.id == id })

    fun clearAll() = save(emptyList())

    /** Paylaşılabilir düz metin rapor. */
    fun exportText(s: Session): String = buildString {
        appendLine("TEYİT RAPORU — ${s.name}")
        appendLine("${s.items.size} teyit · ${s.durationMin} dk")
        appendLine("-".repeat(32))
        s.items.forEachIndexed { i, q ->
            appendLine()
            appendLine("${i + 1}. ${q.q}")
            appendLine("   → ${q.a}   [${q.src}, ${q.ms}ms]")
        }
    }

    private fun save(list: List<Session>) {
        val arr = JSONArray()
        list.forEach { s ->
            val items = JSONArray()
            s.items.forEach {
                items.put(JSONObject().apply {
                    put("q", it.q); put("a", it.a); put("src", it.src)
                    put("ms", it.ms); put("at", it.at)
                })
            }
            arr.put(JSONObject().apply {
                put("id", s.id); put("name", s.name)
                put("start", s.start); put("end", s.end); put("items", items)
            })
        }
        runCatching { file.writeText(arr.toString()) }
    }
}
