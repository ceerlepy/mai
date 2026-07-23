# Kurulum

Her adımda **komut**, **ne yaptığı**, **neden gerekli** ve **doğrulama** var.
Doğrulama geçmeden sonraki adıma geçme.

---

# Sözlük: bu projede geçen kavramlar

| Kavram | Ne demek |
|---|---|
| **Worker** | Cloudflare'ın sunucusuz kod çalıştırıcısı. Kodun dünyaya yayılmış 300+ veri merkezinde duruyor, istek nereden gelirse en yakın olan cevap veriyor. Bu yüzden ağ gecikmesi 20-60 ms. |
| **wrangler** | Worker'ı yöneten komut satırı aracı. Deploy, secret, KV, log — hepsi bununla. |
| **binding** | Worker kodunun bir Cloudflare kaynağına verdiği isim. Kodda `env.CACHE` yazıyorsa binding `CACHE` olmalı. **Bu isim sabittir, değiştirme.** |
| **secret** | Şifreli saklanan değer (API anahtarı gibi). `wrangler.toml`'a yazılmaz, git'e girmez. |
| **vars** | Açık ayar (hangi arama sağlayıcısı gibi). `wrangler.toml` içinde durur, gizli değildir. |
| **KV** | Anahtar-değer deposu. Basit ve çok hızlı (10-30 ms). |
| **Vectorize** | Vektör veritabanı. Anlam benzerliğine göre arama yapar. |
| **embedding** | Bir metnin anlamını temsil eden sayı dizisi. "enflasyon kaçtı" ile "TÜFE oranı nedir" farklı kelimeler ama benzer vektörler üretir — Vectorize bu yüzden çalışır. |

---

# KV ve Vectorize ne işe yarıyor

Bu ikisi projenin hem **hızını** hem **maliyetini** belirliyor. Atlanabilir
ama atlarsan her soru web'e gider: daha yavaş, daha pahalı.

## KV cache — aynı soruyu iki kere sorma

**Problem:** Yayında aynı konu birkaç kez dönebilir. "Enflasyon kaçtı" sorusu
programda üç kez geçerse, üç kez arama yapıp üç kez ücret ödemek anlamsız.

**Çözüm:** İlk cevap KV'ye yazılır. Aynı soru tekrar gelince doğrudan oradan
döner.

```
1. kez:  soru → arama (700ms) → model (500ms) → cevap    ~1200 ms  + ücret
2. kez:  soru → KV                            → cevap      ~20 ms  + ücretsiz
```

**Sınıf bazlı ömür** — taze veri uzun saklanmamalı:

| Sınıf | Cache ömrü | Neden |
|---|---|---|
| STATIC | 7 gün | Çanakkale'nin yılı değişmeyecek |
| SEMI | 6 saat | Enflasyon gün içinde değişmez |
| FRESH | 15 dakika | "Az önce ne oldu" hızla eskir |
| SUBJ | saklanmaz | Zaten cevap üretilmiyor |

## Vectorize — aramaya hiç gitmeme

**Problem:** Brave'in ücretsiz kredisi ayda ~1000 sorgu. Yayında her tereddüt
aramaya giderse (spekülatif çağrılar dahil) ayda 3000'e çıkabilir → para
ödemeye başlarsın.

**Gözlem:** Yayında sorulan tereddütlerin çoğu aslında öngörülebilir:

- **Sabit bilgi** (tarih, coğrafya) → model zaten biliyor, aramaya gerek yok
- **Yarı-güncel sayısal** (enflasyon, asgari ücret, nüfus, faiz) → **sınırlı
  sayıda ve ayda bir değişiyor**
- **Gerçekten canlı** (dünkü maç) → sadece bunlar aramaya muhtaç

**Çözüm:** Ortadaki grubu önceden yükle. `scripts/seed.json` içindeki 8 kayıt
Türkiye'de en sık sorulan ekonomik göstergeleri kapsıyor.

```
Vectorize'sız:  "enflasyon kaçtı" → Brave araması (700ms) → model → cevap
Vectorize'lı:   "enflasyon kaçtı" → Vectorize (80ms)      → model → cevap
```

