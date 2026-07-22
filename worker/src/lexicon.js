/**
 * SÖZLÜK — tüm kelime listelerinin TEK kaynağı.
 *
 * Buradan yönetilir:
 *   - router.js       sınıflandırma için okur
 *   - GET /lexicon    Android uygulaması açılışta çeker
 *
 * Android uygulaması bu listeyi Worker'dan indirdiği için, kelime eklemek
 * için APK yeniden derlemeye GEREK YOK. Deploy et, uygulama bir sonraki
 * açılışta yeni listeyi alır. VERSION'u artırmayı unutma.
 */

export const VERSION = 3;

/* ================================================================== */
/* 1. TEREDDÜT (HEDGE) — uygulamanın tetiklenme koşulu                 */
/* ================================================================== */

/**
 * Yayıncıların gerçekte kullandığı ifadeler. Kategorilere ayrıldı ki
 * hangisinin çok/az tetiklediğini logdan görüp ayarlayabilesin.
 */
export const HEDGE = {
  // Klasik belirsizlik
  belirsizlik: [
    "sanırım", "sanıyorum", "galiba", "zannedersem", "zannediyorum",
    "herhalde", "yanılmıyorsam", "yanlış hatırlamıyorsam", "yanlış bilmiyorsam",
    "emin değilim", "emin olamadım", "tam emin değilim", "kesin değil",
    "büyük ihtimalle", "muhtemelen öyle",
  ],

  // Hafıza / hatırlama — yayıncılarda çok sık
  hafiza: [
    "hatırladığım kadarıyla", "aklımda kaldığı kadarıyla", "tam hatırlamıyorum",
    "şimdi hatırlayamadım", "aklıma gelmiyor", "dilimin ucunda",
    "hafızam beni yanıltmıyorsa", "unuttum şimdi", "ismini unuttum",
    "adı neydi", "aklımdan çıktı",
  ],

  // Doğrudan soru kalıpları
  soru: [
    "neydi", "kaçtı", "ne kadardı", "kaç yılında", "hangi yıldı",
    "ne zamandı", "kim demişti", "kim söylemişti", "nerede olmuştu",
    "kaç kişiydi", "ne oranda", "yüzde kaç",
  ],

  // Onay arama — "değil mi" tipi
  onay: [
    "değil miydi", "öyle miydi", "doğru mu", "yanlış mıyım",
    "doğru mu söylüyorum", "yanlış mı biliyorum", "öyle değil mi",
    "yanılıyor muyum", "bir yanlışım var mı",
  ],

  // Yayıncıya özgü — teyit isteme, düzeltme çağrısı
  yayinci: [
    "teyit edelim", "kontrol edelim", "bir bakalım", "araştıralım",
    "not düşelim", "düzeltme yapayım", "izleyicilerimiz düzeltsin",
    "bir saniye", "dur bakalım", "şöyle diyeyim", "diye biliyorum",
    "gibi bir şeydi", "gibi hatırlıyorum", "öyle bir rakam",
  ],
};

/** Tereddüt olsa da tetiklememesi gerekenler. */
export const HEDGE_IGNORE = [
  "sanırım öyle", "bilmiyorum ki", "her neyse", "neyse",
  "bilmiyorum artık", "emin değilim ama olsun", "neyse boş ver",
  "doğru mu ya", "hadi canım",
];

/** Düz liste (router ve Android bunu kullanır). */
export const HEDGE_ALL = Object.values(HEDGE).flat();

/* ================================================================== */
/* 2. ZAMAN — tazelik tespiti                                          */
/* ================================================================== */

/**
 * GEÇMİŞ zaman ifadeleri -> doğrulanabilir, web'e gidilir.
 * Yakından uzağa sıralı; ilk eşleşen kazanır (addTimeContext için önemli).
 */
