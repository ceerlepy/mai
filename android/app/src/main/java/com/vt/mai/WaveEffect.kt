package com.vt.mai

import androidx.compose.animation.core.*
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp
import kotlin.math.PI
import kotlin.math.sin

/**
 * "Düşünüyor" dalgası.
 *
 * NE ZAMAN GÖRÜNÜR
 *   Tereddüt algılandığı an başlar  ->  cevap ekrana geldiği an biter.
 *   Yani kullanıcı, sistemin çalıştığını cevap gelmeden önce görür.
 *   Bu, ALGILANAN gecikmeyi düşürür: 1.3 saniye boşluğa bakmak yerine
 *   bir şeyin olduğunu bilir.
 *
 * NEDEN MAVİ-MOR
 *   Dinleme durumu kırmızı (kayıtta). Dalga farklı bir renk ailesinde
 *   olmalı ki iki durum karışmasın:
 *     kırmızı nabız  = dinliyorum
 *     mavi-mor dalga = yakaladım, cevabı arıyorum
 *
 * Amplitüd yumuşak açılıp kapanır — ani belirip kaybolmaz, göz yormaz.
 */

/** Dalga durumunun ana rengi — metin ve buton için de kullanılır. */
val WaveAccent = Color(0xFF818CF8)

private val WAVE_BLUE = Color(0xFF60A5FA)
private val WAVE_INDIGO = Color(0xFF818CF8)
private val WAVE_PURPLE = Color(0xFFA78BFA)
private val WAVE_VIOLET = Color(0xFFC084FC)

/**
 * Yatay sinüs dalgası bandı. Mikrofonun üstüne, cevap alanının altına konur.
 *
 * @param active tereddüt algılandı, cevap bekleniyor
 */
@Composable
fun ProcessingWave(
    active: Boolean,
    modifier: Modifier = Modifier
) {
    // Amplitüd yumuşak açılıp kapansın
    val amp by animateFloatAsState(
        targetValue = if (active) 1f else 0f,
        animationSpec = tween(durationMillis = if (active) 420 else 260),
        label = "amp"
    )

    // Amplitüd sıfırsa hiç çizme (boşuna Canvas maliyeti)
    if (amp <= 0.01f) return

    val t = rememberInfiniteTransition(label = "wave")

    // Üç katman, farklı hız ve faz -> tek dalga gibi değil, akış gibi görünür
    val p1 by t.animateFloat(
        0f, (2 * PI).toFloat(),
        infiniteRepeatable(tween(1600, easing = LinearEasing)), label = "p1"
    )
    val p2 by t.animateFloat(
        0f, (2 * PI).toFloat(),
        infiniteRepeatable(tween(2300, easing = LinearEasing)), label = "p2"
    )
    val p3 by t.animateFloat(
        (2 * PI).toFloat(), 0f,   // ters yön
        infiniteRepeatable(tween(2900, easing = LinearEasing)), label = "p3"
    )

    Canvas(modifier = modifier) {
        val w = size.width
        val h = size.height
        val mid = h / 2f

        val brush = Brush.horizontalGradient(
            0.0f to WAVE_BLUE.copy(alpha = 0f),
            0.18f to WAVE_BLUE,
            0.42f to WAVE_INDIGO,
            0.62f to WAVE_PURPLE,
            0.85f to WAVE_VIOLET,
            1.0f to WAVE_VIOLET.copy(alpha = 0f),
        )

        // katman: (faz, dalga sayısı, yükseklik oranı, kalınlık, opaklık)
        val layers = listOf(
            Triple(p1, 1.6f, 0.42f) to (2.6f to 0.95f),
            Triple(p2, 2.4f, 0.26f) to (2.0f to 0.60f),
            Triple(p3, 3.4f, 0.16f) to (1.5f to 0.38f),
        )

        for ((cfg, style) in layers) {
            val (phase, cycles, heightRatio) = cfg
            val (stroke, alpha) = style
            val a = mid * heightRatio * amp

            val path = Path().apply {
                moveTo(0f, mid)
                var x = 0f
                val step = 3f
                while (x <= w) {
                    val y = mid + sin((x / w) * cycles * 2 * PI + phase).toFloat() * a
                    lineTo(x, y)
                    x += step
                }
            }

            drawPath(
                path = path,
                brush = brush,
                alpha = alpha * amp,
                style = Stroke(width = stroke.dp.toPx())
            )
        }
    }
}

/**
 * Mikrofonun etrafında genişleyen mavi-mor halkalar.
 * Yatay dalgayla birlikte kullanılır; ikisi aynı anda başlar/biter.
 *
 * @param active tereddüt algılandı, cevap bekleniyor
 * @param baseRadiusPx mikrofon butonunun yarıçapı (px)
 */
@Composable
fun ProcessingRings(
    active: Boolean,
    baseRadiusPx: Float,
    modifier: Modifier = Modifier
) {
    val intensity by animateFloatAsState(
        targetValue = if (active) 1f else 0f,
        animationSpec = tween(if (active) 380 else 240),
        label = "ring"
    )
    if (intensity <= 0.01f) return

    val t = rememberInfiniteTransition(label = "rings")

    // Üç halka, aynı animasyon farklı gecikmeyle -> sürekli akış
    val r1 by t.animateFloat(
        0f, 1f, infiniteRepeatable(tween(1500, easing = LinearOutSlowInEasing)), label = "r1"
    )
    val r2 by t.animateFloat(
        0f, 1f,
        infiniteRepeatable(tween(1500, delayMillis = 500, easing = LinearOutSlowInEasing)),
        label = "r2"
    )
    val r3 by t.animateFloat(
        0f, 1f,
        infiniteRepeatable(tween(1500, delayMillis = 1000, easing = LinearOutSlowInEasing)),
        label = "r3"
    )

    Canvas(modifier = modifier.fillMaxSize()) {
        val c = Offset(size.width / 2f, size.height / 2f)

        listOf(r1 to WAVE_BLUE, r2 to WAVE_INDIGO, r3 to WAVE_PURPLE).forEach { (p, col) ->
            val radius = baseRadiusPx * (1f + p * 0.55f)
            val alpha = (1f - p) * 0.42f * intensity
            if (alpha <= 0.01f) return@forEach

            drawCircle(
                color = col,
                radius = radius,
                center = c,
                alpha = alpha,
                style = Stroke(width = (2.4f - p * 1.2f).dp.toPx())
            )
        }
    }
}
