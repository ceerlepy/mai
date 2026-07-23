# API Referansı

> Tetikleme kararının mantığı: **[TRIGGER-LOGIC.md](TRIGGER-LOGIC.md)**

Tüm alan adları İngilizce. Ekrana basılan metinler (`text` alanı) Türkçe —
o veri değil, sunucunun okuyacağı cevap.

## Adlandırma kuralları

| Kalıp | Anlamı | Örnek |
|---|---|---|
| `*Ms` | Milisaniye cinsinden süre | `latencyMs`, `embeddingMs` |
| `is*` | Durum bildiren boolean | `isFinal`, `isStale` |
| `has*` / `*Configured` / `*Bound` | Varlık bildiren boolean | `apiKeyConfigured`, `vectorizeBound` |
| `will*` | Planlanan davranış | `willSearchWeb` |
| `*Count` | Adet | `modelCheckedCount` |
| çoğul isim | Dizi | `matches`, `sources`, `results` |

---

# POST /check

Ana uç. SSE (Server-Sent Events) akışı döner.

## İstek

```json
{
  "q": "enflasyon sanırım yüzde 35ti",
  "ctx": "önceki 1-2 cümle, bağlam için",
  "spec": false
}
```

| Alan | Tip | Zorunlu | Anlamı |
|---|---|---|---|
| `q` | string | ✓ | Tereddüt edilen cümle. Max 400 karakter. |
| `ctx` | string | | Önceki cümleler. Niyet çoğu zaman buradan anlaşılır. Max 300 karakter. |
| `spec` | boolean | | `true` ise **spekülatif çağrı**: cevap dönmez, sadece cache ısıtılır. |

## Yanıt: SSE olayları

### `event: draft`

Model cevabı üretirken token token akar. Ekranda soluk renkte gösterilir.

```
event: draft
data: {"text":"Haziran 2026 itibarıyla","latencyMs":412}
```

Birden çok `draft` gelir. Bunları kalıcı gösterme.

### `event: answer`

Kesin cevap. Her istekte tam bir tane gelir.

**Bilgi istenmişse:**

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

**Bilgi istenmemişse:**

```json
{
  "text": "",
  "source": "no-request",
  "topicClass": "fresh",
  "speakerWantsInfo": false,
  "intentCheckedBy": "regex",
  "latencyMs": 2,
  "isFinal": true,
  "sources": []
}
```

> **Android bu durumda ekrana hiçbir şey basmaz.** Konuşmacı zaten bir şey
> sormamıştı; metin göstermek gürültü olur.

| Alan | Tip | Anlamı |
|---|---|---|
| `text` | string | Ekrana basılacak metin. Max 12 kelime. Kanıt yoksa `"EMİN DEĞİLİM"`. Bilgi istenmemişse boş. |
| `source` | enum | Cevabın nereden geldiği (aşağıda) |
| `topicClass` | enum | **EKSEN 2** — bilginin türü: `fresh` \| `semi` \| `static` |
| `speakerWantsInfo` | boolean | **EKSEN 1** — konuşmacı bilgi istiyor muydu |
| `intentCheckedBy` | enum | Niyet kararını kim verdi: `regex` \| `model` \| `cache` |
| `intentLatencyMs` | number | Niyet kontrolünün süresi. `regex` ise 0. |
| `latencyMs` | number | Toplam süre |
| `isFinal` | boolean | Her zaman `true` |
| `sources` | array | Kaynaklar `{title, url}`. Model kendi bilgisinden cevapladıysa boş. |

#### `source` değerleri

| Değer | Nereden | Tipik süre | Ücret |
|---|---|---|---|
| `cache` | KV'de aynı soru vardı | 10-30 ms | yok |
| `local` | Vectorize yerel bilgi tabanı | 550-800 ms | yok |
| `model` | Modelin kendi bilgisi | 500-700 ms | yok |
| `web` | Web araması + model | 1100-1600 ms | 1 sorgu |
| `no-request` | Konuşmacı bilgi istememiş | 0-200 ms | belki 1 sorgu* |
| `none` | Kanıt bulunamadı | değişken | belki 1 sorgu |

\* Paralel modda niyet kontrolü ile arama aynı anda başlar; niyet "hayır"
derse arama yapılmış olur. `INTENT_BEFORE_SEARCH=true` ile önlenebilir.

