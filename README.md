# MAI

Canlı yayında sunucunun **tereddüt ettiği anı** yakalar, ekrana tek satır net cevap basar.

Kimseyi yalanlamaz, etiket koymaz. Sadece "sanırım…", "emin değilim…", "neydi…" gibi ifadeler duyulduğunda devreye girer — emin değilse susar.

> **[SETUP.md](SETUP.md)** — komut komut, her adımın gerekçesiyle
> **[TRIGGER-LOGIC.md](TRIGGER-LOGIC.md)** — neyi değerlendiriyoruz, neyi değerlendirmiyoruz
> **[API.md](API.md)** — her uç, her alan, her değerin anlamı
> **[DATA-LAYERS.md](DATA-LAYERS.md)** — KV ve Vectorize'ın kod düzeyinde açıklaması

```
mai/
├── worker/     Cloudflare Worker — düşük gecikmeli cevap servisi
│   ├── src/index.js      akış orkestrasyonu, paralel niyet+kanıt, streaming
│   ├── src/lexicon.js    NESNEL sinyal listeleri (tek kaynak, minimal)
│   ├── src/topic.js      konu sınıflandırma + niyet ön kontrolü (regex, 0ms)
│   ├── src/intent.js     niyet kararı (model, ~200ms, paralel koşar)
│   ├── src/knowledge.js  Vectorize yerel bilgi katmanı
│   ├── src/search.js     değiştirilebilir arama sağlayıcı
│   └── test/             72 test, ağ gerektirmez
├── android/    Kotlin + Jetpack Compose mobil uygulama
│   └── WaveEffect.kt   tereddüt anında mavi-mor dalga animasyonu
└── .github/    APK build + Worker deploy otomasyonu
```

---

# 1. Temel kavram: LLM neden tek başına yetmiyor

Bu, mimarinin tamamını belirleyen tek gerçek.

**Bir LLM'in internet erişimi yoktur.** Bu bir eksiklik değil, ne olduğuyla ilgili:

```
girdi tokenlar → [eğitimde donmuş ağırlıklar] → çıktı tokenlar
```

Ağırlıklar eğitim bittiğinde sabitlenir. Model saf bir fonksiyondur — ağ soketi yok, HTTP istemcisi yok, dosya sistemi yok. Modele "Brave'de ara" demek, hesap makinesine "kütüphaneden kitap getir" demek gibidir.

### Peki arama yapan asistanlar nasıl çalışıyor?

Model aramıyor; **etrafındaki program arıyor**:

```
1. Program modele sorar   : "bu soru için arama gerekli mi?"
2. Model cevap verir      : "evet, şunu ara"      ← sadece METİN üretti
3. PROGRAM HTTP isteği atar: Brave / Google       ← arama BURADA
4. Program dönen metni prompt'a yapıştırır
5. Model o metni okuyup cevabı yazar
```

Buna RAG (retrieval-augmented generation) denir. Model "okuma" yapar, "arama" yapmaz.

### Bizim farkımız: 1-2. adımı atıyoruz

Standart RAG'de modele "arama gerekli mi" diye sormak **fazladan bir LLM turu** demektir: ~600ms. Canlı yayında bu kabul edilemez.

Onun yerine `topic.js` bu kararı **regex ile ~0ms'de** verir. Kaybettiğimiz esneklik, kazandığımız yarım saniye.

### Somut fark

| Soru | Model tek başına | Model + Brave |
|---|---|---|
| "Çanakkale hangi yıl" | ✅ 1915 — eğitim verisinde var | Aynı cevap, **gereksiz 900ms + ücret** |
| "dünkü maç kaç kaç" | ❌ Bilemez. Susar **ya da eski bir maçı uydurur** | ✅ Dün gece indekslenen haberi okur |

İkinci satırdaki "uydurur" en tehlikeli hatadır: canlı yayında güvenle söylenmiş yanlış bir skor. Bu yüzden `topic.js` taze sorularda `modelOK: false` verir — model o yola **hiç sokulmaz**, kanıt yoksa cevap da yoktur.

### Brave'in iki planını karıştırma

| Plan | Ne yapar | Gecikme | Bizim kullanımımız |
|---|---|---|---|
| **Search** ($5/1000) | Web'den ilgili metin parçalarını çıkarır, sıralar. **Cevap yazmaz.** | p90 **< 600 ms** | ✅ Bunu kullanıyoruz (LLM Context endpoint) |
| Answers ($4/1000 + token) | Kendi modeliyle cevap yazar | ortalama **4.5 sn** | ❌ Çok yavaş, üstelik iki kere ödersin |

Yani: **Brave ham malzeme verir, cevabı hep senin modelin yazar.** Brave'in AI'ı devrede değil.

