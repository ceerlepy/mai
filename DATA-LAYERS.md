# Veri katmanları — KV ve Vectorize

> Tetikleme kararının nasıl verildiği ayrı bir doküman:
> **[TRIGGER-LOGIC.md](TRIGGER-LOGIC.md)**

Bu iki katman projenin hem hızını hem maliyetini belirliyor. Bu bölüm ikisinin
**nasıl çalıştığını**, **neden bu şekilde tasarlandığını** ve **koddaki tam
karşılığını** anlatıyor.

---

## 0. Neden iki ayrı depo?

Farklı sorulara cevap veriyorlar:

| Soru | Katman | Neden |
|---|---|---|
| "Bu **tam** soruyu daha önce cevapladım mı?" | KV | Birebir eşleşme, hash ile bakılır, 20 ms |
| "Bu sorunun **konusunu** biliyor muyum?" | Vectorize | Anlam benzerliği, 80 ms |

KV bir sözlük: anahtar varsa değeri döner, yoksa yok. Vectorize bir arama
motoru: birebir eşleşme aramaz, en yakın anlamı bulur.

---

## 1. KV cache

### 1.1 Problem

Yayında aynı konu birkaç kez döner. "Enflasyon kaçtı" üç kez sorulursa üç kez
arama yapıp üç kez ücret ödemek anlamsız.

```
Cache yok:   soru → arama (700ms) → model (500ms) → cevap   ~1200 ms + ücret
Cache var:   soru → KV (20ms)                     → cevap     ~20 ms + bedava
```

### 1.2 Anahtar nasıl üretiliyor

Aynı soru farklı yazılabilir: *"Enflasyon sanırım %35'ti"* ve
*"enflasyon sanırım 35 ti"* aynı şeydir. Normalize edip hash'liyoruz.

```js
// src/index.js
function cacheKey(q) {
  // 1. Küçük harfe çevir, harf ve rakam dışındaki her şeyi at
  //    "Enflasyon sanırım %35'ti!" -> "enflasyonsanırım35ti"
  const n = q.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "").slice(0, 120);

  // 2. djb2 hash — hızlı, çakışma oranı bu ölçekte ihmal edilebilir
  let h = 5381;
  for (let i = 0; i < n.length; i++) h = ((h << 5) + h + n.charCodeAt(i)) >>> 0;

  return `a:${h.toString(36)}`;   // örn "a:1x4k9z"
}
```

**Neden hash, düz metin değil:** KV anahtarı 512 byte ile sınırlı ve boşluk
içeremez. Uzun cümleyi anahtar yapamayız.

**Neden kriptografik hash (SHA) değil:** SHA hesaplamak ~1 ms sürer ve Web
Crypto API'si `async`. Burada güvenlik değil hız gerekiyor; djb2 mikrosaniye
mertebesinde ve senkron.

### 1.3 Sınıf bazlı ömür (TTL)

En kritik tasarım kararı. Taze veri uzun saklanırsa **canlı yayında bayat
cevap** verirsin.

```js
// src/topic.js — her sınıfın kendi cache ömrü var
case TOPIC.STATIC:
  return { ..., ttl: 604800 };   // 7 gün  — Çanakkale'nin yılı değişmez
case TOPIC.SEMI:
  return { ..., ttl: 21600 };    // 6 saat — enflasyon gün içinde değişmez
case TOPIC.FRESH:
  return { ..., ttl: 900 };      // 15 dk  — "az önce ne oldu" hızla eskir
// Not: bilgi istenmemişse (speakerWantsInfo=false) cache'e hiç yazılmaz
```

Yazarken bu ömür geçiriliyor:

```js
// src/index.js
if (plan.ttl) ctx.waitUntil(kvPut(env, key, { text: out.text, refs: out.refs }, plan.ttl));

async function kvPut(env, k, v, ttl) {
  if (!env.CACHE) return;                       // KV bağlı değilse sessizce atla
  try {
    await env.CACHE.put(k, JSON.stringify(v), { expirationTtl: ttl || CACHE_TTL });
  } catch {}                                    // cache hatası cevabı engellemez
}
```

**`ctx.waitUntil` neden var:** Cevabı kullanıcıya gönderdikten *sonra* cache'e
yazıyoruz. `await` etseydik kullanıcı KV yazma süresini (~30 ms) beklerdi.
`waitUntil` Worker'a "yanıtı gönder, bu işi arkada bitir" diyor.

**`try/catch` neden boş:** KV'ye yazamamak cevabı bozmaz. Canlı yayında
cache hatası yüzünden cevap gecikmesindense sessizce geçmek doğru.

