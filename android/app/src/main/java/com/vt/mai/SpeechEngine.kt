package com.vt.mai

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log

/**
 * Sürekli dinleme.
 *
 * KRİTİK: Ses buluta GİTMEZ. Android'in kendi STT'si sonucu metin olarak verir.
 * Gecikmenin en büyük kalemi (ses yükleme + uzak STT) böylece elenir.
 *
 * SpeechRecognizer tek atımlıktır; her sonuç/hata sonrası yeniden başlatılır.
 */
class SpeechEngine(
    private val ctx: Context,
    private val onPartial: (String) -> Unit,
    private val onFinal: (String) -> Unit,
    private val onLevel: (Float) -> Unit = {},
    private val onError: (String) -> Unit = {}
) {
    private val main = Handler(Looper.getMainLooper())
    private var recognizer: SpeechRecognizer? = null
    @Volatile private var running = false
    private var lastPartial = ""

    private fun intent() = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_LANGUAGE, "tr-TR")
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, "tr-TR")
        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        // Kısa sessizlikte kes -> final erken gelir -> düşük gecikme
        putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 900L)
        putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 700L)
        putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, 1200L)
        // Online mod: Türkçe'de offline'dan belirgin daha doğru
        putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, false)
        putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, ctx.packageName)
    }

    fun isAvailable() = SpeechRecognizer.isRecognitionAvailable(ctx)

    fun start() {
        if (running) return
        running = true
        main.post { launch() }
    }

    fun stop() {
        running = false
        main.post {
            runCatching { recognizer?.stopListening() }
            runCatching { recognizer?.destroy() }
            recognizer = null
        }
    }

    private fun launch() {
        if (!running) return
        runCatching { recognizer?.destroy() }
        recognizer = SpeechRecognizer.createSpeechRecognizer(ctx).apply {
            setRecognitionListener(listener)
            runCatching { startListening(intent()) }
        }
    }

    private fun restart(delayMs: Long = 0) {
        if (!running) return
        main.postDelayed({ launch() }, delayMs)
    }

    private val listener = object : RecognitionListener {
        override fun onPartialResults(b: Bundle?) {
            val txt = b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                ?.firstOrNull().orEmpty()
            if (txt.isNotBlank() && txt != lastPartial) {
                lastPartial = txt
                onPartial(txt)
            }
        }

        override fun onResults(b: Bundle?) {
            val txt = b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                ?.firstOrNull().orEmpty()
            lastPartial = ""
            if (txt.isNotBlank()) onFinal(txt)
            restart()
        }

        override fun onError(code: Int) {
            lastPartial = ""
            when (code) {
                SpeechRecognizer.ERROR_NO_MATCH,
                SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> restart()          // normal sessizlik
                SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> restart(150)
                SpeechRecognizer.ERROR_CLIENT -> restart(200)
                SpeechRecognizer.ERROR_NETWORK,
                SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> { onError("ağ"); restart(600) }
                SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> onError("mikrofon izni yok")
                else -> { Log.w("SpeechEngine", "err=$code"); restart(400) }
            }
        }

        override fun onRmsChanged(rms: Float) = onLevel(rms.coerceIn(-2f, 12f))
        override fun onReadyForSpeech(p0: Bundle?) {}
        override fun onBeginningOfSpeech() {}
        override fun onBufferReceived(p0: ByteArray?) {}
        override fun onEndOfSpeech() {}
        override fun onEvent(p0: Int, p1: Bundle?) {}
    }
}