---

# 2. Karar mantığı

Tam açıklama: **[TRIGGER-LOGIC.md](TRIGGER-LOGIC.md)**

## İki bağımsız soru

Bu mimarinin temel kararı: iki farklı şeyi ayrı ayrı çözmek.

```
KONU  (nesnel)  : Bu cümlede geçen bilgi hangi türden?
NİYET (öznel)   : Konuşmacı bu bilgiyi benden istiyor mu?
```

| | Kim karar verir | Süre | Neden |
|---|---|---|---|
| **KONU** | regex, `topic.js` | ~0 ms | "dün" geçiyorsa konu günceldir — olgusal, tartışmaya kapalı |
| **NİYET** | model, `intent.js` | ~200 ms | Bağlama, hitaba, tona bağlı — liste ile çözülemez |

### Neden ayrıldı

Önceden ikisi tek fonksiyondaydı:

```
"dünkü maç ne olmuş acaba"     -> fresh + istek        ✓
"dünkü maçı sonra konuşuruz"   -> fresh + istek DEĞİL  ✗ ama tetikliyordu
```

**Zaman ifadesi konuyu belirler, niyeti belirlemez.**

### Neden niyet için liste tutulmuyor

Denendi, liste 40 maddeye çıktı ve hâlâ yanlış sonuç verdi:

```
"asgari ücret ne oldu bilmiyorum"       -> istek DEĞİL
"arkadaşlar asgari ücret ne oldu"       -> istek
"Veysel asgari ücret ne oldu"           -> istek
"bu bilmem kimin olayı en son ne oldu"  -> istek (dolaylı)
"sonucu ne oldu göreceğiz"              -> istek DEĞİL
```

Beşinde de aynı kelimeler var; ayıran şey hitap ve yönlendirme. Bu liste
asla tamamlanmaz. Modele bırakıldı — `lexicon.js` %60 küçüldü, doğruluk arttı.

## Gecikme nasıl sıfırlandı

Niyet kontrolü kanıt toplamayla **paralel** koşuyor:

```
┌─ niyet kontrolü ────────── 200 ms ──┐
├─ kanıt toplama ─────────── 80-900 ms ┤──> birleş
└─ (aynı anda başlar)                  ┘
```

| Konu | Kanıt | Niyet | Paralel toplam |
|---|---|---|---|
| static | model 500-700 ms | 200 ms | **700 ms** (değişmedi) |
| semi | yerel 80 → (yoksa web 700) + model 500 | 200 ms | **580 ms** yerel hit / **1200 ms** web |
| fresh | web 700 + model 500 | 200 ms | **1200 ms** (değişmedi) |

Niyet her durumda kanıttan kısa. **Ek gecikme yok.**

**Taslak kapısı:** Model tokenları niyet onaylanmadan ekrana gönderilmez.
Niyet ~200 ms'de, modelin ilk tokenı ~350 ms'de geldiği için bekleme
yaratmıyor — ama garanti olarak tokenlar biriktirilip onay sonrası salınıyor.
Bu olmadan niyet "hayır" dese bile ekranda bir an metin görünürdü.

**Bedeli:** niyet "hayır" derse yapılmış arama çöpe gider. Arama kotan
sıkışırsa `INTENT_BEFORE_SEARCH = "true"` ile seri moda geç (+200 ms, boşa
arama yok).

## Üç aşamalı karar

```
┌─────────────────────────────────────────────────────────────┐
│ AŞAMA 1 — CİHAZDA (~0 ms, ağ turu yok)                      │
│   tereddüt var mı · görüş bildirimi mi · gelecek zaman mı   │
└────────────────────────┬────────────────────────────────────┘
┌────────────────────────▼────────────────────────────────────┐
│ AŞAMA 2 — WORKER, REGEX (~0 ms)                             │
│   KONU  : fresh | semi | static                             │
│   NİYET : sadece KESİN elemeler (skip / ask)                │
└────────────────────────┬────────────────────────────────────┘
┌────────────────────────▼────────────────────────────────────┐
│ AŞAMA 3 — PARALEL                                           │
│   ┌─ NİYET: model    ~200 ms ─┐                             │
│   ├─ KANIT: ver./web 80-900ms ┤──> birleş                   │
│   └─ (aynı anda)              ┘                             │
│   hayır -> sessizce dön · evet -> cevap üret                │
└─────────────────────────────────────────────────────────────┘
```

## Regex neyi kesin bilir

`precheckIntent()` sadece şu testi geçenleri eler:

> "Bu kalıp geçen bir cümle, HİÇBİR bağlamda bilgi isteği olabilir mi?"