export const TIME_PAST = [
  // Bugün içi
  { k: "az önce", gun: 0 }, { k: "biraz önce", gun: 0 }, { k: "az evvel", gun: 0 },
  { k: "demin", gun: 0 }, { k: "birazdan önce", gun: 0 },
  { k: "bu sabah", gun: 0 }, { k: "bu öğlen", gun: 0 }, { k: "bu akşam", gun: 0 },
  { k: "bugün", gun: 0 }, { k: "bugünkü", gun: 0 }, { k: "son dakika", gun: 0 },
  { k: "şu an", gun: 0 }, { k: "şimdi", gun: 0 },

  // Dün
  { k: "dün akşam", gun: 1 }, { k: "dün gece", gun: 1 }, { k: "dün sabah", gun: 1 },
  { k: "dün öğlen", gun: 1 }, { k: "dünkü", gun: 1 }, { k: "dün", gun: 1 },
  { k: "geçen gece", gun: 1 },

  // Birkaç gün
  { k: "evvelsi gün", gun: 2 }, { k: "önceki gün", gun: 2 },
  { k: "geçen gün", gun: 3 }, { k: "hafta sonu", gun: 3 },
  { k: "geçenlerde", gun: 5 }, { k: "yakın zamanda", gun: 7 },

  // Hafta / ay / yıl
  { k: "bu hafta", gun: 3 }, { k: "geçen hafta", gun: 7 },
  { k: "geçtiğimiz hafta", gun: 7 }, { k: "bu ay", gun: 15 },
  { k: "geçen ay", gun: 30 }, { k: "geçtiğimiz ay", gun: 30 },
  { k: "son günlerde", gun: 5 }, { k: "son haftalarda", gun: 14 },
];

/**
 * GELECEK zaman -> henüz OLMAMIŞ. İki alt durum var:
 *   - Program/takvim sorusu ("yarın maç saat kaçta") -> doğrulanabilir, web
 *   - Tahmin sorusu ("yarın ne olacak", "kazanır mı") -> doğrulanamaz, SUS
 */
export const TIME_FUTURE = [
  "yarın", "yarınki", "öbür gün", "haftaya", "gelecek hafta",
  "önümüzdeki hafta", "gelecek ay", "önümüzdeki ay", "seneye",
  "gelecek sene", "az sonra", "birazdan", "akşama",
];

/** Gelecek + bu kalıplar = TAHMİN -> doğrulanamaz, susulmalı. */
export const PREDICTION = [
  "ne olacak", "ne olur", "kazanır mı", "kaybeder mi", "çıkar mı",
  "olur mu acaba", "yapar mı", "gelir mi", "düşer mi", "artar mı",
  "beklentiniz", "tahmininiz", "sizce ne olur", "nasıl biter",
  // "kim kazanır" gibi sonuç tahmini kalıpları
  "kim kazanır", "kim kaybeder", "kim çıkar", "kim olur",
  "ne çıkar", "kaç olur", "ne kadar olur", "kaça çıkar",
  "kaç yapar", "nasıl sonuçlanır", "kim şampiyon olur",
];

/** Dönem ifadeleri — taze DEĞİL, tarihsel bağlam. */
export const ERA = [
  "pandemi döneminde", "pandemide", "kovid döneminde", "darbe döneminde",
  "seçim öncesinde", "o dönemde", "o yıllarda", "eskiden", "geçmişte",
  "90'larda", "80'lerde", "2000'lerde", "çocukluğumda", "eski zamanlarda",
];

/* ================================================================== */
/* 3. OLAY TÜRLERİ — tazelik sinyali                                   */
/* ================================================================== */