### 1.4 Okuma

```js
// src/index.js — akışın en başında, her şeyden önce
const key = cacheKey(q);
if (plan.cache) {
  const hit = await kvGet(env, key);
  if (hit) {
    // Arama yok, model yok, doğrudan cevap
    return finish({ text: hit.text, src: "cache", cls, ms: ms(), final: true });
  }
}
```

**Neden en başta:** Cache hit varsa aşağıdaki hiçbir iş yapılmaz — ne embedding
hesaplanır, ne arama yapılır, ne model çalışır. Tek KV okuması, 20 ms.

### 1.5 Spekülatif çağrı ile birlikte

Asıl güç burada ortaya çıkıyor. Konuşmacı cümlesini bitirmeden cevap cache'e
yazılıyor:

```
t=0.3s  STT partial: "enflasyon sanırım yüz..."
        Android hedge yakalar → POST /check {spec:true}
        Worker: prewarm() → arama + model → KV'ye yaz
t=1.4s  STT final: "enflasyon sanırım yüzde 35ti"
        Android → POST /check {spec:false}
t=1.42s Worker: cacheKey aynı → HIT → 20 ms'de cevap
```

```js
// src/index.js — spekülatif çağrı cevap döndürmez, sadece cache'i doldurur
async function prewarm(env, q, context) {
  const key = cacheKey(q);
  if (await kvGet(env, key)) return;            // zaten var, boşuna çalışma
  const ev = await gatherEvidence(env, q, context, cls, plan);
  const r = await env.AI.run(MODEL, { messages: msgs(q, context, ev?.text) });
  if (confident(t)) await kvPut(env, key, { text: t, refs: ev?.refs }, plan.ttl);
}
```

Cümlenin partial ve final hali biraz farklı olabilir — o zaman hash tutmaz ve
cache hit olmaz. Ama arama sonucu Brave tarafında sıcak kaldığı için yine de
hızlanır.

---

## 2. Vectorize — yerel bilgi tabanı

### 2.1 Problem: maliyet

Brave'in ücretsiz kredisi ayda ~1000 sorgu. Hesap:

```
2 saatlik yayın × ~15 tereddüt × 2 (spekülatif dahil) = ~30 arama
ayda 100 yayın                                        = ~3000 arama
→ ücretsiz krediyi 3 katına aşıyor
```

### 2.2 Gözlem: sorular üç gruba ayrılıyor

| Grup | Örnek | Aramaya ihtiyaç var mı |
|---|---|---|
| Sabit | "Çanakkale hangi yıl" | ❌ Model zaten biliyor |
| Yarı-güncel | "enflasyon kaçtı" | ❌ **Ayda bir değişiyor, önceden yüklenebilir** |
| Gerçekten canlı | "dünkü maç" | ✅ Sadece bunlar |

Ortadaki grup sınırlı sayıda: enflasyon, asgari ücret, nüfus, faiz, işsizlik,
kur, emekli maaşı… Türkiye'de yayında en sık tereddüt edilen rakamlar ~20 kalem.

Bunları önceden yüklersen aylık arama sayısı **~3000'den ~250'ye** düşer,
ücretsiz krediye rahat sığar.

### 2.3 Neden düz bir liste değil?

Kullanıcı "enflasyon kaçtı" demeyebilir:

```
"TÜFE neydi"
"hayat pahalılığı ne oldu"
"fiyat artışı yüzde kaç"
"zamlar ne kadar oldu"
```

Kelime eşleştirme bunların hepsini kaçırır. **Embedding** anlam benzerliği
kurduğu için hepsini aynı kayda bağlar.

**Embedding nedir:** Bir metni, anlamını temsil eden sayı dizisine çeviren
model. Benzer anlamlı metinler birbirine yakın vektörler üretir.

```
"enflasyon kaçtı"     → [0.021, -0.184, 0.377, ...]  (1024 sayı)
"TÜFE oranı nedir"    → [0.019, -0.176, 0.381, ...]  ← çok yakın
"Çanakkale hangi yıl" → [0.512,  0.093, -0.244, ...] ← çok uzak
```

Yakınlık **kosinüs benzerliği** ile ölçülüyor: iki vektör arasındaki açının
kosinüsü. 1.0 = aynı yön, 0 = ilgisiz.

### 2.4 Yazma (ingest)

