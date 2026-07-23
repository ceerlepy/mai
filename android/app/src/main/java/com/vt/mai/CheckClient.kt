package com.vt.mai

import kotlinx.coroutines.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Worker'ın /check ucundan dönen cevap.
 * Alan adları API sözleşmesiyle birebir aynı (bkz. API.md).
 */
data class Answer(
    val text: String,
    /** cache | local | web | model | none | no-request */
    val source: String,
    /** fresh | semi | static — bilginin türü (nesnel) */
    val topicClass: String = "",
    /** Konuşmacı bilgi istiyor muymuş — false ise ekrana hiçbir şey basılmaz */
    val speakerWantsInfo: Boolean = true,
    /** regex | model | cache — niyet kararını kim verdi */
    val intentCheckedBy: String = "",
    /** İstek başlangıcından bu cevaba kadar geçen süre */
    val latencyMs: Long,
    /** false ise bu bir ara sonuç, kesin cevap değil */
    val isFinal: Boolean,
    /** Cevabın dayandığı kaynak URL'leri */
    val sources: List<String> = emptyList()
)

/**
 * Worker istemcisi.
 *
 * Akış:
 *   partial'da hedge -> fire(spec=true)   : Worker cache'i ısıtır, ekrana bir şey basılmaz
 *   final'de hedge   -> fire(spec=false)  : SSE açılır
 *        event: draft  -> model-only tokenları, ekranda soluk görünür (~400ms)
 *        event: answer -> kesin cevap, draft'ı ezer
 */
class CheckClient(private val base: String) {

    private val http = OkHttpClient.Builder()
        .connectTimeout(2, TimeUnit.SECONDS)
        .readTimeout(8, TimeUnit.SECONDS)
        .callTimeout(10, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    private val JSON = "application/json; charset=utf-8".toMediaType()

    private var active: Call? = null
    private var lastQ = ""
    private var lastAt = 0L

    /** Mikrofona basıldığında: TCP/TLS ve model ısıtılır, ilk isteğin gecikmesi düşer. */
    fun warm(scope: CoroutineScope) = scope.launch(Dispatchers.IO) {
        runCatching {
            http.newCall(Request.Builder().url("$base/warm").build()).execute().close()
        }
    }

    fun cancel() { runCatching { active?.cancel() }; active = null }

    fun fire(
        scope: CoroutineScope,
        query: String,
        context: String,
        speculative: Boolean,
        onDraft: (String) -> Unit = {},
        onAnswer: (Answer) -> Unit = {},
        onDone: (Long) -> Unit = {}
    ) {
        // Aynı cümle için 4sn içinde tekrar sorma
        if (!speculative) {
            val now = System.currentTimeMillis()
            if (query == lastQ && now - lastAt < 4000) return
            lastQ = query; lastAt = now
            cancel()
        }

        val body = JSONObject().apply {
            put("q", query); put("ctx", context); put("spec", speculative)
        }.toString().toRequestBody(JSON)

        val req = Request.Builder()
            .url("$base/check")
            .addHeader("accept", "text/event-stream")
            .post(body)
            .build()

        val call = http.newCall(req)
        if (!speculative) active = call

        scope.launch(Dispatchers.IO) {
            try {
                call.execute().use { resp ->
                    if (!resp.isSuccessful) return@use
                    if (speculative) return@use          // fire-and-forget

                    val src = resp.body?.source() ?: return@use
                    var event = ""
                    while (!src.exhausted()) {
                        val line = src.readUtf8Line() ?: break
                        when {
                            line.startsWith("event:") -> event = line.substring(6).trim()
                            line.startsWith("data:") -> {
                                val payload = line.substring(5).trim()
                                if (payload.isNotEmpty())
                                    dispatch(event, payload, onDraft, onAnswer, onDone)
                            }
                        }
                    }
                }
            } catch (_: CancellationException) {
            } catch (_: Exception) {
                // Canlı yayında hata popup'ı yok — sessiz düş
            }
        }
    }

    private suspend fun dispatch(
        event: String,
        payload: String,
        onDraft: (String) -> Unit,
        onAnswer: (Answer) -> Unit,
        onDone: (Long) -> Unit
    ) = withContext(Dispatchers.Main) {
        val j = runCatching { JSONObject(payload) }.getOrNull() ?: return@withContext
        when (event) {
            "draft" -> onDraft(j.optString("text"))
            "answer" -> {
                val refs = mutableListOf<String>()
                j.optJSONArray("sources")?.let { a ->
                    for (i in 0 until a.length())
                        a.optJSONObject(i)?.optString("url")?.let(refs::add)
                }
                onAnswer(
                    Answer(
                        text = j.optString("text"),
                        source = j.optString("source"),
                        topicClass = j.optString("topicClass"),
                        speakerWantsInfo = j.optBoolean("speakerWantsInfo", true),
                        intentCheckedBy = j.optString("intentCheckedBy"),
                        latencyMs = j.optLong("latencyMs"),
                        isFinal = j.optBoolean("isFinal", true),
                        sources = refs
                    )
                )
            }
            "done" -> onDone(j.optLong("latencyMs"))
        }
    }
}