| Kontrol | Yakaladığı |
|---|---|
| `HEDGE_IGNORE` | "neyse", "boş ver" |
| `HARD_SKIP` | "bence", "sence", "sizce ne olur" |
| `FUTURE_TENSE` | `-acak`/`-ecek` eki — tek desen, yüzlerce fiil |

Geri kalan her şey modele gider.

## Konu tablosu

| Konu | Sinyal | cache | yerel | web | model | TTL |
|---|---|:---:|:---:|:---:|:---:|---|
| **FRESH** | dün, maç, deprem, seçim sonuç | ✓ | ✗ | **✓ zorunlu** | **✗** | 15 dk |
| **SEMI** | enflasyon, asgari ücret, nüfus | ✓ | ✓ | ✓ | ✗ | 6 sa |
| **STATIC** | (diğer hepsi) | ✓ | ✓ | ✗ | ✓ | 7 gün |

**FRESH'te `model: ✗` en kritik karar.** Model dünkü maçı bilemez ama
sorulursa eğitim verisindeki bir maçı güvenle söyler.

## Zıt çiftler

| ❌ Tetiklemez | ✓ Tetikler | Ayıran |
|---|---|---|
| "sonucu **ne olacak**" | "sonucu **ne oldu**" | fiil zamanı (regex) |
| "grev ne zaman **bitecek**" | "grev **bitti mi**" | fiil zamanı (regex) |
| "**bence** enflasyon yüksek" | "enflasyon **kaçtı**" | görüş (regex) |
| "asgari ücret ne oldu **bilmiyorum**" | "**arkadaşlar** asgari ücret ne oldu" | hitap (model) |
| "dünkü maçı **sonra konuşuruz**" | "dünkü maç **ne olmuş acaba**" | niyet (model) |

Son iki satır regex'in çözemediği, modelin çözdüğü durumlar.

## Yanlış tetiklemenin maliyeti

| Maliyet | Etki |
|---|---|
| Arama ücreti | Gereksiz tetikleme = 1 sorgu |
| Gecikme | Kullanıcıya yansımaz (paralel mimari) |
| **Ekran gürültüsü** | **En kötüsü.** Sormadığı halde metin belirmesi dikkat dağıtır. |

Ters yönde de dikkat: **yanlış eleme, gereksiz tetiklemeden kötüdür** —
sunucu gerçekten yardım isterken sessiz kalırsın. Bu yüzden regex sadece
%100 emin olduğunu eler.

---

# 3. Gecikme mimarisi

## Katman tablosu

| Katman | Nerede | Gecikme | Maliyet |
|---|---|---|---|
| STT (partial) | **cihazda** | ~300 ms | ücretsiz |
| Hedge tespiti | **cihazda**, regex | ~0 ms | ücretsiz |
| Sınıflandırma | Worker, regex | ~0 ms | ücretsiz |
| Ağ → edge | en yakın Cloudflare PoP | 20–60 ms | — |
| KV cache hit | Cloudflare KV | **10–30 ms** | ücretsiz kota |
| Vectorize sorgusu | Cloudflare Vectorize | **40–90 ms** | ücretsiz kota |
| Workers AI ilk token | Workers AI | **350–450 ms** | ücretsiz kota |
| Workers AI tam cevap | Workers AI | 500–700 ms | ücretsiz kota |
| Web araması (Brave) | Brave LLM Context | 600–900 ms | $5/1000 |
| Browser Rendering | Cloudflare | **2–5 sn** | ❌ kullanılmıyor, çok yavaş |

## Sınıf bazında beklenen süreler

