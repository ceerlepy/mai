package com.vt.teyit

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * Stüdyo koşulları için tasarlandı:
 *  - Neredeyse siyah zemin (karanlık regie odası, göz yormaz)
 *  - Tek vurgu rengi (dikkat dağıtmaz)
 *  - Cevap metni çok büyük ve kalın — göz ucuyla okunabilmeli
 */
object T {
    val Bg        = Color(0xFF0A0B0D)
    val Surface   = Color(0xFF141619)
    val SurfaceHi = Color(0xFF1D2025)
    val Line      = Color(0xFF262A30)

    val Text      = Color(0xFFF2F4F7)
    val TextDim   = Color(0xFF8B929C)
    val TextFaint = Color(0xFF5A616B)

    val Accent    = Color(0xFF4ADE80)   // hazır / model
    val Live      = Color(0xFFF43F5E)   // kayıtta
    val Warn      = Color(0xFFFBBF24)   // emin değilim
    val Web       = Color(0xFF60A5FA)   // web kaynaklı
}

private val TeyitType = Typography(
    displayLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Bold,
        fontSize = 38.sp,
        lineHeight = 46.sp,
        letterSpacing = (-0.5).sp
    ),
    titleMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 16.sp
    ),
    bodyMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Normal,
        fontSize = 14.sp,
        lineHeight = 20.sp
    ),
    labelSmall = TextStyle(
        fontFamily = FontFamily.Monospace,
        fontWeight = FontWeight.Medium,
        fontSize = 11.sp,
        letterSpacing = 0.6.sp
    )
)

@Composable
fun TeyitTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            background = T.Bg,
            surface = T.Surface,
            primary = T.Accent,
            onPrimary = Color.Black,
            onBackground = T.Text,
            onSurface = T.Text,
            error = T.Live
        ),
        typography = TeyitType,
        content = content
    )
}
