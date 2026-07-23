# Tetikleme Mantığı

Bu ürünün kalbi tek bir soru: **konuşmacı benden bir şey istiyor mu?**

Yanlış cevap vermek kadar, istenmediği halde araya girmek de hatadır. Canlı
yayında sunucunun ekranında beklemediği bir metin belirmesi dikkat dağıtır —
ürünü kullanılmaz yapar.

---

# 1. İki bağımsız soru

Bu mimarinin temel kararı: iki farklı şeyi ayrı ayrı çözmek.

```
KONU  (nesnel)  : Bu cümlede geçen bilgi hangi türden?
NİYET (öznel)   : Konuşmacı bu bilgiyi benden istiyor mu?
```

| | Kim karar verir | Süre | Neden |
|---|---|---|---|
| **KONU** | regex, `topic.js` | ~0 ms | Cümlede "dün" geçiyorsa konu günceldir. Bu olgusal, tartışmaya kapalı. |
| **NİYET** | model, `intent.js` | ~200 ms | Bağlama, hitaba, tona bağlı. Kelime listesiyle çözülemez. |

## Neden ayrıldı

Önceki tasarımda ikisi tek fonksiyondaydı ve şu hataya yol açıyordu:

```
"dünkü maç ne olmuş acaba"     -> fresh + istek     ✓ doğru
"dünkü maçı sonra konuşuruz"   -> fresh + istek DEĞİL, ama tetikliyordu ✗
```

İkisinde de "dün" ve "maç" var. **Zaman ifadesi konuyu belirler, niyeti
belirlemez.** Karıştırınca ikincisi de web araması tetikliyordu.

## Neden niyet için liste tutulmuyor

Denendi. Liste 40 maddeye çıktı ve hâlâ yanlış sonuç veriyordu:

```
"asgari ücret ne oldu bilmiyorum"       -> istek DEĞİL, bilmediğini söylüyor
"arkadaşlar asgari ücret ne oldu"       -> istek, hitap var
"Veysel asgari ücret ne oldu"           -> istek, hitap var
"bu bilmem kimin olayı en son ne oldu"  -> istek, dolaylı ama cevap arıyor
"sonucu ne oldu göreceğiz"              -> istek DEĞİL, bakıp görecek
```

Beşinde de neredeyse aynı kelimeler var. Ayıran şey hitap, yönlendirme ve
cümlenin nereye bağlandığı. Bu liste asla tamamlanmaz; bakım yükü sonsuza
gider ve doğruluk yine de açık kalır.

**Karar:** niyet modele bırakıldı. Sonuç: `lexicon.js` %60 küçüldü, bakım
yükü kalktı, doğruluk arttı.

---

# 2. Gecikme nasıl sıfırlandı

Niyet kontrolünü her tetiklemede çalıştırmak +200 ms demek. Ama **kanıt
toplamayla paralel** koşarsa gecikme görünmez:

```
┌─ niyet kontrolü ────────── 200 ms ──┐
├─ kanıt toplama ─────────── 80-900 ms ┤──> birleş
└─ (paralel)                           ┘
```

| Konu | Kanıt toplama | Niyet | Paralel toplam |
|---|---|---|---|
| static | model 500-700 ms | 200 ms | **700 ms** (değişmedi) |
| semi | vectorize 80 + model 500 | 200 ms | **580 ms** (değişmedi) |
| fresh | web 700 + model 500 | 200 ms | **1200 ms** (değişmedi) |

Niyet kontrolü her durumda kanıt toplamadan kısa. Ek gecikme yok.

## Taslak kapısı — ekrana sızma koruması