```js
// src/knowledge.js
const EMBED_MODEL = "@cf/baai/bge-m3";   // çok dilli, Türkçe destekli, 1024 boyut

export async function ingest(env, items) {
  // Başlığı da metne kat — "Asgari ücret" başlığı arama isabetini artırır
  const texts = items.map((x) => `${x.title}. ${x.text}`);

  // TEK çağrıda hepsini vektörleştir (batch) — 8 ayrı çağrıdan çok hızlı
  const emb = await env.AI.run(EMBED_MODEL, { text: texts });

  const vectors = items.map((x, i) => ({
    id: String(x.id),          // aynı id tekrar yazılırsa ÜZERİNE yazar (upsert)
    values: emb.data[i],       // 1024 sayılık vektör
    metadata: {
      title: String(x.title).slice(0, 200),
      text: String(x.text).slice(0, 900),    // asıl cevap metni burada
      source: String(x.source || ""),
      updated: String(x.updated),            // tazelik kontrolü için
      maxDays: Number(x.maxDays) || 45,      // bu kaydın ömrü
    },
  }));

  await env.VEC.upsert(vectors);
  return { ok: true, count: vectors.length };
}
```

**Neden `metadata.text` içinde asıl cevap duruyor:** Vectorize vektörleri
saklar ama vektörden metni geri üretemezsin — tek yönlü dönüşüm. Cevap metnini
metadata'da taşımak zorundayız.

**`upsert` ne demek:** update + insert. Aynı `id` ile tekrar yazarsan eski kayıt
güncellenir, kopya oluşmaz. Bu yüzden `ingest.sh`'i istediğin kadar
çalıştırabilirsin.

**`--dimensions=1024` neden bu sayı:** `bge-m3` modeli tam olarak 1024 sayı
üretir. Index oluştururken bu boyutu bilmek zorunda; farklı verirsen veri kabul
etmez.

### 2.5 Okuma (lookup)

```js
// src/knowledge.js
const MIN_SCORE = 0.62;   // altı güvenilmez -> web'e düş

export async function lookupLocal(env, query) {
  if (!env.VEC) return null;              // Vectorize bağlı değilse sessizce atla

  // Soruyu da AYNI modelle vektöre çevir — farklı model kullanılamaz,
  // vektör uzayları uyuşmaz
  const emb = await env.AI.run(EMBED_MODEL, { text: [query] });

  const res = await env.VEC.query(emb.data[0], {
    topK: 3,                    // en yakın 3 kayıt
    returnMetadata: "all",      // metin ve tarih de gelsin
  });

  // Eşiğin altındakileri at
  const hits = (res.matches || []).filter((m) => m.score >= MIN_SCORE);
  if (!hits.length) return null;          // yeterince yakın kayıt yok -> web

  return {
    text: hits.map((m, i) => `[${i+1}] ${m.metadata.title} — ${m.metadata.text}`).join("\n"),
    refs: hits.map((m) => ({ title: m.metadata.title, url: m.metadata.source })),
    score: hits[0].score,
    fresh: hits[0].metadata.updated,
    maxDays: Number(hits[0].metadata.maxDays) || null,
  };
}
```

**`MIN_SCORE = 0.62` neden var:** Vectorize her zaman "en yakın"ı döner —
alakasız olsa bile. "Dünkü maç kaç kaç" sorusu enflasyon kaydını 0.3 skorla
döndürebilir. Eşik olmasa modele alakasız kanıt gider ve saçma cevap üretir.

Eşiği ayarlarken:
- **Çok yüksek** (0.8+) → doğru kayıtlar kaçar, boşuna web'e gidilir
- **Çok düşük** (0.4-) → alakasız kayıt kanıt olarak gider, yanlış cevap
- 0.62 makul bir başlangıç; gerçek kullanımda loglayıp ayarla

### 2.6 Bayat veri koruması

Canlı yayında **bayat veri = yanlış cevap**. Her kayıt kendi ömrünü taşıyor:

```js
// src/knowledge.js
export function isStale(updated, maxDays) {
  if (!updated) return true;                 // tarih yoksa güvenme
  const d = Date.parse(updated);
  if (isNaN(d)) return true;                 // bozuk tarih -> güvenme
  const limit = Number(maxDays) || 45;
  return (Date.now() - d) / 86400000 > limit;
}
```

```js
// src/index.js — bayatsa kayıt KULLANILMAZ, web'e düşülür
const local = await lookupLocal(env, q);
if (local && !isStale(local.fresh, local.maxDays)) {
  evidence = local;  src = "yerel";
}
```

**Neden kayıt bazlı ömür:** Sabit tek eşik yanlış sonuç veriyordu.

