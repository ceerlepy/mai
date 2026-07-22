# KURULUM — komut komut

Sıfırdan çalışır hale gelmek için bu dosyayı yukarıdan aşağı takip et.
Her adımın sonunda bir doğrulama komutu var; o geçmeden sonrakine geçme.

---

## 0. Ön koşullar

```bash
node --version     # v18+ olmalı
npm --version
```

Node yoksa: https://nodejs.org (LTS sürüm)

Gerekli hesaplar:
- **Cloudflare** — dash.cloudflare.com (ücretsiz kayıt)
- **Brave Search API** — api.search.brave.com → **Search** planı
  (Answers planını ALMA, 4.5 sn sürüyor)
  Alternatif: serper.dev (kayıtta 2500 ücretsiz sorgu)
- **GitHub** — APK derlemek için (opsiyonel, yerelde de derlenebilir)

---

## 1. Repoyu hazırla

```bash
unzip teyit-repo.zip
cd teyit

git init
git add .
git commit -m "ilk surum"
git branch -M main
git remote add origin https://github.com/<KULLANICI>/teyit.git
git push -u origin main
```

---

## 2. Testleri çalıştır (deploy öncesi, ağ gerekmez)

```bash
cd worker
npm install
npm test
```

**Beklenen çıktı:** `TÜM TESTLER GEÇTİ (88/88)`

Geçmezse dur, deploy etme.

---

## 3. Cloudflare'e bağlan

```bash
npx wrangler login
```

Tarayıcı açılır, izin ver. Sonra doğrula:

```bash
npx wrangler whoami
```

---

## 4. Secret'ları gir

Bunlar `wrangler.toml`'a YAZILMAZ, şifreli saklanır.

```bash
# Arama anahtarı — hangi sağlayıcıyı seçtiysen
npx wrangler secret put BRAVE_KEY
# (soruyu görünce anahtarı yapıştır, Enter)

# Yerel bilgi tabanını doldurmak için parola — kendin uydur
npx wrangler secret put INGEST_TOKEN
```

Serper kullanacaksan `BRAVE_KEY` yerine:
```bash
npx wrangler secret put SERPER_KEY
```
ve `wrangler.toml` içinde `SEARCH_PROVIDER = "serper"` yap.

Kontrol:
```bash
npx wrangler secret list
```

---

## 5. İlk deploy

```bash
npx wrangler deploy
```

Çıktının sonunda URL var:
```
https://teyit-asistani.<SENIN-SUBDOMAIN>.workers.dev
```

**Bu URL'yi kaydet, her yerde lazım:**

```bash
export WORKER=https://teyit-asistani.<SENIN-SUBDOMAIN>.workers.dev
```

---

## 6. Sağlık kontrolü

```bash
curl $WORKER/health
```

**Beklenen:**
```json
{
  "ok": true,
  "model": "@cf/meta/llama-3.1-8b-instruct-fast",
  "provider": "brave",
  "cache": false,
  "vectorize": false
}
```

`cache` ve `vectorize` şu an `false` — 8. adımda açacağız.

---

## 7. İlk gerçek test

```bash
curl -N -X POST $WORKER/check \
  -H 'content-type: application/json' \
  -d '{"q":"Çanakkale Savaşı hangi yıldı emin değilim"}'
```

SSE akışı görmelisin:
```
event: draft
data: {"text":"1915","ms":412}

event: answer
data: {"text":"Çanakkale Savaşı 1915'te başladı","src":"model","cls":"static","ms":648,"final":true,"refs":[]}

event: done
data: {"ms":650}
```

