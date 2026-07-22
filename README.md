# MAI

Canlı yayında sunucunun **tereddüt ettiği anı** yakalar, ekrana tek satır net cevap basar.

Kimseyi yalanlamaz, etiket koymaz. Sadece "sanırım…", "emin değilim…", "neydi…" gibi ifadeler duyulduğunda devreye girer — emin değilse susar.

> **Kuruluma hemen başlamak için: [KURULUM.md](KURULUM.md)** — komut komut, 16 adım.

```
teyit/
├── worker/     Cloudflare Worker — düşük gecikmeli cevap servisi
│   ├── src/index.js      akış orkestrasyonu, streaming, cache
│   ├── src/lexicon.js    TÜM kelime listeleri (tek kaynak)
│   ├── src/router.js     soru sınıflandırma (LLM'siz, ~0ms)
│   ├── src/triage.js     regex kararsızsa modele tek ikili soru
│   ├── src/knowledge.js  Vectorize yerel bilgi katmanı
│   ├── src/search.js     değiştirilebilir arama sağlayıcı
│   └── test/             88 test, ağ gerektirmez
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

Onun yerine `router.js` bu kararı **regex ile ~0ms'de** verir. Kaybettiğimiz esneklik, kazandığımız yarım saniye.

### Somut fark

| Soru | Model tek başına | Model + Brave |
|---|---|---|
| "Çanakkale hangi yıl" | ✅ 1915 — eğitim verisinde var | Aynı cevap, **gereksiz 900ms + ücret** |
| "dünkü maç kaç kaç" | ❌ Bilemez. Susar **ya da eski bir maçı uydurur** | ✅ Dün gece indekslenen haberi okur |

İkinci satırdaki "uydurur" en tehlikeli hatadır: canlı yayında güvenle söylenmiş yanlış bir skor. Bu yüzden `router.js` taze sorularda `modelOK: false` verir — model o yola **hiç sokulmaz**, kanıt yoksa cevap da yoktur.

### Brave'in iki planını karıştırma

| Plan | Ne yapar | Gecikme | Bizim kullanımımız |
|---|---|---|---|
| **Search** ($5/1000) | Web'den ilgili metin parçalarını çıkarır, sıralar. **Cevap yazmaz.** | p90 **< 600 ms** | ✅ Bunu kullanıyoruz (LLM Context endpoint) |
| Answers ($4/1000 + token) | Kendi modeliyle cevap yazar | ortalama **4.5 sn** | ❌ Çok yavaş, üstelik iki kere ödersin |

Yani: **Brave ham malzeme verir, cevabı hep senin modelin yazar.** Brave'in AI'ı devrede değil.

---

# 2. Soru tipine göre akış

```
                    ┌──────────────────────────────┐
   Mikrofon ───────►│  Cihazda STT (Android)       │  ~300ms, ses buluta GİTMEZ
                    │  partial + final sonuç       │
                    └──────────────┬───────────────┘
                                   │
                    ┌──────────────▼───────────────┐
                    │  HedgeDetector (cihazda)     │  ~0ms, regex
                    │  "sanırım / neydi / acaba"   │
                    └──────────────┬───────────────┘
                          partial ─┤─ final
                    ┌──────────────▼───────────────┐
        SPEKÜLATİF  │  Worker /check               │  20-60ms ağ (edge)
        (ekrana     │                              │
         basılmaz)  └──────────────┬───────────────┘
                                   │
                    ┌──────────────▼───────────────┐
                    │  router.js classify()        │  ~0ms, regex, LLM YOK
                    └──┬────────┬────────┬─────┬───┘
                       │        │        │     │
        ┌──────────────▼──┐  ┌──▼─────┐ ┌▼───────────┐ ┌▼──────────┐
        │ SUBJ            │  │ STATIC │ │ SEMI       │ │ FRESH     │
        │ "bence daha iyi"│  │ tarih  │ │ enflasyon  │ │ dünkü maç │
        ├─────────────────┤  ├────────┤ ├────────────┤ ├───────────┤
        │ web    ✗        │  │ web ✗  │ │ yerel ∥ web│ │ web ✓ ZOR.│
        │ model  ✗        │  │ model ✓│ │ model ✗    │ │ model ✗   │
        │ → SUS           │  │        │ │            │ │           │
        └─────────────────┘  └───┬────┘ └─────┬──────┘ └─────┬─────┘
                                 │            │              │
                    ┌────────────▼────────────▼──────────────▼─────┐
                    │  Workers AI — token streaming                │
                    │  ilk token ~350-450ms → ekranda soluk taslak │
                    └────────────────────┬─────────────────────────┘
                                         │
                    ┌────────────────────▼─────────────────────────┐
                    │  Kesin cevap taslağı ezer, KV cache'e yazılır │
                    └──────────────────────────────────────────────┘