/** Doğası gereği güncel olan olaylar -> doğrudan web. */
export const FRESH_EVENT = [
  // Spor
  "maç", "skor", "kaç kaç", "gol", "derbi", "kazandı", "kaybetti",
  "berabere", "puan durumu", "şampiyon oldu", "kupa", "transfer",
  "sakatlandı", "kırmızı kart", "penaltı",

  // Siyaset / kamu
  "miting", "açıklama yaptı", "istifa", "atandı", "görevden alındı",
  "kabine", "zirve", "ateşkes", "operasyon", "seçim sonuc", "sandık",
  "oy oranı", "koalisyon", "güvenoyu",

  // Ekonomi olayı (gösterge değil, OLAY)
  "zam geldi", "indirim geldi", "faiz kararı", "borsa çakıldı",
  "borsa yükseldi", "iflas etti", "halka arz",

  // Afet / adli
  "deprem", "sel", "yangın", "kaza", "patlama", "çöktü",
  "gözaltına alındı", "tutuklandı", "serbest bırakıldı", "dava açıldı",

  // Kültür / medya
  "konser", "festival", "vizyona girdi", "ödül aldı", "vefat etti",
  "hayatını kaybetti", "açıldı", "kapandı",

  // Genel
  "karar aldı", "toplantı", "duruşma", "yeni açıklandı", "duyuruldu",
];

/* ================================================================== */
/* 4. YARI-GÜNCEL GÖSTERGELER — Vectorize'da tutulabilir               */
/* ================================================================== */

export const SEMI_INDICATOR = [
  // Enflasyon / fiyat
  "enflasyon", "tüfe", "üfe", "yıllık enflasyon", "aylık enflasyon",
  "sepet", "açlık sınırı", "yoksulluk sınırı",

  // Ücret / gelir
  "asgari ücret", "emekli maaşı", "memur zammı", "memur maaşı",
  "kıdem tazminatı", "işsizlik maaşı", "kira artış",

  // Makro
  "nüfus", "işsizlik", "istihdam", "büyüme oranı", "gsyh",
  "bütçe açığı", "cari açık", "dış ticaret", "ihracat rakam",
  "rezerv", "borç stoku",

  // Para / faiz
  "politika faizi", "faiz oranı", "merkez bankası", "mevduat faizi",
  "kredi faizi",

  // Kur / emtia
  "dolar kuru", "euro kuru", "sterlin kuru", "altın fiyat", "gram altın",
  "çeyrek altın", "petrol fiyat", "brent", "doğalgaz fiyat",

  // Vergi / harç
  "kdv oranı", "ötv", "vergi dilimi", "harç", "mtv",
];

/* ================================================================== */
/* 5. ÖZNEL — doğrulanamaz                                             */
/* ================================================================== */

export const SUBJECTIVE = [
  "bence", "sence", "bana kalırsa", "bana göre", "kanaatimce",
  "daha iyi", "daha güzel", "daha kötü", "en iyisi", "en güzeli",
  "sevdim", "beğendim", "hoşuma", "bayıldım", "nefret",
  "kötü müydü", "iyi miydi", "güzel değil miydi", "sıkıcı",
  "haklı mıyım", "katılıyor musunuz",
];

/* ================================================================== */
/* 6. DURUM DEĞİŞİKLİĞİ — regex kararsız, triyaja gider                */
/* ================================================================== */

/** Bir şeyin durumunun değişip değişmediği soruluyor. */
export const EVENT_VERB = [
  "bitti", "bitmiş", "bitecek", "bitmedi",
  "başladı", "başlamış", "başlayacak", "başlamadı",
  "açıldı", "kapandı", "kapatıldı", "iptal", "ertelendi",
  "onaylandı", "reddedildi", "imzalandı", "yürürlüğe",
  "kaldırıldı", "getirildi", "durduruldu", "çıktı mı", "çıkmış",
  "geçti mi", "kabul edildi", "yasaklandı", "serbest bırakıldı",
  "sürüyor", "devam ediyor", "sonuçlandı", "karara bağlandı",
  "tamamlandı", "yayınlandı", "uygulanıyor",
  "anlaştı", "uzlaştı", "asıldı", "asılmış", "toplandı", "dağıldı",
  // kurum/kişi bildirimi — genelde güncel, ama tarihsel de olabilir
  "açıkladı", "duyurdu", "paylaştı", "bildirdi", "ilan etti", "sundu",
];