Model cevabı token token akıtılıyor (ilk kelime ~350 ms'de). Ama niyet cevabı
~200 ms'de geliyor. Sıra önemli:

```
t=0      niyet ve model aynı anda başlar
t=200ms  niyet cevabı gelir      -> kapı açılır veya kapanır
t=350ms  modelin ilk tokenı gelir -> kapı açıksa gösterilir
```

Niyet zaten önce döndüğü için taslak beklemez. Ama garanti olsun diye
tokenlar **niyet onaylanmadan ekrana gönderilmez** — biriktirilir, onay
gelince salınır, "hayır" gelirse sessizce atılır.

Bu olmadan niyet "hayır" dese bile ekranda bir an metin görünürdü — tam
kaçınmaya çalıştığımız şey.

## Bedeli

Niyet "hayır" derse yapılmış arama çöpe gider — para kaybı, ama kullanıcı
hiçbir gecikme görmez.

İki mod var:

| Mod | `INTENT_BEFORE_SEARCH` | Gecikme | Maliyet |
|---|---|---|---|
| **Paralel** (varsayılan) | `false` | değişmez | boşa arama olabilir |
| Seri | `true` | +200 ms | boşa arama yok |

Cihazdaki tereddüt kapısı zaten çoğunu eliyor; kalan israf ücretsiz kotaya
sığıyor. Arama kotan sıkışırsa seri moda geç.

---

# 2b. Kapı neden genişletildi — tereddüt tek başına yetmiyor

İlk tasarımda cihaz kapısı SADECE tereddüt arıyordu ("sanırım", "emin
değilim", "galiba"). Gerçek kullanımda bunun büyük bir açık olduğu görüldü:

> "türkiyenin bir sonraki seçimi ne zaman"
> "çanakkale boğazı ne zaman kuruldu"
> "dün Fener'in maçı var mı"

Bu cümlelerin hiçbirinde tereddüt sözcüğü yok — ama üçü de apaçık bilgi
isteği. Uygulama hepsinde susuyordu.

**Doğru zihinsel model:** MAI kulaklıktaki yapımcıdır. Yapımcı üç şey yapar:
doğrudan soruya cevap verir, sunucu tereddüt edince kendiliğinden düzeltir,
laf kalabalığında susar. Sadece tereddüt dinleyen bir yapımcı yarım
yapımcıdır.

Bu yüzden kapı artık **tereddüt VEYA doğrudan soru** ile açılıyor.

## Soru nasıl tanınıyor — liste değil, dilbilgisi deseni

Soru kalıplarını liste olarak tutmak bitmez: "ne açıklandı", "ne duyuruldu",
"ne söylendi", "ne oldu"... sonsuz varyasyon. Bunun yerine Türkçenin soru
kurma kuralı desene çevrildi:

```
1) Soru eki        : mı | mi | mu | mü | musun | mıydı ...
                     "açıklandı MI", "biliyor MUSUN"

2) Soru sözcüğü + çekimli fiil:
   (ne|kim|kaç|hangi|nerede|nasıl|niye|neden) + kelime + (dı|di|mış|yor|...)
                     "NE açıklanDI", "KİM duyurDU", "NE deDİ"

3) Belirgin soru öbekleri : "ne zaman", "ne kadar", "kaç kişi"
```

İkinci desendeki **çekimli fiil eki zorunluluğu** ünlem kalıplarını ayırır:

| Cümle | Eşleşir mi | Neden |
|---|---|---|
| "ne açıklandı" | ✓ | açıklan + **dı** |
| "kim duyurdu" | ✓ | duyur + **du** |
| "ne güzel" | ✗ | "güzel" fiil eki taşımıyor |
| "ne yazık ki" | ✗ | "yazık" fiil eki taşımıyor |

> **Unicode tuzağı:** Desenlerde `\b` KULLANILMAZ. JavaScript'te (ve
> Kotlin'de) `\b` ASCII tabanlıdır; "açıklandı mı" içindeki "mı" sonundaki
> "ı" ASCII olmadığı için sınır tutmaz ve desen kaçırır. Bunun yerine
> `(?<!\p{L})` / `(?!\p{L})` Unicode ileri-geri bakışları kullanılır.
> Aynı tuzak `-caktı` ekinde de yaşandı.

## Desen kusursuz değil — ve olması gerekmiyor

Ölçülen sınırlar:

| Cümle | Desen | Olması gereken |
|---|---|---|
| "ne güzeldi o günler" | geçer | ünlem — kaçırıyor |
| "ne oldu sana böyle" | geçer | endişe — kaçırıyor |
| "ne yaptın sen böyle" | sessiz | ✓ doğru |
| "kim bilir neler oldu" | sessiz | ✓ doğru |

Bu tolere edilebilir çünkü desen **kesin karar vermiyor, sadece kapıyı
açıyor.** Kaçanları sunucudaki niyet modeli eliyor. Mimarinin temel iş
bölümü: ucuz regex geniş ağ atar, pahalı model süzer.

## Bedeli ölçüldü

Gerçekçi TV cümleleriyle: 9 cümlenin 7'si modele gidiyor (önce çoğu kapıda
kalıyordu). Yani eleme yükü tamamen niyet modelinde. Maliyet açısından sorun
yok — ölçülen kullanım ücretsiz kotanın %3'üydü, üç katına çıksa bile %9.
Asıl risk ekran gürültüsü; onu niyet modelinin doğruluğu belirliyor.

---

# 3. Üç aşamalı karar

```
┌─────────────────────────────────────────────────────────────┐
│ AŞAMA 1 — CİHAZDA (Android, ~0 ms, ağ turu yok)             │
│   konuyu kapatıyor mu? ("neyse")   -> ise DUR               │
│   görüş bildirimi mi? ("bence")    -> ise DUR               │
│   gelecek zaman eki var mı?        -> varsa DUR             │
│     AMA takvim işareti de varsa    -> DURMA (tarih sorusu)  │
│                                                             │
│   KAPI — ikisinden BİRİ yeterli:                            │
│     a) tereddüt var mı? ("sanırım", "emin değilim")         │
│     b) doğrudan soru mu? ("maçın sonucu ne oldu")           │
│   ikisi de yoksa -> DUR                                     │
│                                                             │
│   sadece (a) geldiyse: doğrulanabilir içerik de ara         │
│   (b) geldiyse: soru zaten güçlü sinyal, ek şart yok        │
└────────────────────────┬────────────────────────────────────┘
                         │ geçenler Worker'a gider
┌────────────────────────▼────────────────────────────────────┐
│ AŞAMA 2 — WORKER, REGEX (~0 ms)                             │
│   KONU  : fresh | semi | static     (classifyTopic)         │
│   NİYET : sadece KESİN elemeler     (precheckIntent)        │
│           skip -> dur | ask -> aşama 3                       │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────┐
│ AŞAMA 3 — PARALEL                                           │
│   ┌─ NİYET: model kararı           ~200 ms ─┐               │
│   ├─ KANIT: vectorize / web        80-900ms ┤──> birleş     │
│   └─ (aynı anda başlar)                     ┘               │
│                                                             │
│   niyet hayır -> sessizce dön, ekrana bir şey basma         │
│   niyet evet  -> kanıtla cevap üret                         │
└─────────────────────────────────────────────────────────────┘
```

**İlke:** ucuz kontroller önce, pahalı olan sonra ve paralel.

---

# 4. Regex neyi kesin bilir

`precheckIntent()` sadece şu testi geçen kalıpları eler:

> "Bu kalıp geçen bir cümle, HİÇBİR bağlamda bilgi isteği olabilir mi?"
> Cevap kesin HAYIR ise elenir. En ufak şüphe varsa modele gider.

| Kontrol | Yakaladığı | Neden kesin |
|---|---|---|
| `HEDGE_IGNORE` | "neyse", "boş ver" | Konuşmacı konuyu kapatıyor |
| `HARD_SKIP` | "bence", "sence", "sizce ne olur" | Görüş bildirimi/isteme |
| `FUTURE_TENSE` | `-acak` / `-ecek` eki | Olmamış bir şey doğrulanamaz |

`FUTURE_TENSE` en verimli kontrol: tek dilbilgisi deseni yüzlerce fiili
kapsıyor, liste tutmaya gerek yok.

```
"grev ne zaman bitECEK"      -> elenir
"zam gelECEK mi"             -> elenir
"hep birlikte görECEĞiz"     -> elenir
"grev bitTİ mi"              -> elenmez, modele gider
```

## Neyi bilemez

Bunların hepsi modele gider:

```
"göreceğiz"     -> genelde retorik AMA "bakalım, Veysel bir baksın" olabilir
"bilmiyorum"    -> "asgari ücret ne oldu bilmiyorum" istek olabilir
"ne oldu"       -> hitap varsa istek, yoksa değil
"bunun / o işin"-> bağlam olmadan anlaşılmaz
```

Bunları listeye eklemek denendi ve yanlış sonuç verdi.

---

# 5. Model niyeti nasıl değerlendiriyor

`intent.js` modele tek soru sorar, tek kelime cevap alır (`EVET`/`HAYIR`).

**EVET olanlar:**
- Doğrudan soru soruyor
- Birine hitap ederek soruyor ("Veysel...", "arkadaşlar...")
- Dolaylı da olsa cevap arıyor
- Söylediği rakamdan emin değil, doğrulanmasını istiyor

**HAYIR olanlar:**
- Yorum yapıyor, görüş belirtiyor
- Tahmin yürütüyor
- "Bilmiyorum" diyerek konuyu bırakıyor
- Sohbeti kapatıyor ("bakalım", "göreceğiz")
- Sadece düşünüyor

Bağlam (`ctx`, önceki 1-2 cümle) de gönderilir — niyet çoğu zaman oradan
anlaşılır.

**Hata durumunda:** `wantsInfo: true` döner. Güvenli taraf: gereksiz cevap
vermek, gerçek soruyu kaçırmaktan iyidir.

---

# 6. Konu sınıflandırma

`classifyTopic()` sadece bilginin türünü belirler. Niyetten bağımsız.

| Konu | Sinyal | cache | yerel | web | model | TTL |
|---|---|:---:|:---:|:---:|:---:|---|
| **FRESH** | dün, bu sabah, maç, deprem, seçim sonuç | ✓ | ✗ | **✓ zorunlu** | **✗** | 15 dk |
| **SEMI** | enflasyon, asgari ücret, nüfus, faiz | ✓ | ✓ | ✓ | ✗ | 6 sa |
| **STATIC** | (diğer hepsi) | ✓ | ✓ | ✗ | ✓ | 7 gün |

**Neden bu kararlar:**

- **FRESH'te `model: ✗`** — En kritik satır. Model dünkü maçı bilemez ama
  sorulursa eğitim verisindeki bir maçı güvenle söyler. Canlı yayında bu
  felakettir. Kanıt yoksa "EMİN DEĞİLİM" der.
- **FRESH'te `yerel: ✗`** — Vectorize ayda bir güncelleniyor, dünkü haberi
  içeremez. Sorgulamak boşuna 80 ms.
- **STATIC'te `web: ✗`** — Model zaten biliyor. Web'e gitmek 900 ms + ücret,
  sıfır fayda.
- **TTL farkları** — Çanakkale'nin yılı değişmez (7 gün), "az önce ne oldu"
  hızla eskir (15 dk).

## Zaman bağlamı enjeksiyonu

Taze konularda arama sorgusuna otomatik tarih eklenir:

```
"dünkü maç ne olmuş"  →  buildQuery      →  "maç olmuş"
                      →  addTimeContext  →  "maç olmuş 21 Temmuz 2026"
```

Bu olmadan arama motoru geçen ayın maçını getirebilir — "dün" kelimesini
mutlak tarihe çeviremez.

---

# 7. Zıt çiftler

Kelimeler neredeyse aynı, sonuç zıt:

| ❌ Tetiklemez | ✓ Tetikler | Ayıran |
|---|---|---|
| "sonucu **ne olacak**" | "sonucu **ne oldu**" | fiil zamanı (regex) |
| "grev ne zaman **bitecek**" | "grev **bitti mi**" | fiil zamanı (regex) |
| "hep birlikte **göreceğiz**" | "**Veysel**, ne oldu" | fiil zamanı / hitap |
| "**bence** enflasyon yüksek" | "enflasyon **kaçtı**" | görüş bildirimi (regex) |
| "asgari ücret ne oldu **bilmiyorum**" | "**arkadaşlar** asgari ücret ne oldu" | hitap (model) |
| "dünkü maçı **sonra konuşuruz**" | "dünkü maç **ne olmuş acaba**" | niyet (model) |

Son iki satır regex'in çözemediği, modelin çözdüğü durumlar.

Bu çiftler `worker/test/topic.test.mjs` içinde test olarak duruyor.

---

# 8. Yanlış tetiklemenin maliyeti

| Maliyet | Etki |
|---|---|
| Arama ücreti | Her gereksiz tetikleme 1 sorgu. Ücretsiz kota erken biter. |
| Gecikme | Kullanıcıya yansımaz (paralel mimari sayesinde). |
| **Ekran gürültüsü** | **En kötüsü.** Sunucu bir şey sormamışken metin belirmesi dikkatini dağıtır. Birkaç kez olursa ürünü kapatır. |

Tasarım bu yüzden temkinli: emin olamadığımızda susmayı tercih ediyoruz.

**Ama ters yönde de dikkat:** yanlış eleme, gereksiz tetiklemeden kötüdür —
sunucu gerçekten yardım isterken sessiz kalırsın. Bu yüzden regex sadece
%100 emin olduğu kalıpları eler, gerisini modele bırakır.

---

# 9. Ayarlama

## Model çok sık çağrılıyorsa

```bash
curl -X POST $WORKER/classify -H 'content-type: application/json' \
  -d '{"texts":["...gerçek yayından cümleler..."]}'
```

`modelCheckedCount / questionsAnalyzed` oranına bak. Yüksekse (>%80)
`HARD_SKIP` listesine kesin kalıplar eklenebilir — ama sadece hiçbir bağlamda
istek olamayacaklar.

## Model yanlış karar veriyorsa

```bash
curl "$WORKER/debug?q=CÜMLE" | python3 -m json.tool
```

`intent.rawResponse` modelin ham cevabını gösterir. Sistematik hata görürsen
`intent.js` içindeki örnek listesine o vakayı ekle.

## Hiç tetiklenmiyorsa

1. Ayarlar ekranında **sözlük sürümü**ne bak — `0` ise liste inmemiş
2. `curl $WORKER/lexicon` ile listenin geldiğini doğrula
3. Kullandığın tereddüt kalıbı `HEDGE` listesinde var mı kontrol et

## Arama kotası bitiyorsa

```toml
# wrangler.toml
INTENT_BEFORE_SEARCH = "true"   # +200 ms, boşa arama yok
```

---

# 10. Bilinen sınırlar

| Sınır | Detay |
|---|---|
| Alaycı/ironik ifadeler | "Tabii ki biliyorum, yüzde 200'dü" — model ironiyi anlamayabilir |
| Uzun bağlamlı niyet | Üç cümle önce sorulan soru `ctx` penceresine (~220 karakter) sığmayabilir |
| Bölünmüş cümleler | STT cümleyi ortadan keserse niyet eksik kalır |
| Konuk konuşması | Mikrofon herkesi duyar; sunucunun tereddüdü ile konuğunki ayrılmıyor |
| Model tutarsızlığı | Aynı cümle nadiren farklı sonuç verebilir (`temperature: 0` bunu en aza indiriyor) |
| Boşa arama | Paralel modda niyet "hayır" derse arama ücreti ödenmiş olur |