#### `topicClass` değerleri

| Değer | Ne demek | Örnek |
|---|---|---|
| `fresh` | Güncel olay. **Web zorunlu**, model tek başına cevaplayamaz. | "dünkü maç ne olmuş" |
| `semi` | Yarı-güncel gösterge. Vectorize'da olabilir. | "enflasyon kaçtı" |
| `static` | Değişmeyen bilgi. Model bilir, web'e gidilmez. | "Çanakkale hangi yıl" |

> `topicClass` **niyetten bağımsızdır.** "dünkü maç ne olmuş" ve "dünkü maçı
> sonra konuşuruz" cümlelerinin ikisi de `fresh`; ayıran şey
> `speakerWantsInfo`.

### `event: done`

```
event: done
data: {"latencyMs": 640}
```

---

# GET /health

Bağlantı ve yapılandırma durumu.

```json
{
  "ok": true,
  "answerModel": "@cf/meta/llama-3.1-8b-instruct-fast",
  "searchProvider": "brave",
  "searchKeyConfigured": true,
  "kvCacheBound": true,
  "vectorizeBound": true,
  "ingestProtected": true,
  "lexiconVersion": 7,
  "intentBeforeSearch": false
}
```

| Alan | `false` ise ne yapmalı |
|---|---|
| `searchKeyConfigured` | `npx wrangler secret put BRAVE_KEY` |
| `kvCacheBound` | `wrangler.toml` → `[[kv_namespaces]]` bloğu yorumda veya `id` yanlış |
| `vectorizeBound` | `wrangler.toml` → `[[vectorize]]` bloğu yorumda veya `index_name` gerçek index adıyla uyuşmuyor |
| `ingestProtected` | `npx wrangler secret put INGEST_TOKEN` — bu olmadan `/ingest` çalışmaz |

| Alan | Anlamı |
|---|---|
| `lexiconVersion` | Sözlük sürümü. Android'in indirdiği sürümle karşılaştır |
| `intentBeforeSearch` | `false` = niyet ve arama paralel (hızlı, boşa arama olabilir). `true` = seri (+200 ms, boşa arama yok) |

---

# GET /debug?q=...

**Teşhis ucu.** `source: "none"` veya beklenmedik bir karar görürsen buradan
bakılır.

```bash
curl "$WORKER/debug?q=Veysel%20asgari%20ucret%20ne%20oldu" | python3 -m json.tool
curl "$WORKER/debug?q=CÜMLE&ctx=ÖNCEKİ%20CÜMLE" | python3 -m json.tool
```

```json
{
  "question": "Veysel asgari ucret ne oldu",

  "intent": {
    "regexPrecheck": "ask",
    "decidedBy": "model",
    "speakerWantsInfo": true,
    "latencyMs": 187,
    "rawResponse": "EVET"
  },

  "topic": {
    "topicClass": "semi",
    "routingPlan": {
      "willCheckCache": true,
      "willCheckVectorize": true,
      "willSearchWeb": true,
      "modelMayAnswerAlone": false,
      "cacheTtlSeconds": 21600
    }
  },

  "vectorizeLookup": {
    "embeddedText": "Veysel asgari ucret ne oldu",
    "similarityThreshold": 0.62,
    "embeddingMs": 41,
    "vectorSearchMs": 38,
    "totalMatches": 5,
    "usableMatches": 1,
    "matches": [
      {
        "recordId": "asgari-ucret",
        "similarityScore": 0.7412,
        "passesThreshold": true,
        "title": "Asgari ücret 2026",
        "lastUpdated": "2026-07-01",
        "maxAgeDays": 200,
        "isStale": false,
        "usable": true
      }
    ]
  },

  "webSearch": {
    "provider": "brave",
    "apiKeyConfigured": true,
    "generatedQuery": "Veysel asgari ucret",
    "searchMs": 687,
    "error": null,
    "resultFound": true,
    "evidencePreview": "[1] Asgari Ücret 2026 — ..."
  }
}
```

## `intent` — EKSEN 1

| Alan | Anlamı |
|---|---|
| `regexPrecheck` | `skip` = regex kesin eledi, model **hiç çağrılmadı**. `ask` = regex karar veremedi, modele soruldu |
| `decidedBy` | `regex` \| `model` |
| `speakerWantsInfo` | Nihai karar |
| `latencyMs` | Model çağrısının süresi. `regex` ise 0 |
| `rawResponse` | Modelin ham cevabı (`EVET`/`HAYIR`). Beklenmedik sonuçta buraya bak |

