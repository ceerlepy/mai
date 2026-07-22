package com.vt.teyit

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.*

class MainActivity : ComponentActivity() {

    private lateinit var store: Store
    private lateinit var client: CheckClient
    private var engine: SpeechEngine? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        store = Store(this)
        val endpoint = BuildConfig.WORKER_URL.trimEnd('/')
        client = CheckClient(endpoint)
        // Kelime listesini Worker'dan çek (uzaktan yönetilir, APK derlemeye gerek yok)
        HedgeDetector.init(this, endpoint)
        setContent { TeyitTheme { Root() } }
    }

    override fun onDestroy() {
        engine?.stop(); client.cancel(); super.onDestroy()
    }

    /* ================================================================ */

    @OptIn(ExperimentalMaterial3Api::class)
    @Composable
    private fun Root() {
        val scope = rememberCoroutineScope()
        val drawer = rememberDrawerState(DrawerValue.Closed)

        var live by remember { mutableStateOf(false) }
        var answer by remember { mutableStateOf<Answer?>(null) }
        var draft by remember { mutableStateOf("") }
        var hits by remember { mutableIntStateOf(0) }
        var heard by remember { mutableStateOf("") }
        var level by remember { mutableFloatStateOf(0f) }
        // Tereddüt algılandığı an true, cevap geldiği an false.
        // Mavi-mor dalga bu bayrağa bağlı.
        var processing by remember { mutableStateOf(false) }
        var sessions by remember { mutableStateOf(store.load()) }
        var naming by remember { mutableStateOf(false) }
        var settings by remember { mutableStateOf(false) }

        val perm = rememberLauncherForActivityResult(
            ActivityResultContracts.RequestPermission()
        ) { granted ->
            if (granted) {
                store.startSession()
                begin(
                    scope,
                    onAnswer = { answer = it }, onDraft = { draft = it },
                    onHeard = { heard = it }, onLevel = { level = it },
                    onProcessing = { processing = it }, onHit = { hits++ }
                )
                live = true
            }
        }

        fun toggle() {
            if (live) {
                engine?.stop(); client.cancel()
                live = false; draft = ""; heard = ""; processing = false
                if ((store.current?.items?.size ?: 0) > 0) naming = true
                else { store.endSession(null); sessions = store.load() }
            } else {
                answer = null; draft = ""; hits = 0; heard = ""; processing = false
                if (hasMic()) {
                    store.startSession()
                    client.warm(scope)
                    begin(
                        scope,
                        onAnswer = { answer = it }, onDraft = { draft = it },
                        onHeard = { heard = it }, onLevel = { level = it },
                        onProcessing = { processing = it }, onHit = { hits++ }
                    )
                    live = true
                } else perm.launch(Manifest.permission.RECORD_AUDIO)
            }
        }

        ModalNavigationDrawer(
            drawerState = drawer,
            drawerContent = {
                ModalDrawerSheet(
                    drawerContainerColor = T.Surface,
                    drawerContentColor = T.Text,
                    modifier = Modifier.width(320.dp)
                ) {
                    HistoryPane(
                        sessions = sessions,
                        onSettings = { settings = true; scope.launch { drawer.close() } },
                        onDelete = { store.delete(it); sessions = store.load() },
                        onShare = { share(store.exportText(it)) }
                    )
                }
            }
        ) {
            Scaffold(
                containerColor = T.Bg,
                topBar = { TopBar(live) { scope.launch { drawer.open() } } }
            ) { pad ->
                Column(
                    Modifier
                        .fillMaxSize()
                        .padding(pad)
                        .padding(horizontal = 22.dp),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Box(Modifier.fillMaxWidth().weight(1f), Alignment.Center) {
                        AnswerStage(answer, draft, live)
                    }

                    // Tereddüt yakalandı, cevap aranıyor -> mavi-mor dalga
                    ProcessingWave(
                        active = processing,
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(56.dp)
                    )

                    HeardStrip(heard, live)

                    Spacer(Modifier.height(14.dp))
                    MicButton(live, processing, level, ::toggle)
                    Spacer(Modifier.height(16.dp))

                    Text(
                        when {
                            processing -> "cevap aranıyor…"
                            live && hits == 0 -> "dinleniyor · henüz teyit yok"
                            live -> "$hits teyit · durdurmak için dokun"
                            else -> "yayını başlatmak için dokun"
                        },
                        color = if (processing) WaveAccent else T.TextFaint,
                        fontSize = 13.sp
                    )
                    Spacer(Modifier.height(34.dp))
                }
            }
        }

        if (naming) NameDialog(
            default = store.current?.name.orEmpty(),
            onSave = { store.endSession(it); sessions = store.load(); naming = false },
            onSkip = { store.endSession(null); sessions = store.load(); naming = false }
        )

        if (settings) SettingsSheet(
            onClear = { store.clearAll(); sessions = emptyList() },
            onClose = { settings = false }
        )
    }

    /* ------------------------- Üst bar ------------------------- */

    @OptIn(ExperimentalMaterial3Api::class)
    @Composable
    private fun TopBar(live: Boolean, onMenu: () -> Unit) {
        TopAppBar(
            colors = TopAppBarDefaults.topAppBarColors(containerColor = T.Bg),
            navigationIcon = {
                IconButton(onMenu) {
                    Icon(Icons.Rounded.Menu, "geçmiş", tint = T.TextDim)
                }
            },
            title = {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (live) {
                        val blink = rememberInfiniteTransition(label = "b")
                        val a by blink.animateFloat(
                            1f, 0.25f,
                            infiniteRepeatable(tween(650), RepeatMode.Reverse), label = "a"
                        )
                        Box(
                            Modifier.size(8.dp).alpha(a)
                                .clip(CircleShape).background(T.Live)
                        )
                        Spacer(Modifier.width(8.dp))
                        Text("CANLI", color = T.Live, fontSize = 13.sp,
                            fontWeight = FontWeight.Bold, letterSpacing = 1.2.sp)
                    } else {
                        Text("Teyit", color = T.Text, fontSize = 17.sp,
                            fontWeight = FontWeight.SemiBold)
                    }
                }
            }
        )
    }

    /* ------------------------- Cevap alanı ------------------------- */

    @Composable
    private fun AnswerStage(answer: Answer?, draft: String, live: Boolean) {
        when {
            answer != null -> {
                val unsure = answer.text.contains("EMİN DEĞİL", true)
                val tint = when {
                    unsure -> T.Warn
                    answer.src == "web" -> T.Text
                    else -> T.Text
                }
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(
                        answer.text,
                        color = tint,
                        fontSize = if (answer.text.length > 60) 27.sp else 36.sp,
                        lineHeight = if (answer.text.length > 60) 34.sp else 44.sp,
                        fontWeight = FontWeight.Bold,
                        textAlign = TextAlign.Center,
                        letterSpacing = (-0.4).sp
                    )
                    Spacer(Modifier.height(20.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        SourceChip(answer.src)
                        Spacer(Modifier.width(8.dp))
                        Text("${answer.ms} ms", color = T.TextFaint, fontSize = 11.sp)
                    }
                }
            }

            draft.isNotBlank() -> {
                // Model-only taslak: soluk gösterilir, kesin cevap gelince ezilir
                Text(
                    draft,
                    color = T.TextDim.copy(alpha = 0.55f),
                    fontSize = 30.sp, lineHeight = 38.sp,
                    fontWeight = FontWeight.Bold, textAlign = TextAlign.Center
                )
            }

            else -> {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(
                        if (live) Icons.Outlined.GraphicEq else Icons.Outlined.Bolt,
                        null, tint = T.Line, modifier = Modifier.size(46.dp)
                    )
                    Spacer(Modifier.height(14.dp))
                    Text(
                        if (live) "tereddüt anı bekleniyor" else "hazır",
                        color = T.TextFaint, fontSize = 14.sp
                    )
                }
            }
        }
    }

    @Composable
    private fun SourceChip(src: String) {
        val (label, c) = when (src) {
            "web" -> "web" to T.Web
            "yerel" -> "yerel" to T.Accent
            "cache" -> "önbellek" to T.Accent
            "öznel" -> "öznel" to T.Warn
            "yok" -> "kaynak yok" to T.Warn
            else -> "model" to T.TextDim
        }
        Box(
            Modifier
                .clip(RoundedCornerShape(5.dp))
                .background(c.copy(alpha = 0.13f))
                .padding(horizontal = 8.dp, vertical = 3.dp)
        ) {
            Text(label, color = c, fontSize = 10.sp,
                fontWeight = FontWeight.Medium, letterSpacing = 0.5.sp)
        }
    }

    /** Duyulan son cümle — küçük, soluk, dikkat dağıtmaz. */
    @Composable
    private fun HeardStrip(text: String, live: Boolean) {
        AnimatedVisibility(live && text.isNotBlank(), enter = fadeIn(), exit = fadeOut()) {
            Text(
                text.takeLast(70),
                color = T.TextFaint.copy(alpha = 0.6f),
                fontSize = 12.sp, maxLines = 1,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp)
            )
        }
    }

    /* ------------------------- Mikrofon ------------------------- */

    @Composable
    private fun MicButton(
        live: Boolean,
        processing: Boolean,
        level: Float,
        onClick: () -> Unit
    ) {
        val pulse = rememberInfiniteTransition(label = "p")
        val ring by pulse.animateFloat(
            1f, if (live) 1.22f else 1f,
            infiniteRepeatable(tween(1100, easing = FastOutSlowInEasing), RepeatMode.Reverse),
            label = "r"
        )
        val voice by animateFloatAsState(
            targetValue = if (live) 1f + (level.coerceAtLeast(0f) / 30f) else 1f,
            animationSpec = tween(120), label = "v"
        )
        // İşlem sırasında buton rengi kırmızıdan mor'a yumuşakça geçer
        val btnColor by animateColorAsState(
            targetValue = when {
                processing -> WaveAccent
                live -> T.Live
                else -> T.Accent
            },
            animationSpec = tween(300), label = "btn"
        )

        Box(
            modifier = Modifier.size(230.dp),
            contentAlignment = Alignment.Center
        ) {
            // Tereddüt yakalandı -> genişleyen mavi-mor halkalar
            ProcessingRings(
                active = processing,
                baseRadiusPx = with(LocalDensity.current) { 79.dp.toPx() }
            )

            if (live && !processing) {
                Box(
                    Modifier.size(210.dp).scale(ring)
                        .clip(CircleShape).background(T.Live.copy(alpha = 0.07f))
                )
                Box(
                    Modifier.size(184.dp).scale(voice)
                        .clip(CircleShape).background(T.Live.copy(alpha = 0.14f))
                )
            }

            Box(
                Modifier
                    .size(158.dp)
                    .clip(CircleShape)
                    .background(btnColor)
                    .border(
                        width = 1.dp,
                        color = Color.White.copy(alpha = 0.10f),
                        shape = CircleShape
                    )
                    .clickable(onClick = onClick),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    if (live) Icons.Rounded.Stop else Icons.Rounded.Mic,
                    if (live) "durdur" else "başlat",
                    tint = Color(0xFF07090B),
                    modifier = Modifier.size(if (live) 58.dp else 66.dp)
                )
            }
        }
    }

    /* ------------------------- Geçmiş ------------------------- */

    @Composable
    private fun HistoryPane(
        sessions: List<Session>,
        onSettings: () -> Unit,
        onDelete: (String) -> Unit,
        onShare: (Session) -> Unit
    ) {
        Column(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
            Spacer(Modifier.height(26.dp))
            Row(
                Modifier.fillMaxWidth(),
                Arrangement.SpaceBetween,
                Alignment.CenterVertically
            ) {
                Text("Geçmiş", color = T.Text, fontSize = 21.sp, fontWeight = FontWeight.Bold)
                IconButton(onSettings) {
                    Icon(Icons.Outlined.Settings, "ayarlar", tint = T.TextDim)
                }
            }
            Spacer(Modifier.height(10.dp))

            if (sessions.isEmpty()) {
                Box(Modifier.fillMaxSize(), Alignment.Center) {
                    Text("henüz kayıt yok", color = T.TextFaint, fontSize = 13.sp)
                }
                return@Column
            }

            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(sessions, key = { it.id }) { s -> SessionCard(s, onDelete, onShare) }
                item { Spacer(Modifier.height(24.dp)) }
            }
        }
    }

    @Composable
    private fun SessionCard(s: Session, onDelete: (String) -> Unit, onShare: (Session) -> Unit) {
        var open by remember { mutableStateOf(false) }
        Column(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(T.SurfaceHi)
                .clickable { open = !open }
                .padding(14.dp)
        ) {
            Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween, Alignment.Top) {
                Column(Modifier.weight(1f)) {
                    Text(s.name, color = T.Text, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                    Spacer(Modifier.height(3.dp))
                    Text(
                        "${s.items.size} teyit · ${s.durationMin} dk",
                        color = T.TextFaint, fontSize = 11.sp
                    )
                }
                Icon(
                    if (open) Icons.Rounded.ExpandLess else Icons.Rounded.ExpandMore,
                    null, tint = T.TextFaint, modifier = Modifier.size(20.dp)
                )
            }

            AnimatedVisibility(open) {
                Column(Modifier.padding(top = 12.dp)) {
                    HorizontalDivider(color = T.Line)
                    Spacer(Modifier.height(10.dp))
                    s.items.forEach { qa ->
                        Text("· ${qa.q.take(80)}", color = T.TextFaint, fontSize = 11.sp)
                        Text(
                            qa.a, color = T.Text, fontSize = 13.5.sp,
                            fontWeight = FontWeight.Medium,
                            modifier = Modifier.padding(start = 8.dp, top = 2.dp, bottom = 10.dp)
                        )
                    }
                    Row {
                        TextButton({ onShare(s) }) {
                            Icon(Icons.Outlined.Share, null, Modifier.size(15.dp), tint = T.Accent)
                            Spacer(Modifier.width(6.dp))
                            Text("Paylaş", color = T.Accent, fontSize = 12.sp)
                        }
                        Spacer(Modifier.weight(1f))
                        TextButton({ onDelete(s.id) }) {
                            Text("Sil", color = T.Live, fontSize = 12.sp)
                        }
                    }
                }
            }
        }
    }

    /* ------------------------- Dialog / Sheet ------------------------- */

    @Composable
    private fun NameDialog(default: String, onSave: (String) -> Unit, onSkip: () -> Unit) {
        var name by remember { mutableStateOf(default) }
        AlertDialog(
            onDismissRequest = onSkip,
            containerColor = T.Surface,
            titleContentColor = T.Text,
            title = { Text("Kayda isim ver", fontSize = 17.sp) },
            text = {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    singleLine = true,
                    placeholder = { Text("örn. Ekonomi bölümü", color = T.TextFaint) },
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = T.Accent,
                        unfocusedBorderColor = T.Line,
                        focusedTextColor = T.Text,
                        unfocusedTextColor = T.Text
                    )
                )
            },
            confirmButton = {
                TextButton({ onSave(name) }) { Text("Kaydet", color = T.Accent) }
            },
            dismissButton = {
                TextButton(onSkip) { Text("Atla", color = T.TextDim) }
            }
        )
    }

    @OptIn(ExperimentalMaterial3Api::class)
    @Composable
    private fun SettingsSheet(onClear: () -> Unit, onClose: () -> Unit) {
        ModalBottomSheet(
            onDismissRequest = onClose,
            containerColor = T.Surface,
            dragHandle = { BottomSheetDefaults.DragHandle(color = T.Line) }
        ) {
            Column(Modifier.padding(horizontal = 24.dp).padding(bottom = 34.dp)) {
                Text("Ayarlar", color = T.Text, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(22.dp))

                InfoRow(Icons.Outlined.MicOff, "Ses kaydedilmez",
                    "Konuşma cihazda metne çevrilir. Ses dosyası hiçbir yere gönderilmez ve saklanmaz.")
                InfoRow(Icons.Outlined.Bolt, "Nasıl tetiklenir",
                    "\"sanırım\", \"emin değilim\", \"neydi\" gibi tereddüt ifadeleri duyulduğunda devreye girer.")
                InfoRow(Icons.Outlined.Shield, "Etiketleme yok",
                    "Uygulama kimseyi yalanlamaz. Sadece doğru bilgiyi ekrana yazar, emin değilse susar.")

                Spacer(Modifier.height(10.dp))
                HorizontalDivider(color = T.Line)
                Spacer(Modifier.height(6.dp))

                TextButton({ onClear(); onClose() }) {
                    Text("Tüm geçmişi sil", color = T.Live, fontSize = 14.sp)
                }

                Spacer(Modifier.height(8.dp))
                Text(
                    "sunucu: ${BuildConfig.WORKER_URL}",
                    color = T.TextFaint, fontSize = 10.sp
                )
                Text(
                    "sözlük sürümü: ${HedgeDetector.lexiconVersion()}",
                    color = T.TextFaint, fontSize = 10.sp
                )
            }
        }
    }

    @Composable
    private fun InfoRow(
        icon: androidx.compose.ui.graphics.vector.ImageVector,
        title: String, body: String
    ) {
        Row(Modifier.padding(bottom = 20.dp)) {
            Icon(icon, null, tint = T.TextDim, modifier = Modifier.size(19.dp).padding(top = 1.dp))
            Spacer(Modifier.width(14.dp))
            Column {
                Text(title, color = T.Text, fontSize = 14.sp, fontWeight = FontWeight.Medium)
                Spacer(Modifier.height(3.dp))
                Text(body, color = T.TextFaint, fontSize = 12.sp, lineHeight = 17.sp)
            }
        }
    }

    /* ------------------------- Motor ------------------------- */

    private fun begin(
        scope: CoroutineScope,
        onAnswer: (Answer) -> Unit,
        onDraft: (String) -> Unit,
        onHeard: (String) -> Unit,
        onLevel: (Float) -> Unit,
        onProcessing: (Boolean) -> Unit,
        onHit: () -> Unit
    ) {
        var context = ""
        engine?.stop()
        engine = SpeechEngine(
            ctx = this,
            onPartial = { txt ->
                onHeard(txt)
                // SPEKÜLATİF: cümle bitmeden Worker'ı ısıt (ekrana bir şey basılmaz)
                HedgeDetector.detect(txt, isFinal = false)?.let {
                    client.fire(scope, HedgeDetector.toQuery(txt), context, speculative = true)
                }
            },
            onFinal = { txt ->
                onHeard(txt)
                HedgeDetector.detect(txt, isFinal = true)?.let {
                    onDraft("")
                    onHit()
                    // Dalga BURADA başlar — cevap gelmeden önce.
                    // Kullanıcı sistemin çalıştığını görsün, boşluğa bakmasın.
                    onProcessing(true)

                    client.fire(
                        scope, HedgeDetector.toQuery(txt), context, speculative = false,
                        onDraft = onDraft,
                        onAnswer = { a ->
                            onDraft("")
                            onAnswer(a)
                            if (a.final) {
                                // Dalga BURADA biter.
                                onProcessing(false)
                                store.add(txt, a.text, a.src, a.ms)
                            }
                        },
                        onDone = { onProcessing(false) }   // emniyet: akış kapanırsa da bitir
                    )
                }
                context = (context + " " + txt).takeLast(220)
            },
            onLevel = onLevel
        )
        engine?.start()
    }

    private fun hasMic() = ContextCompat.checkSelfPermission(
        this, Manifest.permission.RECORD_AUDIO
    ) == PackageManager.PERMISSION_GRANTED

    private fun share(text: String) {
        startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, text)
        }, "Raporu paylaş"))
    }
}