```

## Sınıf tablosu

| Sınıf | Tetikleyen kelimeler | cache | yerel | web | model | TTL | Örnek |
|---|---|:---:|:---:|:---:|:---:|---|---|
| **FRESH** | dün, bu sabah, az önce, maç, konser, deprem | ✓ | ✗ | **✓ zorunlu** | **✗** | 15 dk | "dünkü maç ne olmuş" |
| **SEMI** | enflasyon, asgari ücret, nüfus, faiz, kur | ✓ | ✓ | ✓ | ✗ | 6 sa | "enflasyon kaçtı" |
| **STATIC** | (diğer hepsi) | ✓ | ✓ | ✗ | ✓ | 7 gün | "Çanakkale hangi yıl" |
| **SUBJ** | bence, sence, daha iyi, beğendim | ✗ | ✗ | ✗ | ✗ | — | "bence daha iyiydi" |

**Neden bu kararlar:**

- **FRESH'te `model: ✗`** — En kritik satır. Model dünkü maçı bilemez ama sorulursa eğitim verisindeki bir maçı güvenle söyler. Canlı yayında bu felaket. Kanıt yoksa "EMİN DEĞİLİM" diyor.
- **FRESH'te `yerel: ✗`** — Vectorize ayda bir güncelleniyor, dünkü haberi içermez. Sorgulamak boşa 80ms.
- **STATIC'te `web: ✗`** — Model zaten biliyor. Web'e gitmek 900ms gecikme + ücret, sıfır fayda.
- **STATIC'te TTL 7 gün** — Çanakkale'nin yılı değişmeyecek. Uzun cache = daha çok hit.
- **FRESH'te TTL 15 dk** — Maç sonucu değişmez ama "az önce ne oldu" 15 dakikada eskir.
- **SUBJ'de her şey ✗** — Doğrulanabilir bir önerme yok. Uğraşmak hem boşuna hem yanlış (kimsenin zevkine "yanlış" denemez).

## Zaman bağlamı enjeksiyonu

Taze sorularda arama sorgusuna otomatik tarih eklenir:

```
"dünkü maç ne olmuş"  →  buildQuery  →  "maç sonucu"
                      →  addTimeContext →  "maç sonucu 21 Temmuz 2026"
```

Bu olmadan Brave geçen ayın maçını getirebilir — arama motoru "dün" kelimesini mutlak tarihe çeviremez.

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

# 3b. Worker uçları

| Uç | Metod | Ne yapar |
|---|---|---|
| `/health` | GET | Model, sağlayıcı, KV/Vectorize durumu |
| `/check` | POST | **Ana uç.** SSE ile draft + answer akıtır |
| `/warm` | GET | Model ve bağlantıyı ısıtır (mikrofona basınca) |
| `/bench` | GET | Gecikme ölçümü, sınıf bazında p50/p95, karar önerisi |
| `/bench?full=1` | GET | Tüm arama sağlayıcılarını yarıştırır |
| `/classify` | GET/POST | Cümleyi sınıflandırır, triyajı gerçekten çalıştırır |
| `/lexicon` | GET | Kelime listesi — Android açılışta çeker |
| `/ingest` | POST | Vectorize'a bilgi yükler (INGEST_TOKEN gerekir) |

## Kelime listeleri uzaktan yönetilir

Tüm listeler `worker/src/lexicon.js` içinde — tek kaynak. Android uygulaması
`GET /lexicon` ile açılışta çekip diske yazar.

**Kelime eklemek için APK derlemeye gerek yok:**

```bash
nano worker/src/lexicon.js    # kelime ekle, VERSION'u artır
npx wrangler deploy
```

Uygulama sonraki açılışta yeni listeyi alır. Ayarlar ekranında sözlük sürümü görünür.

## Testler

```bash
cd worker
npm test              # 88 test, ağ gerekmez, saf regex mantığı
npm run test:triage   # gerçek model çağrısı, deploy sonrası
```

Test seti Türkçe ek tuzaklarını da kapsıyor:
`"ne **zam**an"` içindeki `zam`, `"t**araf**"` içindeki `af` yanlış eşleşmemeli.
Bunun için ek-duyarlı eşleştirici var (`lexicon.js` → `matchAny`).

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

URL'yi not al: `https://teyit-asistani.<subdomain>.workers.dev`

## 4.3 ÖLÇ — projenin en kritik adımı

```bash
curl https://teyit-asistani.<subdomain>.workers.dev/health
curl https://teyit-asistani.<subdomain>.workers.dev/bench
curl 'https://teyit-asistani.<subdomain>.workers.dev/bench?full=1'   # tüm sağlayıcıları yarıştır
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

# scripts/seed.json içindeki "GÜNCELLE:" satırlarını gerçek rakamlarla doldur
export WORKER=https://teyit-asistani.<subdomain>.workers.dev
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
./gradlew assembleRelease -PworkerUrl=https://teyit-asistani.<subdomain>.workers.dev
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
| **Tek vurgu rengi, koyu tema** | Karanlık stüdyo/regie ortamı. Dikkat dağıtmamalı. |
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