## `topic` — EKSEN 2

| Alan | Anlamı |
|---|---|
| `topicClass` | `fresh` \| `semi` \| `static` |
| `willCheckCache` | KV'ye bakılacak mı |
| `willCheckVectorize` | Yerel bilgi tabanı sorgulanacak mı. `fresh`'te her zaman `false` |
| `willSearchWeb` | Web araması yapılacak mı. `static`'te `false` |
| `modelMayAnswerAlone` | Model kanıtsız cevap verebilir mi. **`fresh`'te her zaman `false`** |
| `cacheTtlSeconds` | Cevabın kaç saniye saklanacağı |

## `vectorizeLookup`

| Alan | Anlamı |
|---|---|
| `similarityThreshold` | Kabul eşiği. Altındakiler kullanılmaz |
| `embeddingMs` | Soruyu vektöre çevirme süresi |
| `vectorSearchMs` | Index'te arama süresi |
| `totalMatches` | Dönen kayıt sayısı (eşik uygulanmadan) |
| `usableMatches` | Eşiği geçen **ve** bayat olmayan kayıt sayısı. **`0` ise web'e düşülür** |

`matches[]` içinde:

| Alan | Anlamı |
|---|---|
| `recordId` | `seed.json`'daki `id` |
| `similarityScore` | Kosinüs benzerliği. `1.0` = aynı anlam |
| `passesThreshold` | Skor eşiği geçti mi |
| `isStale` | Ömrü doldu mu |
| `usable` | `passesThreshold && !isStale` — asıl belirleyici |

## `webSearch`

| Alan | Anlamı |
|---|---|
| `apiKeyConfigured` | Secret Worker'a ulaşıyor mu |
| `generatedQuery` | Hedge kelimeleri atılmış, `fresh` ise tarih eklenmiş sorgu |
| `error` | `null` değilse API hatası |
| `resultFound` | Sonuç geldi mi |
| `evidencePreview` | Modele verilen kanıtın ilk 400 karakteri |

## Teşhis akışı

| Belirti | Bakılacak alan | Anlamı |
|---|---|---|
| Ekrana bir şey basılmıyor | `intent.speakerWantsInfo: false` | Model bilgi istenmediğine karar verdi. `rawResponse` ve `regexPrecheck` ile doğrula |
| `source: "none"` | `vectorizeLookup.error` | Binding yok |
| | `vectorizeLookup.totalMatches: 0` | Index boş, `ingest.sh` çalıştırılmamış |
| | `usableMatches: 0`, `totalMatches > 0` | Skor düşük veya kayıt bayat |
| | `webSearch.apiKeyConfigured: false` | Secret ulaşmıyor |
| | `webSearch.error` dolu | API hatası |
| Yanlış konu sınıfı | `topic.topicClass` | `lexicon.js` listelerine bak |

---

# GET/POST /classify

Konu ve niyet sınıflandırmasını test eder. **Modeli gerçekten çağırır.**

```bash
curl "$WORKER/classify?q=Veysel+asgari+ucret+ne+oldu"

curl -X POST $WORKER/classify -H 'content-type: application/json' \
  -d '{"texts":["Veysel asgari ücret ne oldu","asgari ücret ne oldu bilmiyorum","bence çok yüksek"]}'
```

```json
{
  "questionsAnalyzed": 3,
  "regexResolvedCount": 1,
  "modelCheckedCount": 2,
  "willAnswerCount": 1,
  "intentAvgLatencyMs": 191,
  "results": [
    {
      "text": "Veysel asgari ücret ne oldu",
      "topicClass": "semi",
      "intentRegexPrecheck": "ask",
      "intentDecidedBy": "model",
      "speakerWantsInfo": true,
      "intentLatencyMs": 187,
      "intentRawResponse": "EVET",
      "willAnswer": true,
      "routingPlan": { "willCheckVectorize": true, "willSearchWeb": true,
                       "modelMayAnswerAlone": false, "cacheTtlSeconds": 21600 }
    }
  ]
}
```