**Sonuç:** aylık arama sayısı ~3000'den ~200-300'e düşer. Ücretsiz krediye sığar.

**Neden düz bir liste değil de vektör araması?** Kullanıcı "enflasyon kaçtı"
demeyebilir. "TÜFE neydi", "hayat pahalılığı ne oldu", "fiyat artışı yüzde kaç"
da diyebilir. Kelime eşleştirme bunları kaçırır; embedding **anlam** benzerliği
kurduğu için hepsini aynı kayda bağlar.

**Bayat veri koruması:** Her kaydın kendi ömrü var (`maxDays`). Süresi geçmişse
kayıt kullanılmaz, soru otomatik web aramasına düşer. Yani unutup güncellemezsen
yanlış cevap vermez, sadece yavaşlar.

| Kayıt | Ömür | Neden |
|---|---|---|
| enflasyon, işsizlik, istihdam | 45 gün | aylık açıklanıyor |
| politika faizi | 60 gün | PPK 6-8 haftada bir toplanıyor |
| asgari ücret, memur zammı | 200 gün | yılda 1-2 kez |
| nüfus | 400 gün | yılda bir |

---

# 0. Ön koşullar

```bash
node --version    # v22 veya üstü ZORUNLU
```

**Wrangler v4+ Node 22 istiyor.** Node 18 ile şu hatayı alırsın:
`Wrangler requires at least Node.js v22.0.0`

Node 22 kurulumu (macOS/Linux):

```bash
# nvm yoksa kur
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.zshrc          # bash kullanıyorsan ~/.bashrc

nvm install 22
nvm use 22
nvm alias default 22     # yeni terminallerde de 22 açılsın
node --version           # v22.x.x
```

Homebrew ile:
```bash
brew install node@22
brew link --overwrite --force node@22
```

> Daha önce eski Node ile `npm install` yaptıysan, geçiş sonrası temizle:
> ```bash
> rm -rf node_modules package-lock.json && npm install
> ```

**Hesaplar:**

| Hesap | Adres | Ne için |
|---|---|---|
| Cloudflare | dash.cloudflare.com | Worker, KV, Vectorize, model — hepsi burada |
| Brave Search | api.search.brave.com | Web araması. **Search planını** seç, Answers'ı değil (o 4.5 sn sürüyor) |

Brave'de: Subscriptions → **Search** → plan seç → API Keys → Add API Key → kopyala.

---

# 1. Worker adını belirle

```bash
cd ~/Downloads/mai/worker
nano wrangler.toml
```

İlk satır Worker'ın Cloudflare'deki adı ve URL'i belirler:

```toml
name = "mai"        # → https://mai.<subdomain>.workers.dev
```

**Neden önemli:** Repo adıyla ilgisi yok, sadece bu satır belirliyor. Sonradan
değiştirirsen Cloudflare'de iki ayrı Worker oluşur, boşta kalanı silmen gerekir.

---

# 2. Testler

```bash
npm install
npm test
```

**Ne yapıyor:** 72 test çalıştırıyor — soru sınıflandırma mantığı, Türkçe ek
tuzakları (`"ne **zam**an"` içindeki `zam` yanlış eşleşmemeli), yönlendirme
planları, konu/niyet ayrımı ve kritik güvenlik kuralları.
Niyet kontrolü model çağrısı yaptığı için burada değil — onun testi
deploy sonrası `npm run test:intent`.

**Neden deploy'dan önce:** Bunlar ağ gerektirmiyor, saniyeler sürüyor. Bozuksa
deploy etmenin anlamı yok.

**Doğrulama:** `TÜM TESTLER GEÇTİ (72/72)`

---

# 3. Cloudflare girişi

```bash
npx wrangler login
npx wrangler whoami
```

**Ne yapıyor:** Tarayıcı açıp hesabına erişim izni istiyor, token'ı makinene
kaydediyor.

**Doğrulama:** `whoami` hesap e-postanı ve Account ID'ni gösterir.

---

# 4. Secret'lar

```bash
npx wrangler secret put BRAVE_KEY
# → Brave anahtarını yapıştır, Enter

npx wrangler secret put INGEST_TOKEN
# → kendi uydurduğun bir parola, örn: mai-2026-xK9m
```