Taze soru testi (web'e gitmeli):
```bash
curl -N -X POST $WORKER/check \
  -H 'content-type: application/json' \
  -d '{"q":"dünkü maç ne olmuş acaba"}'
```
`"src":"web"` görmelisin.

---

## 8. KV cache ve Vectorize'ı aç

### 8.1 KV cache

```bash
npx wrangler kv namespace create CACHE
```

Çıktıda şuna benzer bir blok verir:
```
[[kv_namespaces]]
binding = "CACHE"
id = "abc123def456..."
```

`wrangler.toml` dosyasını aç, ilgili yorumlu bloğu bul, `#` işaretlerini kaldır
ve `id` değerini yapıştır.

### 8.2 Vectorize

```bash
npx wrangler vectorize create teyit-bilgi --dimensions=1024 --metric=cosine
```

`wrangler.toml` içinde `[[vectorize]]` bloğunun `#`'lerini kaldır.

### 8.3 Tekrar deploy

```bash
npx wrangler deploy
curl $WORKER/health
```

Artık `"cache": true, "vectorize": true` görmelisin.

---

## 9. Yerel bilgi tabanını doldur

```bash
# Önce güncel rakamları gir:
nano scripts/seed.json
```

Dosyadaki her `"text"` alanında `GÜNCELLE:` ile başlayan açıklama var.
Onları gerçek rakamlarla değiştir. Örnek:

```json
{
  "id": "tuik-enflasyon",
  "title": "Yıllık tüketici enflasyonu (TÜFE)",
  "text": "Haziran 2026 itibarıyla yıllık TÜFE yüzde 33,4.",
  "source": "https://data.tuik.gov.tr",
  "updated": "2026-07-01"
}
```

Sonra yükle:

```bash
export TOKEN=<4. adımda girdiğin INGEST_TOKEN>
./scripts/ingest.sh scripts/seed.json
```

**Beklenen:** `{"ok": true, "count": 5}`

Doğrula — artık `src: "yerel"` dönmeli:
```bash
curl -N -X POST $WORKER/check \
  -H 'content-type: application/json' \
  -d '{"q":"enflasyon sanırım yüzde 35ti"}'
```

> Bu dosyayı **ayda bir** güncelle. Güncel kaldığı sürece bu sorular
> ~80 ms'de, web'e gitmeden cevaplanır.

---

## 10. Gecikme ölçümü — EN KRİTİK ADIM

```bash
curl $WORKER/bench | python3 -m json.tool
```

Birden fazla arama anahtarın varsa hepsini yarıştır:
```bash
curl "$WORKER/bench?full=1" | python3 -m json.tool
```

Çıktı doğrudan kararı yazar:

| p95 | Karar |
|---|---|
| < 2.5 sn | Canlı özellik yaşayabilir → devam |
| 2.5–4 sn | `wrangler.toml` → `SEARCH_PROVIDER = "none"` yap, Vectorize + model yoluna geç |
| > 4 sn | Canlıyı bırak, kayıt-sonrası rapor ürününe dön |

---

## 11. Triyaj testi (gerçek model çağrısı)

```bash
npm run test:triage
```

veya:
```bash
./test/triage.test.sh
```

Bu, `triage.js`'in gerçekten doğru karar verip vermediğini ve kaç ms
sürdüğünü gösterir.

**Beklenen:**
- Tarihsel olanlar (Osmanlı, Lozan, Fransız İhtilali) → `static`
- Güncel olanlar (grev, kanun, dava, zam) → `fresh`
- Triyaj süresi **150–250 ms** bandında

400 ms üstüyse `triage.js` içindeki tavan devreye giriyor demektir, kontrol et.

---

## 12. Sınıflandırma testi (kendi cümlelerinle)

Tek cümle:
```bash
curl "$WORKER/classify?q=grev%20bitmis%20miydi%20acaba" | python3 -m json.tool
```

Toplu:
```bash
curl -X POST $WORKER/classify \
  -H 'content-type: application/json' \
  -d '{"texts":["dünkü maç ne olmuş","enflasyon kaçtı","bence daha iyiydi"]}' \
  | python3 -m json.tool
```

---

## 13. Kelime listesini kontrol et

```bash
curl $WORKER/lexicon | python3 -m json.tool | head -30
```

Android uygulaması bunu açılışta çeker. **Kelime eklemek için APK derlemeye
gerek yok:**

```bash
nano src/lexicon.js      # kelime ekle
# VERSION sayısını artır!
npx wrangler deploy
```

Uygulama bir sonraki açılışta yeni listeyi alır.

---

## 14. APK üret

### Seçenek A — GitHub Actions (önerilen)

GitHub'da repoya git:

**Settings → Secrets and variables → Actions → Variables sekmesi → New variable**
```
Name:  WORKER_URL
Value: https://teyit-asistani.<SENIN-SUBDOMAIN>.workers.dev
```

Sonra **Actions → APK Build → Run workflow**.

Bitince APK iki yerde:
- Actions çalışmasının altında artifact olarak
- **Releases** sekmesinde (telefondan direkt indirilir)

### Seçenek B — Yerelde

Android Studio ile `android/` klasörünü aç (Gradle wrapper'ı kendi üretir),
sonra:

```bash
cd android
./gradlew assembleRelease -PworkerUrl=$WORKER
```

APK: `app/build/outputs/apk/release/app-release.apk`

---

## 15. Worker'ı da GitHub'dan deploy et (opsiyonel)

**Settings → Secrets and variables → Actions → Secrets**

| Secret | Nereden |
|---|---|
| `CLOUDFLARE_API_TOKEN` | dash.cloudflare.com → My Profile → API Tokens → **Edit Cloudflare Workers** şablonu |
| `CLOUDFLARE_ACCOUNT_ID` | Workers ana sayfasının sağ sütunu |
| `BRAVE_KEY` | api.search.brave.com |

Artık `worker/` altında her değişiklikte otomatik deploy olur.

---

## 16. Telefona kur ve dene

1. APK'yı indir, kur (Ayarlar → bilinmeyen kaynaklara izin ver)
2. Uygulamayı aç, mikrofon iznini ver
3. Ortadaki büyük butona bas → kırmızı yanıp sönmeye başlar
4. Şunu yüksek sesle söyle:
   > "Enflasyon sanırım yüzde otuz beşti"
5. Ekranda büyük punto tek satır cevap belirmeli
6. Butona tekrar bas → kayda isim ver
7. Sol üstteki menüden geçmişi kontrol et

---

# Günlük kullanım komutları

```bash
# Canlı log izle (yayın sırasında ayrı terminalde açık tut)
cd worker && npx wrangler tail

# Yerelde geliştir
npx wrangler dev

# Testleri çalıştır
npm test

# Deploy
npx wrangler deploy

# Sağlık
curl $WORKER/health

# Gecikme
curl $WORKER/bench | python3 -m json.tool

# Aylık bilgi güncellemesi
nano scripts/seed.json && ./scripts/ingest.sh scripts/seed.json
```

---

# Sorun giderme

| Belirti | Sebep | Çözüm |
|---|---|---|
| `/health` → `"cache": false` | KV bağlı değil | Adım 8.1, `wrangler.toml`'da `#` kaldırmayı unutma |
| Her cevap `"src": "model"` | Arama anahtarı yok/yanlış | `npx wrangler secret list`, sonra `secret put` |
| Her cevap `EMİN DEĞİLİM` | Arama boş dönüyor | `curl $WORKER/bench` ile sağlayıcıyı test et |
| Uygulama hiç tetiklenmiyor | Sözlük inmemiş | Ayarlar → "sözlük sürümü" 0 ise ağ sorunu var |
| Çok sık tetikleniyor | Hedge listesi gevşek | `lexicon.js` → `HEDGE` içinden kalıp çıkar, VERSION artır |
| Cevaplar geç geliyor | Arama yavaş | `bench` çalıştır; p95 > 2.5 sn ise `SEARCH_PROVIDER = "none"` |
| APK derlenmiyor | `WORKER_URL` variable yok | Adım 14, **Variables** sekmesi (Secrets değil) |
| STT Türkçe anlamıyor | Cihaz dil paketi | Telefon ayarları → Google → Ses → Türkçe indir |