/** Olay bildiren isimler. */
export const EVENT_NOUN = [
  "grev", "zam", "indirim", "kanun", "yasa", "tasarı", "yönetmelik",
  "seçim", "referandum", "dava", "duruşma", "karar", "hüküm",
  "anlaşma", "protokol", "sözleşme", "protesto", "boykot", "eylem",
  "ihale", "atama", "istifa", "kabine", "zirve", "müzakere",
  "soruşturma", "ceza", "af", "imar", "proje", "inşaat", "ruhsat",
  "kampanya", "başvuru", "sınav", "kura", "denetim",
];

/* ================================================================== */

/* ================================================================== */
/* EŞLEŞTİRME YARDIMCILARI                                             */
/* ================================================================== */

/**
 * Türkçe eklemeli bir dil olduğu için düz substring araması hatalı sonuç verir:
 *
 *     "ne ZAMan ilan edildi"  içinde "zam"   var  -> yanlış eşleşme ❌
 *     "AFiş asıldı"           içinde "af"    var  -> yanlış eşleşme ❌
 *     "zamLAR geldi"                          -> doğru eşleşme olmalı ✓
 *
 * Çözüm: kelimeyi token'lara böl, token kelimeyle BAŞLIYORSA kalan kısmın
 * geçerli bir Türkçe ek olup olmadığına bak.
 *
 *     "zaman" -> "zam" + "an"   -> "an" ek değil  -> eşleşme YOK  ✓
 *     "zamlar"-> "zam" + "lar"  -> "lar" ek       -> eşleşme VAR  ✓
 */
const SUFFIX = new Set([
  "",
  // çoğul
  "lar", "ler", "ları", "leri", "larda", "lerde", "lardan", "lerden",
  // hal ekleri
  "ı", "i", "u", "ü", "yı", "yi", "yu", "yü",
  "a", "e", "ya", "ye", "na", "ne",
  "da", "de", "ta", "te", "nda", "nde",
  "dan", "den", "tan", "ten", "ndan", "nden",
  "ın", "in", "un", "ün", "nın", "nin", "nun", "nün",
  "la", "le", "yla", "yle",
  // iyelik
  "sı", "si", "su", "sü", "m", "n", "mız", "miz", "nız", "niz",
  // soru
  "mı", "mi", "mu", "mü",
  // sık birleşimler
  "ları", "leri", "larını", "lerini", "ması", "mesi",
]);

/** Tek kelimelik terim için ek-duyarlı eşleşme. */
function matchWord(tokens, word) {
  for (const tok of tokens) {
    if (!tok.startsWith(word)) continue;
    if (SUFFIX.has(tok.slice(word.length))) return true;
  }
  return false;
}

/**
 * Bir metinde liste elemanlarından biri geçiyor mu?
 *  - Çok kelimeli ifadeler ("emin değilim") -> düz substring
 *  - Tek kelimeler ("zam")                  -> ek-duyarlı eşleşme
 */
export function matchAny(text, list) {
  const t = (text || "").toLowerCase();
  const tokens = t.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

  for (const w of list) {
    // Boşluk, kesme işareti veya rakam içeren terimler ("90'larda",
    // "emin değilim") token'a bölünemez -> düz substring.
    if (/[^\p{L}]/u.test(w)) {
      if (t.includes(w)) return true;
    } else if (matchWord(tokens, w)) {
      return true;
    }
  }
  return false;
}

/** Android uygulamasına gönderilecek paket. */
export function lexiconPayload() {
  return {
    version: VERSION,
    hedge: HEDGE_ALL,
    hedge_ignore: HEDGE_IGNORE,
    subjective: SUBJECTIVE,
    // Cihazda "doğrulanabilir bir şey var mı" kontrolü için ipuçları
    checkable_hint: [
      ...SEMI_INDICATOR.slice(0, 40),
      ...FRESH_EVENT.slice(0, 40),
      ...EVENT_NOUN.slice(0, 30),
    ],
  };
}