| Veri | Açıklanma sıklığı | Ömür | Sabit 45 gün olsaydı |
|---|---|---|---|
| enflasyon, işsizlik | aylık | 45 | ✓ doğru |
| politika faizi | 6-8 haftada bir | 60 | ✗ boşuna bayat sayılır |
| asgari ücret | yılda 1-2 | 200 | ✗ boşuna bayat sayılır |
| **nüfus** | **yılda 1** | **400** | ✗ **her sorguda web'e giderdi** |

Bu tasarımın güzel yanı: güncellemeyi unutursan **yanlış cevap vermez**, sadece
web'e düşer — yavaşlar ve arama kotandan yer, ama doğruluk korunur.

### 2.7 Sınıfa göre kullanım

Vectorize her soruda sorgulanmıyor:

```js
// src/topic.js
case TOPIC.FRESH:
  return { ..., local: false, ... };   // dünkü maç Vectorize'da OLAMAZ
case TOPIC.SEMI:
  return { ..., local: true,  ... };   // asıl hedef bu sınıf
case TOPIC.STATIC:
  return { ..., local: true,  ... };   // varsa kullan, yoksa model
```

**FRESH'te neden kapalı:** Vectorize ayda bir güncelleniyor, dünkü haberi
içermesi imkânsız. Sorgulamak boşuna 80 ms + embedding maliyeti.

### 2.8 Seri çalışma — yerel önce

SEMI ve STATIC'te önce yerel, bulamazsa web:

```js
// src/index.js
async function gatherEvidence(env, q, context, topic, plan) {
  // ÖNCE YEREL — çok hızlı (~80ms) ve ücretsiz
  if (plan.local) {
    const local = await lookupLocal(env, q).catch(() => null);
    if (local && !isStale(local.fresh, local.maxDays)) {
      return { ...local, src: "local" };   // bulundu -> web'e HİÇ gitme
    }
  }
  // Yerelde yok veya bayat -> web
  if (plan.web) {
    const qq = addTimeContext(buildQuery(q, context), topic);
    const web = await search(env, qq).catch(() => null);
    if (web) return { ...web, src: "web" };
  }
  return null;
}
```

**Neden seri, paralel değil:**

```
Paralel:  yerel 80ms ∥ web 700ms → yerel kazanır AMA web de yapıldı (boşa ücret)
Seri:     yerel 80ms → bulundu → web HİÇ başlamadı (ücret yok)
          yerel 80ms → yok → web 700ms → toplam 780ms
```

Yerel zaten çok hızlı (80ms). Paralel yapmak sadece web'i boşuna çalıştırır.
Seri: yerel bulursa web hiç başlamaz, ne gecikme ne ücret.

> **Not:** Niyet kontrolü ile kanıt toplama HÂLÂ paralel (bkz. index.js).
> Sadece kanıt toplamanın KENDİ İÇİNDE yerel→web seri. İki farklı paralellik.

---

## 3. Katmanların birlikte çalışması

```
soru gelir
   │
   ├─ 1. cacheKey(q) → KV                     20 ms ─── hit varsa BİTTİ
   │
   ├─ 2. classify(q) → plan                    0 ms
   │
   ├─ 3. plan.local? → Vectorize              80 ms ─┐
   │     plan.web?   → Brave                 900 ms ─┴─ PARALEL, ilki kazanır
   │
   ├─ 4. model + kanıt → streaming           500 ms
   │
   └─ 5. cevabı KV'ye yaz (waitUntil)          arka planda
```

Ölçülen sonuç (tahmini, `/bench` ile doğrula):

| Durum | Süre | Maliyet |
|---|---|---|
| Cache hit | 20 ms | ücretsiz |
| Vectorize hit | 600 ms | ücretsiz |
| Model-only (STATIC) | 650 ms | ücretsiz |
| Web araması (FRESH) | 1400 ms | 1 Brave sorgusu |

---

## 4. Veri akışı: seed.json'dan cevaba

Kafa karıştıran nokta genelde bu — **hangi dosya neyi değiştiriyor**:

```
scripts/seed.json                 ← SEN bunu düzenlersin (metin dosyası)
      │
      │  ./scripts/ingest.sh scripts/seed.json
      │  (dosyayı okur, POST $WORKER/ingest gövdesine koyar — dosyayı DEĞİŞTİRMEZ)
      ▼
Worker /ingest ucu                ← INGEST_TOKEN ile korunuyor
      │
      │  ingest() → bge-m3 → 1024 boyutlu vektörler
      ▼
Vectorize index'i                 ← veri BURAYA yazılır, kalıcı
      │
      │  yayında soru gelince: lookupLocal() → en yakın kayıt
      ▼
model → cevap
```