| Sınıf | İlk kelime ekranda | Kesin cevap |
|---|---|---|
| cache hit | — | **10–30 ms** |
| STATIC | ~400 ms | 500–700 ms |
| SEMI (yerel hit) | ~450 ms | 550–800 ms |
| SEMI (web'e düştü) | ~450 ms | 1100–1500 ms |
| FRESH | ~450 ms | 1100–1600 ms |
| Sert tavan | — | 2400 ms → "EMİN DEĞİLİM" |

> Bunlar **tahmin**. Gerçek sayı için `/bench` çalıştır.

## Beş temel gecikme kararı

### 1. Ses buluta gitmiyor
Android'in kendi STT'si cihazda çalışır, Worker'a sadece ~100 byte metin gider. Ses yükleme, tipik bir ses-AI hattındaki en büyük gecikme kalemidir — tamamen elendi.

### 2. Spekülatif tetikleme
"sanırım" kelimesi **partial** STT sonucunda duyulur duyulmaz Worker'a fire-and-forget istek gider. Worker aramayı yapar, cevabı KV'ye yazar. Konuşmacı cümlesini bitirdiğinde (~1–1.5 sn sonra) asıl istek gelir ve cache'te hazır bulur.

```
t=0.3s  partial: "enflasyon sanırım yüz..."  → spekülatif istek
t=0.3s  Worker: arama başlar
t=1.2s  Worker: cevap KV'ye yazıldı
t=1.4s  final: "enflasyon sanırım yüzde 35ti" → asıl istek
t=1.43s cache hit → ekranda
        (spekülatif olmasaydı: t=2.6s)
```

### 3. Karar için LLM turu yok
Standart RAG "arama gerekli mi" diye modele sorar → +600ms. Biz regex ile ~0ms'de karar veriyoruz.

### 4. Her yolda token streaming
Model cevabı token token akıtır, ilk kelimeler ~400ms'de ekranda soluk renkte görünür. Kesin cevap gelince taslağı ezer. **Algılanan gecikme, gerçek gecikmenin yarısı.**

### 5. Sert tavan 2400 ms
O süreye kadar emin cevap yoksa "EMİN DEĞİLİM" yazılır. Canlı yayında geç gelen doğru cevap, zamanında gelen "bilmiyorum"dan daha kötüdür.

## Optimizasyon geçmişi ve gerekçeleri

| Değişiklik | Neden işe yarıyor | Kazanç |
|---|---|---|
| Sistem promptu %40 kısaldı | Her prompt tokenı **prefill** aşamasında işlenir. Prefill, ilk token üretilmeden önce biter. Kısa prompt = erken ilk token. | ~80–120 ms |
| `max_tokens` 40 → 28 | Model gereksiz uzun cevap üretmeye başlarsa erken kesilir. 12 kelimelik Türkçe cevap ≈ 24–30 token; 40 fazlaydı. | ~150 ms (uzun cevaplarda) |
| Taze sorularda da streaming | Önce sadece model-only yolunda streaming vardı; en **yavaş** case olan FRESH'te yoktu. Şimdi orada da ilk kelime 1.4 sn yerine ~450 ms'de görünüyor. | algılanan ~950 ms |
| SEMI'de yerel ∥ web paralel | Seri olsaydı: 80 ms + 900 ms = 980 ms. Paralel: max(80, 900) = 900 ms. Yerel hit varsa web sonucu hiç beklenmiyor. | ~80–900 ms |
| Sert tavan 2600 → 2400 ms | En kötü durumu kısaltır. 2600'de dönen cevap zaten geç kalmıştı. | 200 ms (kuyrukta) |
| Sınıflandırma regex, LLM değil | LLM ile yönlendirme fazladan tam bir model turu demek. | ~600 ms |
| KV cache sınıf bazlı TTL | STATIC 7 gün saklanır → tekrar sorulursa 20 ms. FRESH 15 dk → bayat veri riski yok. | 500–1500 ms (hit'te) |
| `/warm` ucu | Mikrofona basınca TCP/TLS el sıkışması ve model soğuk başlangıcı önden halledilir. | ilk istekte ~200 ms |

## Vectorize katmanının asıl amacı: maliyet

Yayında geçen tereddütlerin çoğu aslında öngörülebilir:

- **Sabit** (tarih, coğrafya) → model zaten bilir, arama gereksiz
- **Yarı-güncel** (enflasyon, asgari ücret, nüfus, faiz) → **sınırlı sayıda ve ayda bir değişir**
- **Gerçekten canlı** (dünkü maç) → sadece bunlar aramaya muhtaç

İkinci grubu Vectorize'a önceden yüklersen web araması hacmi **ayda ~3000'den ~100–300'e** düşer. Bu da her sağlayıcının ücretsiz kredisine sığar — pratikte ödeme yapmazsın.

---

# 3a. Maliyet — gerçek rakamlarla

Cloudflare Workers AI resmi fiyatı: **günde 10.000 Neuron ücretsiz** (00:00 UTC
sıfırlanır), üstü $0.011/1000 Neuron. Kullandığımız model
`llama-3.1-8b-instruct-fp8-fast`: 4119 Neuron/M girdi, 34868 Neuron/M çıktı.

Her adımın tüketimi:

| Adım | Neuron | Not |
|---|---|---|
| Niyet kontrolü (intent.js) | ~1.4 | 320 token girdi, 2 çıktı |
| Cevap üretimi (llama) | ~1.7 | 200 girdi, 25 çıktı |
| Embedding (Vectorize sorgusu) | ~0.02 | çok küçük |
| Cache hit | 0 | model çağrısı yok |

Soru tipine göre toplam:

| Senaryo | Neuron | Günde kaç ücretsiz |
|---|---|---|
| cache hit | 0 | sınırsız |
| niyet "hayır" (boşa) | 1.4 | ~7.200 |
| tam cevap (en pahalı) | 3.1 | ~3.200 |

**Gerçekçi kullanım:** 3 yayın × 2 saat × 15 tereddüt = 90 tetikleme/gün ≈
**280 Neuron = kotanın %2.8'i.** Rahat sığar.

Cloudflare tarafında maliyet kaygısı yok. Tek gerçek sınır **Brave arama
kotası** (~1000/ay ücretsiz), o da Vectorize sayesinde çoğu SEMI sorusunda
harcanmıyor. Cache hit ve Vectorize hit sıfır Neuron.

---

# 3b. Worker uçları

Tam referans: **[API.md](API.md)** — her alanın anlamı, hata kodları, teşhis akışı.

| Uç | Metod | Ne yapar |
|---|---|---|
| `/check` | POST | **Ana uç.** SSE ile `draft` → `answer` → `done` akıtır |
| `/health` | GET | Bağlantı ve yapılandırma durumu |
| `/debug?q=` | GET | **Teşhis.** Vectorize skorları + arama sonucu ham halde |
| `/classify` | GET/POST | Konu + niyet testi, modeli gerçekten çağırır |
| `/bench` | GET | Gecikme ölçümü + canlı modun yaşayabilirliği kararı |
| `/lexicon` | GET | Kelime listeleri — Android açılışta çeker |
| `/ingest` | POST | Vectorize'a veri yükler (token gerekir) |
| `/warm` | GET | Model ve bağlantıyı ısıtır |

## Adlandırma kuralları

Tüm API alanları İngilizce, kendini açıklayan adlar:

| Kalıp | Anlamı | Örnek |
|---|---|---|
| `*Ms` | milisaniye cinsinden süre | `latencyMs`, `embeddingMs` |
| `is*` | durum bildiren boolean | `isFinal`, `isStale` |
| `has*` / `*Configured` / `*Bound` | varlık bildiren boolean | `apiKeyConfigured`, `vectorizeBound` |
| `will*` | planlanan davranış | `willSearchWeb` |
| `*Count` | adet | `modelCheckedCount` |
| çoğul isim | dizi | `matches`, `sources`, `results` |

Ekrana basılan `text` alanı Türkçe — o veri değil, sunucunun okuyacağı cevap.

## `/check` cevabı

```json
{
  "text": "Haziran 2026 itibarıyla yıllık TÜFE yüzde 32,11",
  "source": "local",
  "topicClass": "semi",
  "speakerWantsInfo": true,
  "intentCheckedBy": "model",
  "intentLatencyMs": 187,
  "latencyMs": 634,
  "isFinal": true,
  "sources": [{"title":"...","url":"https://data.tuik.gov.tr"}]
}
```

Konuşmacı bilgi istemiyorsa:

```json
{
  "text": "",
  "source": "no-request",
  "speakerWantsInfo": false,
  "intentCheckedBy": "regex"
}
```

Android bu durumda **ekrana hiçbir şey basmaz.**

**`source` — cevap nereden geldi:**

| Değer | Tipik süre | Ücret |
|---|---|---|
| `cache` | 10-30 ms | yok |
| `local` (Vectorize) | 550-800 ms | yok |
| `model` (kendi bilgisi) | 500-700 ms | yok |
| `web` (arama + model) | 1100-1600 ms | 1 sorgu |
| `no-request` (bilgi istenmemiş) | ~0-200 ms | belki 1 sorgu |
| `none` (kanıt yok) | değişken | belki 1 sorgu |

**`topicClass` — bilginin türü (nesnel):** `fresh` · `semi` · `static`
**`speakerWantsInfo` — niyet (öznel):** `true` / `false`
**`intentCheckedBy` — kararı kim verdi:** `regex` (0 ms) · `model` (~200 ms) · `cache`

## Teşhis

`source: "none"` dönüyorsa:

```bash
curl "$WORKER/debug?q=asgari%20ucret%20neydi" | python3 -m json.tool
```

| Bakılacak alan | Anlamı |
|---|---|
| `vectorizeLookup.error` | Binding yok |
| `vectorizeLookup.totalMatches: 0` | Index boş, `ingest.sh` çalıştırılmamış |
| `vectorizeLookup.usableMatches: 0` | Skor düşük veya kayıt bayat |
| `webSearch.apiKeyConfigured: false` | Secret ulaşmıyor |
| `webSearch.error` | API hatası |

## Kelime listeleri uzaktan yönetilir

Tüm listeler `worker/src/lexicon.js` içinde. Android `GET /lexicon` ile
açılışta çekip diske yazar. **Kelime eklemek için APK derlemeye gerek yok:**

```bash
nano worker/src/lexicon.js    # kelime ekle, VERSION'u artır
npx wrangler deploy
```

## Testler

```bash
cd worker
npm test              # 72 test, ağ gerekmez, saf regex mantığı
npm run test:intent   # gerçek model çağrısı, deploy sonrası
```

Test seti Türkçe ek tuzaklarını da kapsıyor: `"ne **zam**an"` içindeki `zam`,
`"t**araf**"` içindeki `af` yanlış eşleşmemeli. Bunun için ek-duyarlı
eşleştirici var (`lexicon.js` → `matchAny`).

---

# 3c. Veri katmanları — özet

İki opsiyonel katman, ikisi de hem hızı hem maliyeti belirliyor.
Kod düzeyinde tam açıklama: **[DATA-LAYERS.md](DATA-LAYERS.md)**

## KV cache — aynı soruyu iki kere işleme

Soru normalize edilip hash'leniyor, cevap o anahtarla saklanıyor.

```js
function cacheKey(q) {
  const n = q.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "").slice(0, 120);
  let h = 5381;
  for (let i = 0; i < n.length; i++) h = ((h << 5) + h + n.charCodeAt(i)) >>> 0;
  return `a:${h.toString(36)}`;
}
```

Ömür sınıfa göre değişiyor — taze veri uzun saklanırsa canlı yayında bayat
cevap verirsin:

| Sınıf | TTL | Neden |
|---|---|---|
| STATIC | 7 gün | Çanakkale'nin yılı değişmez |
| SEMI | 6 saat | Enflasyon gün içinde değişmez |
| FRESH | 15 dk | "Az önce ne oldu" hızla eskir |
| SUBJ | saklanmaz | Cevap zaten üretilmiyor |

Yazma `ctx.waitUntil` ile cevap gönderildikten **sonra** yapılıyor — kullanıcı
KV yazma süresini beklemiyor.

## Vectorize — aramaya hiç gitmeme

Enflasyon, asgari ücret, nüfus gibi **ayda bir değişen** rakamlar önceden
yükleniyor. Aylık arama sayısı ~3000'den ~250'ye düşüyor, Brave'in ücretsiz
kredisine sığıyor.

Neden düz liste değil: kullanıcı "enflasyon kaçtı" demeyebilir, "TÜFE neydi"
veya "hayat pahalılığı ne oldu" der. Embedding **anlam** benzerliği kurduğu
için hepsini aynı kayda bağlıyor.

```js
// Soruyu vektöre çevir, en yakın kayıtları bul
const emb = await env.AI.run("@cf/baai/bge-m3", { text: [query] });
const res = await env.VEC.query(emb.data[0], { topK: 3, returnMetadata: "all" });

// Eşiğin altındakileri at — Vectorize alakasız olsa da "en yakın"ı döner
const hits = (res.matches || []).filter((m) => m.score >= 0.62);
```

**Bayat veri koruması:** her kaydın kendi ömrü var. Süresi geçmişse kayıt
kullanılmaz, soru otomatik web'e düşer — yanlış cevap gitmez, sadece yavaşlar.

| Veri | Açıklanma | Ömür |
|---|---|---|
| enflasyon, işsizlik | aylık | 45 gün |
| politika faizi | 6-8 hafta | 60 gün |
| asgari ücret | yılda 1-2 | 200 gün |
| nüfus | yılda 1 | 400 gün |

## Veri akışı

```
scripts/seed.json        ← SEN düzenlersin
      │ ./scripts/ingest.sh   (okur ve gönderir, dosyayı DEĞİŞTİRMEZ)
      ▼
Worker /ingest → bge-m3 → 1024 boyutlu vektör
      ▼
Vectorize index          ← veri BURAYA yazılır
      ▼
yayında lookupLocal() → en yakın kayıt → modele kanıt
```

---

# 4. Kurulum

## 4.1 Arama sağlayıcısı seç

| Sağlayıcı | Fiyat | Gecikme | Not |
|---|---|---|---|
| **Brave (Search)** | $5/1000, **aylık $5 kredi ≈ 1000 sorgu** | p90 < 600 ms | Varsayılan. **Harcama tavanı yok**, kart zorunlu. |
| Brave (Answers) | $4/1000 + token | ~4.5 sn | ❌ **Kullanma** |
| Serper | $0.30/1000, kayıtta 2500 ücretsiz | hızlı | En ucuz alternatif |
| Tavily | ücretsiz kredi | basic hızlı | `advanced` modu 5 sn+, kullanma |
| `none` | — | 0 | Aramayı tamamen kapatır |

Değiştirmek için: `wrangler.toml` → `SEARCH_PROVIDER`.

## 4.2 Worker'ı yayınla

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put BRAVE_KEY      # veya SERPER_KEY / TAVILY_KEY / EXA_KEY
npx wrangler deploy
```

URL'yi not al: `https://mai.<subdomain>.workers.dev`

## 4.3 ÖLÇ — projenin en kritik adımı

```bash
curl https://mai.<subdomain>.workers.dev/health
curl https://mai.<subdomain>.workers.dev/bench
curl 'https://mai.<subdomain>.workers.dev/bench?full=1'   # tüm sağlayıcıları yarıştır
```

`/bench` sınıf bazında da rapor verir ve kararı doğrudan yazar:

| p95 | Karar |
|---|---|
| < 2.5 sn | Canlı özellik yaşayabilir, devam |
| 2.5–4 sn | `SEARCH_PROVIDER = "none"` yap, Vectorize + model yoluna geç |
| > 4 sn | Canlıyı bırak, kayıt-sonrası rapor ürününe dön |

## 4.4 KV cache + Vectorize aç

```bash
npx wrangler kv namespace create CACHE
npx wrangler vectorize create teyit-bilgi --dimensions=1024 --metric=cosine
```
Çıkan id'leri `wrangler.toml` içindeki yorumlu bloklara yapıştır, `#`'leri kaldır, tekrar deploy et.

Yerel bilgi tabanını doldur:

```bash
npx wrangler secret put INGEST_TOKEN      # kendin bir parola belirle

# scripts/seed.json GERÇEK verilerle dolu geliyor (Temmuz 2026).
# Ayda bir TÜİK/TCMB açıklamalarından sonra rakamları ve "updated" tarihini güncelle.
export WORKER=https://mai.<subdomain>.workers.dev
export TOKEN=<belirlediğin parola>
./scripts/ingest.sh scripts/seed.json
```

**Ayda bir** güncellemen yeterli. Güncel kaldığı sürece enflasyon/asgari ücret/nüfus soruları ~80 ms'de, web'e gitmeden cevaplanır.

## 4.5 APK

GitHub → Settings → Secrets and variables → Actions → **Variables** → `WORKER_URL` = Worker adresin.

Sonra Actions → **APK Build** → Run workflow. APK hem artifact hem **Releases**'ta çıkar, telefondan direkt indirilir.

Yerelde:
```bash
cd android
./gradlew assembleRelease -PworkerUrl=https://mai.<subdomain>.workers.dev
```

## 4.6 Worker'ı GitHub'dan deploy etmek istersen

| Secret | Nereden |
|---|---|
| `CLOUDFLARE_API_TOKEN` | dash.cloudflare.com → My Profile → API Tokens → *Edit Cloudflare Workers* |
| `CLOUDFLARE_ACCOUNT_ID` | Workers ana sayfasının sağ sütunu |
| `BRAVE_KEY` | api.search.brave.com |

---

# 5. Ürün kararları ve gerekçeleri

| Karar | Gerekçe |
|---|---|
| **Etiketleme yok** | "Bu yalan" demiyor, sadece doğru bilgiyi yazıyor. Hukuki risk (iftira) ve editoryal risk buradan düşüyor. Sunucu zaten "emin değilim" dediği için müdahale değil yardım. |
| **Ses kaydedilmiyor** | Cihazda metne çevriliyor, ses hiçbir yere gitmiyor. KVKK yüzeyi minimum. Geçmişte sadece metin duruyor. |
| **Emin değilse susuyor** | Canlı yayında yanlış cevap, hiç cevap vermemekten çok daha pahalı. False positive maliyeti asimetrik. |
| **12 kelime tavanı** | Sunucu göz ucuyla okuyacak, paragraf okuyamaz. Uzun cevap = kullanılmaz ürün. |
| **Sadece tereddüt anında** | "Her iddiayı tara" modeli sunucuyu boğar, maliyeti 10x yapar ve müdahaleci hissettirir. |
| **Niyet kontrolü** | Tereddüt kelimesi geçmesi yetmez; konuşmacı gerçekten bilgi istiyor olmalı. "Sonucu ne olacak bilmiyorum" retoriktir, tetiklenmez. Gereksiz müdahale, kaçırılan sorudan daha zararlı. |
| **Emin olamayınca sus** | Belirsiz durumda susmak, gereksiz konuşmaya tercih edilir. |
| **Tek vurgu rengi, koyu tema** | Karanlık stüdyo/regie ortamı. Dikkat dağıtmamalı. |
| **Niyet kontrolü** | Tereddüt kelimesi geçmesi yetmez; konuşmacı gerçekten bilgi istiyor olmalı. Karar modele ait, listeye değil. Gereksiz müdahale, kaçırılan sorudan daha zararlı. |
| **İşlem dalgası (mavi-mor)** | Tereddüt yakalandığı an başlar, cevap geldiği an biter. Kullanıcı 1.3 saniye boşluğa bakmak yerine sistemin çalıştığını görür — **algılanan gecikmeyi düşürür**. Kırmızıdan farklı renk ailesi seçildi ki "dinliyorum" ile "cevap arıyorum" karışmasın. |

---

# 6. Bilinen sınırlar

| Sınır | Detay |
|---|---|
| **Çok taze olaylar** | "Az önce ne açıklandı" → Brave indeksi henüz almamış olabilir. Sonuç: "EMİN DEĞİLİM". Doğru davranış ama kullanıcı hayal kırıklığı yaşayabilir. Gerçek yayında bu oranı ölç. |
| **Türkçe STT + rakamlar** | Android tanıyıcısı online modda iyi, ancak "yüzde otuz beş" ↔ "yüzde 35" tutarsızlığı olabilir. Yetersizse `SpeechEngine` arayüzü sabit kalarak Deepgram/AssemblyAI'ye geçilebilir (daha doğru, ama ses buluta gider ve gecikme artar). |
| **Offline STT** | Türkçe offline dil paketi belirgin daha zayıf. Kod `EXTRA_PREFER_OFFLINE=false` kullanıyor. |
| **Tetiklenme oranı** | Dakikada 1'den fazla tetikleniyorsa `HedgeDetector` çok gevşek demektir — hem maliyet hem dikkat dağıtma sorunu. Gerçek yayında logla. |
| **Brave harcama tavanı yok** | Kaçak bir döngü faturayı büyütebilir. Serper'a geçmek daha güvenli. |
| **Gürültülü stüdyo** | Üst üste konuşma, jingle, alkış STT hata oranını yükseltir. |
| **Alaycı ifadeler** | "Tabii ki biliyorum, yüzde 200'dü" — model ironiyi anlamayabilir. |
| **Uzun bağlamlı niyet** | Üç cümle önce sorulan soru `ctx` penceresine (~220 karakter) sığmayabilir. |
| **Konuk konuşması** | Mikrofon herkesi duyar; sunucunun tereddüdü ile konuğunki ayrılmıyor. |
| **Triyaj tutarlılığı** | Aynı cümle nadiren farklı sonuç verebilir. `temperature: 0` bunu en aza indiriyor. |


---

# 7. Bakım ve gelecek işler

## Düzenli bakım (operasyonel, kod değil)

| Ne | Sıklık | Neden | Yapılmazsa |
|---|---|---|---|
| `scripts/seed.json` rakamlarını güncelle | ayda bir (TÜİK/TCMB açıklaması sonrası) | Yerel bilgi tabanı güncel kalsın | Bayat kayıt otomatik web'e düşer — yanlış cevap gitmez, ama o soru yavaşlar (80ms→700ms) ve 1 arama harcar |
| `SEMI_INDICATOR` listesine yeni gösterge ekle | çok seyrek (yeni bir terim sorulmaya başlarsa) | **Bu liste olmadan konu `static` sayılır, static web'e gitmez** — bayat veri güncellenemez | Yeni gösterge Vectorize'da yoksa model eski rakamı söyleyebilir |

> **Neden `SEMI_INDICATOR` kritik:** Konu `semi` olursa web'e gidebilir; `static`
> olursa gidemez. Yani bu liste, bir göstergenin "bayatladığında web'den
> güncellenebilmesi" iznini veriyor. Gösterge isimleri (enflasyon, asgari ücret…)
> nadiren değiştiği için liste bakımı seyrek — ama sıfır değil.

## Gelecek işler (TODO)

- [ ] **CRITICAL — `/bench` ölçümü:** Tüm gecikme rakamları (200ms/700ms/1200ms)
      tahmin. Deploy sonrası `curl $WORKER/bench` çalıştırılıp p95 doğrulanmalı.
      p95 < 2.5sn → canlı mod uygulanabilir. Bu ölçüm yapılana kadar "gecikme
      sorunu yok" denemez.
- [ ] **Otomatik seed güncelleme (cron worker):** Ayda bir TÜİK/TCMB'den rakamları
      çekip Vectorize'ı otomatik güncelleyen bir Scheduled Worker. Kurulursa
      yukarıdaki manuel `seed.json` bakımı ortadan kalkar. `wrangler.toml`'a
      `[triggers] crons = ["0 6 1 * *"]` (her ayın 1'i 06:00 UTC) eklenip
      `scheduled()` handler'ı TÜİK API'sinden çekecek şekilde yazılır.
- [ ] **`npm run test:intent`** deploy sonrası çalıştırılıp niyet modelinin
      gerçek kararları ve gecikmesi (150-250ms bandı) doğrulanmalı.
- [ ] Türkçe STT'nin rakam doğruluğu ve gerçek tetikleme oranı canlıda ölçülmeli.
