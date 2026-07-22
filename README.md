# MAI

Canlı yayında sunucunun **tereddüt ettiği anı** yakalar, ekrana tek satır net cevap basar.

Kimseyi yalanlamaz, etiket koymaz. Sadece "sanırım…", "emin değilim…", "neydi…" gibi ifadeleri duyduğunda devreye girer — emin değilse susar.

```
teyit/
├── worker/     Cloudflare Worker (düşük gecikmeli cevap servisi)
├── android/    Kotlin + Jetpack Compose mobil uygulama
└── .github/    APK build + Worker deploy otomasyonu
```

---

## Hızlı kurulum

### 1. Worker'ı yayınla

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put BRAVE_KEY      # api.search.brave.com — ücretsiz tier 2000 sorgu/ay
npx wrangler deploy
```

Çıktıdaki URL'yi not al: `https://teyit-asistani.<subdomain>.workers.dev`

Test:
```bash
curl https://teyit-asistani.<subdomain>.workers.dev/health
curl https://teyit-asistani.<subdomain>.workers.dev/bench   # p50/p95 gecikme ölçümü
```

### 2. (Opsiyonel) KV cache aç — tekrarlanan sorularda ~20ms cevap

```bash
npx wrangler kv namespace create CACHE
```
Çıkan id'yi `wrangler.toml` içindeki yorumlu bloğa yapıştır, `#` işaretlerini kaldır, tekrar deploy et.

### 3. APK'yı GitHub'dan al

Repo → **Settings → Secrets and variables → Actions → Variables** →
`WORKER_URL` = Worker adresin.

Sonra **Actions → APK Build → Run workflow**. Bittiğinde APK hem artifact olarak hem de **Releases** sekmesinde durur — telefondan direkt indirip kurabilirsin.

Yerelde derlemek istersen:
```bash
cd android
./gradlew assembleRelease -PworkerUrl=https://teyit-asistani.<subdomain>.workers.dev
```
(Wrapper yoksa Android Studio projeyi ilk açtığında otomatik üretir.)

### 4. Worker'ı da GitHub'dan deploy etmek istersen

Repo secrets'a ekle:

| Secret | Nereden |
|---|---|
| `CLOUDFLARE_API_TOKEN` | dash.cloudflare.com → My Profile → API Tokens → *Edit Cloudflare Workers* şablonu |
| `CLOUDFLARE_ACCOUNT_ID` | Workers ana sayfasının sağ sütunu |
| `BRAVE_KEY` | api.search.brave.com |

Artık `worker/` altında her değişiklikte otomatik deploy olur.

---

## Gecikme mimarisi

Hedef: **ilk kelime ekranda < 600 ms**, kesin cevap **< 2.4 sn**.

| Adım | Nerede | Süre |
|---|---|---|
| STT (partial) | **cihazda** — Android SpeechRecognizer | ~300 ms |
| Hedge tespiti | **cihazda** — regex | ~0 ms |
| Ağ → edge | en yakın Cloudflare PoP | 20–60 ms |
| Yol A: model-only, token streaming | Workers AI | ilk token ~400 ms |
| Yol B: arama + model | Brave + Workers AI | 1100–1800 ms |
| Cache hit | KV | ~20 ms |

**Dört kritik karar:**

1. **Ses buluta gitmiyor.** STT cihazda çalışır, Worker'a sadece kısa metin gider. Gecikmenin en büyük kalemi tamamen elendi.

2. **Spekülatif tetikleme.** "sanırım" kelimesi *partial* STT'de duyulur duyulmaz Worker'a fire-and-forget istek gider; arama yapılır ve sonuç KV'ye yazılır. Konuşmacı cümlesini bitirdiğinde cevap çoğu zaman zaten hazırdır.

3. **İki yol yarışır, taslak hemen akar.** Model-only yol token token ekrana yazılır (soluk renkte, ~400 ms'de okunmaya başlanır). Arama destekli kesin cevap gelince taslağı ezer.

4. **Sert tavan 2.6 sn.** O süreye kadar emin cevap yoksa ekrana **EMİN DEĞİLİM** yazılır. Yanlış bilgi vermektense susmak.

---

## İlk yapılacak iş: ölçüm

Kod yazmaya devam etmeden önce gerçek sayıyı gör:

```bash
curl -s https://<worker>/bench | python3 -m json.tool
```

| Sonuç | Karar |
|---|---|
| p95 < 2.5 sn | Canlı özellik yaşayabilir, devam |
| p95 2.5–4 sn | Aramayı canlıdan çıkar, sadece model + cache yolunu tut |
| p95 > 4 sn | Canlıyı bırak, kayıt-sonrası rapor ürününe dön |

Ayrıca gerçek yayında **tetiklenme oranını** logla. Dakikada 1'den fazla tetikleniyorsa `HedgeDetector` çok gevşek demektir — hem maliyet hem dikkat dağıtma sorunu olur.

---

## Bilinçli olarak yapılmayanlar

- **Etiketleme yok.** "Bu yalan" demiyor. Hukuki ve editoryal riski buradan düşürüyoruz.
- **Ses kaydı yok.** KVKK yüzeyi minimum; geçmişte sadece metin duruyor.
- **Emin değilse susuyor.** Canlı yayında yanlış cevap, hiç cevap vermemekten çok daha pahalı.
- **Uzun cevap yok.** 12 kelime tavanı. Sunucu göz ucuyla okuyacak, paragraf okuyamaz.

## Türkçe STT hakkında not

Android'in yerleşik tanıyıcısı Türkçe'de online modda iyi çalışıyor, ancak rakam ve özel isimlerde ("yüzde otuz beş" ↔ "yüzde 35") tutarsız olabiliyor. Bu yeterli gelmezse `SpeechEngine` arayüzü aynı kalacak şekilde Deepgram veya AssemblyAI streaming API'sine geçilebilir — daha doğru ama ses buluta gider, gecikme artar ve ücretlidir. Önce yerleşik tanıyıcıyla ölç, gerçekten sorun çıkarsa değiştir.