`ingest.sh` bir taşıyıcı. JSON kaynak, Vectorize hedef. Rakam değiştiğinde:

```bash
nano scripts/seed.json                     # rakamı ve "updated" tarihini değiştir
./scripts/ingest.sh scripts/seed.json      # tekrar yükle (aynı id = üzerine yazar)
```

Kontrol:
```bash
curl -N -X POST $WORKER/check -H 'content-type: application/json' \
  -d '{"q":"asgari ücret neydi emin değilim"}'
# "src":"yerel" dönmeli
```

---

## 5. Bu katmanlar olmadan ne olur

Her ikisi de opsiyonel — bağlamazsan Worker yine çalışır:

```js
if (!env.CACHE) return null;   // KV yoksa cache atlanır
if (!env.VEC) return null;     // Vectorize yoksa yerel arama atlanır
```

| Katman | Kapalıyken |
|---|---|
| KV yok | Aynı soru her seferinde baştan işlenir. ~1200 ms yerine tekrar ~1200 ms. |
| Vectorize yok | Enflasyon/nüfus soruları web'e gider. ~80 ms yerine ~1400 ms, ayda ~3000 arama. |
| İkisi de yok | Çalışır ama yavaş ve pahalı. Ücretsiz Brave kredisi ~10 günde biter. |

---

## 6. Sınırlar

| Sınır | Detay |
|---|---|
| KV yazma gecikmesi | KV eventual consistent. Yazma tüm bölgelere yayılması ~60 sn sürebilir. Yayın içinde ilk birkaç tekrarda hit olmayabilir. |
| Vectorize boyut | Ücretsiz katmanda index sayısı ve vektör adedi sınırlı. Bizim kullanımımız (~20 kayıt) sınırın çok altında. |
| Embedding maliyeti | Her `lookupLocal` bir embedding çağrısı demek (~40 ms). FRESH'te kapatmamızın sebebi de bu. |
| Eşik ayarı | `MIN_SCORE` kör bir sayı. Gerçek kullanımda skorları loglayıp ayarlamak gerekir. |
| Türkçe embedding | `bge-m3` çok dilli ve Türkçe destekliyor ama İngilizce kadar keskin değil. Alakasız eşleşme görürsen eşiği yükselt. |


---

# Benzerlik eşiği — Türkçe için ölçümle ayarlandı

`knowledge.js` içindeki `MIN_SCORE`, bir Vectorize eşleşmesinin kullanılabilir
sayılması için gereken en düşük kosinüs benzerliğidir.

**Değer: 0.48** (başlangıçta 0.62 idi).

Neden değişti — canlı `/debug` çıktısından gelen gerçek skorlar:

| Kayıt | Skor | 0.62 ile | 0.48 ile |
|---|---|---|---|
| `tufe-gruplar` (Enflasyonun alt kalemleri) | 0.542 | ✗ elenir | ✓ geçer |
| `tufe-yillik` (Yıllık TÜFE) — **aranan kayıt** | 0.526 | ✗ elenir | ✓ geçer |
| `politika-faizi` | 0.408 | ✗ | ✗ (doğru) |
| `asgari-ucret` | 0.385 | ✗ | ✗ (doğru) |

"enflasyon kacti" sorusu ile "Yıllık tüketici enflasyonu (TÜFE)" başlığı
doğru bir eşleşme, ama 0.62 eşiğini geçemiyordu; sorgu web'e düşüyor ve
`semi` gecikmesi 2001 ms oluyordu. Eşik 0.48'e çekilince aynı sorgu
Vectorize'dan cevaplanmaya başladı ve **p95 gecikme 2001 ms → 397 ms**
oldu (5 kat).

**Neden 0.62 fazla katıydı:** `bge-m3` çok dilli bir model. Türkçe kısa soru
+ kısa başlık çiftlerinde skorlar doğal olarak 0.45-0.55 bandında oturuyor;
0.62+ skorlar İngilizce uzun metinlerde görülüyor. Eşik dile göre ayarlanmalı.

**Nasıl ayarlanır:** `/debug?q=...` çıktısındaki `similarityScore`
değerlerine bak. Doğru eşleşmeler ile alakasızlar arasında net bir boşluk
varsa eşiği o boşluğa koy. Yukarıdaki örnekte doğrular 0.52-0.54,
alakasızlar 0.38-0.41 — 0.48 tam ortada.