| Alan | Anlamı |
|---|---|
| `questionsAnalyzed` | Analiz edilen cümle sayısı (max 40) |
| `regexResolvedCount` | Regex'in tek başına çözdüğü — model çağrılmadı, 0 ms |
| `modelCheckedCount` | Modele sorulan sayısı |
| `willAnswerCount` | Kaçına cevap üretilecek |
| `intentAvgLatencyMs` | Model çağrılarının ortalama süresi |

Sonuç satırında:

| Alan | Anlamı |
|---|---|
| `topicClass` | Bilginin türü (nesnel) |
| `intentRegexPrecheck` | `skip` = regex kesin eledi · `ask` = modele soruldu |
| `intentDecidedBy` | `regex` \| `model` |
| `speakerWantsInfo` | Nihai niyet kararı |
| `intentRawResponse` | Modelin ham cevabı. `null` = model çağrılmadı |
| `willAnswer` | Bu cümle için cevap üretilecek mi |

## Ayarlama için ne izlenir

| Metrik | Sağlıklı aralık | Aşarsa |
|---|---|---|
| `modelCheckedCount / questionsAnalyzed` | %60-90 | Çok yüksekse `HARD_SKIP` listesine kesin kalıplar eklenebilir |
| `intentAvgLatencyMs` | 150-250 ms | 400 ms üstü = `intent.js` tavanı devreye giriyor |
| `willAnswerCount / questionsAnalyzed` | değişken | Çok düşükse model fazla eliyor; `intent.js` örneklerine bak |

---

# GET /bench

Gecikme ölçümü. **Projenin en kritik ucu** — canlı modun yaşayabilir olup
olmadığını söyler.

```bash
curl $WORKER/bench | python3 -m json.tool
curl "$WORKER/bench?full=1" | python3 -m json.tool   # tüm sağlayıcıları yarıştır
```

```json
{
  "activeProvider": "brave",
  "kvCacheBound": true,
  "vectorizeBound": true,
  "latencyByProvider": {
    "brave": {
      "latencyP50Ms": 1180,
      "latencyP95Ms": 1640,
      "latencyByTopicMs": {
        "fresh": 1520,
        "semi": 640,
        "static": 580
      },
      "intentAvgLatencyMs": 191
    }
  },
  "fastestProvider": "brave",
  "verdict": "VIABLE",
  "recommendation": "p95 1640ms — live mode is viable, continue building."
}
```

| Alan | Anlamı |
|---|---|
| `activeProvider` | `wrangler.toml`'daki `SEARCH_PROVIDER` |
| `latencyP50Ms` | Ortanca gecikme |
| `latencyP95Ms` | Yavaş uçtaki gecikme. **Karar bu sayıya göre verilir** |
| `latencyByTopicMs` | Konu bazında ortanca. `fresh` yüksek, `static` düşük olmalı |
| `intentAvgLatencyMs` | Niyet kontrolünün ortalama süresi. Paralel koştuğu için toplama eklenmez |
| `fastestProvider` | `?full=1` ile birden fazla sağlayıcı test edildiyse en hızlısı |
| `verdict` | Makine tarafından okunabilir karar kodu |
| `recommendation` | İnsan tarafından okunabilir açıklama |

## `verdict` değerleri

| Değer | p95 | Ne yapmalı |
|---|---|---|
| `VIABLE` | < 2500 ms | Canlı mod çalışır, geliştirmeye devam |
| `DISABLE_WEB_SEARCH` | 2500-4000 ms | `SEARCH_PROVIDER="none"` yap. Vectorize + model kalır; canlı olaylar cevaplanamaz ama hız yeter |
| `DROP_LIVE_MODE` | > 4000 ms | Canlı modu bırak, kayıt-sonrası rapor ürününe geç |
| `NO_PROVIDER` | — | Hiçbir arama anahtarı yapılandırılmamış |

---

# GET /lexicon

Kelime listeleri. Android uygulaması açılışta çeker ve diske yazar.

```json
{
  "version": 7,
  "hedge": ["sanırım", "galiba", "emin değilim", "neydi", "..."],
  "hedgeIgnore": ["neyse", "boş ver", "..."],
  "noTrigger": ["bence", "sence", "sizce ne olur", "..."],
  "checkableHints": ["enflasyon", "asgari ücret", "maç", "..."]
}
```