**Neden iki tane:**

- `BRAVE_KEY` — web araması için. Olmadan da çalışır ama güncel sorulara
  "EMİN DEĞİLİM" der.
- `INGEST_TOKEN` — `/ingest` ucunu korur. Bu uç Vectorize'a veri yazıyor;
  açık bırakırsan herkes bilgi tabanına istediğini yazar ve uygulaman yanlış
  cevap vermeye başlar. Parolayı sen uyduruyorsun, bir yere not et.

**Neden `wrangler.toml`'a yazmıyoruz:** O dosya git'e giriyor. Anahtar orada
olsaydı GitHub'a açık şekilde push edilirdi.

"Worker yok, oluşturayım mı?" derse **Y** — 1. adımda verdiğin isimle boş bir
Worker oluşturur, kodu 5. adımda yüklenir.

**Doğrulama:**
```bash
npx wrangler secret list
```

---

# 5. İlk deploy

```bash
npx wrangler deploy
```

**Ne yapıyor:** `src/` altındaki kodu paketleyip Cloudflare'in tüm veri
merkezlerine dağıtıyor. Birkaç saniye sürer.

Çıktıdaki URL'yi değişkene ata:

```bash
export WORKER=https://mai.XXXX.workers.dev
echo "export WORKER=$WORKER" >> ~/.zshrc
```

**Doğrulama:**
```bash
curl $WORKER/health
```
```json
{"ok":true,"model":"@cf/meta/llama-3.1-8b-instruct-fast",
 "provider":"brave","cache":false,"vectorize":false}
```

`cache` ve `vectorize` şu an `false` — 6. adımda açıyoruz.

---

# 6. KV ve Vectorize

## 6.1 Oluştur

```bash
npx wrangler kv namespace create CACHE
npx wrangler vectorize create mai-bilgi --dimensions=1024 --metric=cosine
```

**`--dimensions=1024` nedir:** Kullandığımız embedding modeli (`bge-m3`) her
metni 1024 sayılık bir vektöre çeviriyor. Index bu boyutu bilmek zorunda,
yoksa veri kabul etmez. **Bu sayıyı değiştirme.**

**`--metric=cosine` nedir:** İki vektörün benzerliğini ölçme yöntemi. Metin
benzerliği için standart olan bu.

## 6.2 `wrangler.toml`'a bağla

```bash
nano wrangler.toml
```

İlgili blokların `#` işaretlerini kaldır:

```toml
[[kv_namespaces]]
binding = "CACHE"        # ← SABİT. Kodda env.CACHE yazıyor, değiştirme.
id = "kv-create-ciktisindaki-id"

[[vectorize]]
binding = "VEC"          # ← SABİT. Kodda env.VEC yazıyor, değiştirme.
index_name = "mai-bilgi" # ← 6.1'de verdiğin isimle AYNI olmalı
```

> **En sık yapılan hata:** `index_name` ile gerçek index adının farklı olması.
> Eşleşmezse binding kurulmaz ve `/health` `"vectorize": false` döner.
> `binding` kodun içindeki değişken adı — o hiç değişmez. `index_name` ve `id`
> ise Cloudflare'deki gerçek kaynağı işaret eder.

## 6.3 Tekrar deploy

```bash
npx wrangler deploy
curl $WORKER/health
```

**Doğrulama:** `"cache":true,"vectorize":true`

Hâlâ `false` ise: `npx wrangler kv namespace list` ve
`npx wrangler vectorize list` ile gerçek isimleri gör, `wrangler.toml` ile
karşılaştır.

---

# 7. Bilgi tabanını yükle

`scripts/seed.json` **Temmuz 2026 verileriyle dolu geliyor** — enflasyon,
asgari ücret, nüfus, politika faizi, işsizlik, istihdam, memur zammı.

```bash
chmod +x scripts/ingest.sh test/intent.test.sh

# Bu iki değişken HER YENİ TERMİNALDE tanımlı olmalı.
# Tanımsızsa script "WORKER: unbound variable" hatası verir.
export WORKER=https://mai.XXXX.workers.dev
export TOKEN=<4. adımdaki INGEST_TOKEN>

echo $WORKER && curl $WORKER/health     # önce bağlantıyı doğrula

./scripts/ingest.sh scripts/seed.json
```

> `WORKER`'ı kalıcı yapabilirsin: `echo "export WORKER=$WORKER" >> ~/.zshrc`
> `TOKEN`'ı **yazma** — o bir parola, dosyada açık durmasın.

**Ne yapıyor:** Her kaydın metnini embedding modeline gönderip 1024 boyutlu
vektöre çeviriyor, Vectorize'a yazıyor.

**Doğrulama:** `{"ok": true, "count": 8}`

Sonra test et — `"src":"yerel"` dönmeli:
```bash
curl -N -X POST $WORKER/check -H 'content-type: application/json' \
  -d '{"q":"enflasyon sanırım yüzde 35ti"}'
```

## Aylık bakım

TÜİK enflasyonu her ayın 3'ünde, işgücü verilerini ayın son gününde açıklıyor.
O günlerde:

```bash
nano scripts/seed.json          # rakamları güncelle, "updated" tarihini de değiştir
./scripts/ingest.sh scripts/seed.json
```

Unutursan felaket olmaz: `maxDays` süresi dolan kayıt kullanılmaz, soru web
aramasına düşer. Yanlış cevap gitmez, sadece yavaşlar ve arama kotandan yer.

---

# 8. Gecikme ölçümü — en kritik adım

```bash
curl $WORKER/bench | python3 -m json.tool
```

**Ne yapıyor:** Her soru tipinden örnek çalıştırıp p50/p95 gecikme ölçüyor ve
kararı doğrudan yazıyor.

Birden fazla arama anahtarın varsa hepsini yarıştır:
```bash
curl "$WORKER/bench?full=1" | python3 -m json.tool
```

| p95 | Karar |
|---|---|
| < 2.5 sn | Canlı özellik yaşayabilir → devam |
| 2.5–4 sn | `wrangler.toml` → `SEARCH_PROVIDER = "none"` yap. Vectorize + model yolu kalır, canlı olaylar cevaplanamaz ama hız yeter |
| > 4 sn | Canlıyı bırak, kayıt-sonrası rapor ürününe dön |

**Neden bu kadar önemli:** Ürünün tek gerçek farkı hız. 3 saniyede cevap veren
bir araç canlı yayında işe yaramaz — sunucu çoktan konuyu geçmiştir.

---

# 9. Niyet testi

```bash
npm run test:intent
```

**Ne yapıyor:** 13 örnek cümleyi gerçek modele gönderip niyet kararını ve
süresini ölçüyor.

**Beklenen:**

| Cevap | Cümleler |
|---|---|
| EVET | "Veysel asgari ücret ne oldu", "arkadaşlar...", "grev bitmiş miydi", "enflasyon sanırım %35ti", "Lozan hangi yıl", "dünkü maç ne olmuş" |
| hayır | "asgari ücret ne oldu bilmiyorum", "sonucu ne oldu göreceğiz", "dünkü maçı sonra konuşuruz", "neyse konumuza dönelim", "bence enflasyon yüksek" |

Süre **150–250 ms** bandında olmalı. 400 ms üstündeyse `intent.js` tavanı
devreye giriyor demektir.

`KARAR` sütunu `regex` ise model hiç çağrılmamış (0 ms) — o cümle
`precheckIntent()` tarafından kesin elenmiş.

---

# 10. Fonksiyonel testler

```bash
# STATIC → src:"model", web'e gitmemeli
curl -N -X POST $WORKER/check -H 'content-type: application/json' \
  -d '{"q":"Çanakkale Savaşı hangi yıldı emin değilim"}'

# FRESH → src:"web"
curl -N -X POST $WORKER/check -H 'content-type: application/json' \
  -d '{"q":"dünkü maç ne olmuş acaba"}'

# SEMI → src:"yerel"
curl -N -X POST $WORKER/check -H 'content-type: application/json' \
  -d '{"q":"asgari ücret neydi emin değilim"}'

# SUBJ → EMİN DEĞİLİM, hiçbir yere gitmemeli
curl -N -X POST $WORKER/check -H 'content-type: application/json' \
  -d '{"q":"bence daha iyiydi değil mi"}'

# Aynı soruyu tekrar sor → src:"cache", ~20ms
curl -N -X POST $WORKER/check -H 'content-type: application/json' \
  -d '{"q":"Çanakkale Savaşı hangi yıldı emin değilim"}'

# Sınıflandırma
curl "$WORKER/classify?q=grev+bitmis+miydi" | python3 -m json.tool

# Sözlük
curl $WORKER/lexicon | python3 -m json.tool | head -20
```