| Alan | Uygulamada ne için |
|---|---|
| `version` | Sürüm takibi. Ayarlar ekranında görünür. **Liste değiştirdiğinde artır** |
| `hedge` | Tetikleyici ifadeler. Biri geçerse istek atılır |
| `hedgeIgnore` | Kesin tetiklememesi gereken kalıplar. Önce bunlara bakılır |
| `noTrigger` | Cihazda kesin elenecekler (görüş bildirimi). **Bilerek kısa** — asıl niyet kararı sunucuda modelde |
| `checkableHints` | Doğrulanabilir konu kelimeleri. Cümlede rakam yoksa bunlardan biri aranır |

> Cihazda ayrıca `-acak/-ecek` fiil eki kontrolü var (kod içinde, listede
> değil) — gelecek zamanlı cümleler hiç gönderilmez.

**Kelime eklemek için APK derlemeye gerek yok:**

```bash
nano worker/src/lexicon.js    # kelime ekle, VERSION'u artır
npx wrangler deploy
```

---

# POST /ingest

Vectorize'a veri yükler. `INGEST_TOKEN` ile korunuyor.

```bash
curl -X POST $WORKER/ingest \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  --data-binary @scripts/seed.json
```

## İstek

```json
{
  "items": [
    {
      "id": "tufe-yillik",
      "title": "Yıllık tüketici enflasyonu (TÜFE)",
      "text": "Haziran 2026 itibarıyla yıllık TÜFE yüzde 32,11...",
      "source": "https://data.tuik.gov.tr",
      "updated": "2026-07-03",
      "maxDays": 45
    }
  ]
}
```

| Alan | Zorunlu | Anlamı |
|---|---|---|
| `id` | ✓ | Benzersiz kimlik. **Aynı id tekrar gönderilirse üzerine yazar** (upsert), kopya oluşmaz |
| `title` | ✓ | Başlık. Embedding'e dahil edilir, arama isabetini artırır |
| `text` | ✓ | Asıl cevap metni. Modele kanıt olarak verilir. Max 900 karakter |
| `source` | | Kaynak URL. Cevabın `sources` alanında döner |
| `updated` | | ISO tarih. Tazelik hesabı bundan yapılır. Verilmezse bugün |
| `maxDays` | | Bu kaydın tazelik ömrü (gün). Verilmezse 45 |

### `maxDays` nasıl seçilir

Verinin **açıklanma sıklığına** göre:

| Veri türü | Sıklık | Önerilen |
|---|---|---|
| Enflasyon, işsizlik, istihdam | aylık | 45 |
| Politika faizi | 6-8 haftada bir | 60 |
| Asgari ücret, memur zammı | yılda 1-2 | 200 |
| Nüfus | yılda 1 | 400 |

Süre dolduğunda kayıt **kullanılmaz**, soru web aramasına düşer. Yani
güncellemeyi unutursan yanlış cevap gitmez, sadece yavaşlar.

## Yanıt

```json
{ "ok": true, "count": 8 }
```

| Hata | Sebep |
|---|---|
| `401 yetkisiz` | `authorization` başlığı yok veya `INGEST_TOKEN` ile uyuşmuyor |
| `{"ok":false,"error":"Vectorize not bound"}` | `wrangler.toml`'da `[[vectorize]]` eksik |

---

# GET /warm

Model ve bağlantıyı ısıtır. Android mikrofona basıldığında çağırır.

```json
{ "ok": true }
```

TCP/TLS el sıkışması ve modelin soğuk başlangıcı önden halledilir — ilk gerçek
istekte ~200 ms kazandırır.

---

# Hata yanıtları

| Kod | Gövde | Sebep |
|---|---|---|
| `400` | `json` | İstek gövdesi geçerli JSON değil |
| `400` | `query` | `q` boş veya 400 karakterden uzun |
| `400` | `q gerekli` | `/debug` çağrısında `q` parametresi yok |
| `401` | `yetkisiz` | `/ingest` için token yanlış |
| `404` | `not found` | Bilinmeyen yol |

**Not:** `/check` ucunda iç hatalar (arama başarısız, model hatası) HTTP hatası
döndürmez. Bunun yerine `source: "none"` ve `"EMİN DEĞİLİM"` döner. Sebebi:
canlı yayında hata ekranı göstermek, "bilmiyorum" demekten kötüdür.
Ne olduğunu görmek için `/debug` veya `npx wrangler tail` kullan.