---

# 11. APK

GitHub → repo → **Settings → Secrets and variables → Actions → Variables**
sekmesi → **New repository variable**:

```
Name:  WORKER_URL
Value: https://mai.XXXX.workers.dev
```

**Neden Variable, Secret değil:** Bu değer APK'nın içine gömülüyor ve zaten
herkes görebilir. Gizli bir şey değil. Secret'lar log'larda maskelenir,
gereksiz.

**Neden gerekli:** APK derlenirken bu adres uygulamanın içine yazılıyor.
Uygulama nereye istek atacağını başka türlü bilemez.

Sonra **Actions → APK Build → Run workflow**. APK **Releases** sekmesinde
çıkar, telefondan direkt indirilir.

---

# 12. Worker'ı CI'dan deploy et (opsiyonel)

Aynı yerde **Secrets** sekmesi:

| Secret | Nereden |
|---|---|
| `CLOUDFLARE_API_TOKEN` | dash.cloudflare.com → sağ üst profil → API Tokens → Create Token → **Edit Cloudflare Workers** şablonu |
| `CLOUDFLARE_ACCOUNT_ID` | Workers ana sayfası, sağ sütun |
| `BRAVE_KEY` | Brave anahtarın |

Artık `worker/` altında her push'ta otomatik deploy olur.

---

# 13. Telefonda dene

1. APK'yı kur (Ayarlar → bilinmeyen kaynaklara izin)
2. Mikrofon iznini ver
3. Büyük butona bas → **kırmızı** yanıp sönmeye başlar
4. Yüksek sesle: *"Enflasyon sanırım yüzde otuz beşti"*
5. Tereddüt yakalanınca **mavi-mor dalga** çıkar
6. Cevap büyük punto tek satır belirir, dalga biter
7. Butona tekrar bas → kayda isim ver
8. Sol üst menüden geçmişi kontrol et

**Renk kodları:**

| Renk | Anlam |
|---|---|
| yeşil | hazır |
| kırmızı | dinliyor |
| mavi-mor | tereddüt yakalandı, cevap aranıyor |

---

# Ortam değişkenleri özeti

| Değişken | Nerede | Gizli mi | Ne için |
|---|---|---|---|
| `BRAVE_KEY` | wrangler secret | ✓ | web araması |
| `INGEST_TOKEN` | wrangler secret | ✓ | `/ingest` ucunu korur |
| `SEARCH_PROVIDER` | `wrangler.toml` `[vars]` | ✗ | brave / serper / exa / tavily / none |
| `INTENT_BEFORE_SEARCH` | `wrangler.toml` `[vars]` | ✗ | `false` (varsayılan) = niyet ve arama paralel, hızlı. `true` = seri, +200 ms ama boşa arama yok |
| `CACHE` | `wrangler.toml` binding | ✗ | KV — **isim sabit** |
| `VEC` | `wrangler.toml` binding | ✗ | Vectorize — **isim sabit** |
| `AI` | `wrangler.toml` binding | ✗ | Workers AI — **isim sabit** |
| `WORKER` | terminal export | ✗ | curl komutları |
| `TOKEN` | terminal export | ✗ | ingest.sh |
| `WORKER_URL` | GitHub **Variable** | ✗ | APK'ya gömülür |
| `CLOUDFLARE_API_TOKEN` | GitHub **Secret** | ✓ | CI deploy |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub **Secret** | ✓ | CI deploy |

---

# Günlük kullanım

```bash
cd ~/Downloads/mai/worker

npx wrangler tail                        # canlı log — yayın sırasında açık tut
npx wrangler dev                         # yerelde geliştir
npm test                                 # testler
npx wrangler deploy                      # deploy
curl $WORKER/health                      # sağlık
curl $WORKER/bench | python3 -m json.tool  # gecikme
./scripts/ingest.sh scripts/seed.json    # aylık veri güncellemesi
```

---

# Sorun giderme

| Belirti | Sebep | Çözüm |
|---|---|---|
| `/health` → `"vectorize": false` | `index_name` ile gerçek index adı farklı | `npx wrangler vectorize list` ile karşılaştır |
| `/health` → `"cache": false` | KV bloğu yorumda veya id yanlış | `npx wrangler kv namespace list` |
| Her cevap `"src":"model"` | Arama anahtarı yok | `npx wrangler secret list` |
| Her cevap `EMİN DEĞİLİM` | Arama boş dönüyor | `curl $WORKER/bench` |
| `/ingest` → 401 | `TOKEN` yanlış | `INGEST_TOKEN` ile aynı olmalı |
| Enflasyon sorusu web'e gidiyor | Kayıt bayatladı | `seed.json`'daki `updated` tarihini güncelle, tekrar yükle |
| Uygulama hiç tetiklenmiyor | Sözlük inmemiş | Ayarlar → "sözlük sürümü" 0 ise ağ sorunu |
| Çok sık tetikleniyor | Hedge listesi gevşek | `src/lexicon.js` → `HEDGE`'ten kalıp çıkar, `VERSION` artır, deploy |
| APK derlenmiyor | `WORKER_URL` yok | GitHub → **Variables** sekmesi (Secrets değil) |
| STT Türkçe anlamıyor | Dil paketi | Telefon → Ayarlar → Google → Ses → Türkçe indir |
| `Wrangler requires at least Node.js v22` | Node eski | `nvm install 22 && nvm use 22`, sonra `rm -rf node_modules && npm install` |
| `WORKER: unbound variable` | Değişken tanımsız | `export WORKER=https://...workers.dev` |
| `Expecting value: line 1 column 1` | curl boş döndü | Üsttekinin sonucu; `WORKER` düzelince gider |
| Cevaplar yavaş | Arama yavaş | `bench` çalıştır, gerekirse `SEARCH_PROVIDER = "none"` |
| Telefon backend'e ulaşmıyor | APK'ya yanlış adres gömülü | Ayarlar → **Bağlantı** satırına bak; yanlışsa `-PworkerUrl=` ile yeniden derle |
| `wrangler tail` → "Worker name missing" | Kök dizindesin | `cd worker` yap, ya da `npx wrangler tail mai` |
| CI deploy → `Authentication error [code: 10000]` | `wrangler-action`'da `secrets:` bloğu var | Bloğu kaldır; secret'lar zaten Cloudflare'de. Token'a sadece **Workers Scripts: Edit** yeter |
| Düz soru tetiklemiyor | Eski sözlük/APK | Sözlük 8+ olmalı (Ayarlar); Kotlin mantığı da değiştiği için APK'yı yeniden derle |
| `semi` sorular hep web'e gidiyor | Benzerlik eşiği fazla katı | `/debug?q=` çıktısındaki `similarityScore`'lara bak, `MIN_SCORE`'u boşluğa ayarla (Türkçe için 0.48) |


---

# Bakım notu

İki düzenli iş var (ikisi de kod değil, veri):

1. **`scripts/seed.json` — ayda bir.** TÜİK/TCMB yeni rakam açıklayınca güncelle
   ve `./scripts/ingest.sh` çalıştır. Unutursan `maxDays` bayat kaydı otomatik
   web'e düşürür; yanlış cevap gitmez ama o soru yavaşlar.

2. **`SEMI_INDICATOR` listesi (lexicon.js) — çok seyrek.** Yeni bir ekonomik
   gösterge sorulmaya başlarsa listeye ekle. Bu liste bir konunun `semi`
   sayılıp web'e gidebilmesini sağlıyor; olmadan `static` olur ve web'e hiç
   gitmez, yani bayat veri güncellenemez.

Otomatikleştirme (cron worker ile seed'i kendiliğinden güncelleme) README
"Gelecek işler" bölümünde TODO olarak duruyor.
