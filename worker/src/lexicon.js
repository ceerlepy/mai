/**
 * SÖZLÜK — sadece NESNEL sinyaller.
 *
 * TASARIM İLKESİ
 * Bu dosyada yalnızca cümle hakkında **olgusal** olan şeyler durur:
 * hangi zaman ifadesi geçiyor, hangi konu adı geçiyor, fiil hangi kipte.
 * Bunlar tartışmaya açık değildir ve liste büyümez.
 *
 * NİYET BURADA DEĞİL
 * "Konuşmacı bilgi istiyor mu?" sorusu bağlama bağlıdır ve liste ile
 * çözülemez. Denedik; liste sürekli büyüdü, yine de açık kaldı:
 *
 *   "asgari ücret ne oldu bilmiyorum"      -> istek değil
 *   "arkadaşlar asgari ücret ne oldu"      -> istek
 *   "bu bilmem kimin olayı en son ne oldu" -> istek (dolaylı)
 *
 * Üçünde de aynı kelimeler var; ayıran şey yönlendirme ve ton.
 * Bu karar intent.js'te modele bırakıldı. Sonuç: bu dosya %60 küçüldü,
 * bakım yükü kalktı, doğruluk arttı.
 *
 * Buraya yeni bir liste eklemeden önce sor: bu nesnel bir olgu mu, yoksa
 * niyet tahmini mi? İkincisiyse modele ait.
 */

export const VERSION = 7;

/* ================================================================== */
/* 1. TEREDDÜT — uygulamanın tetiklenme kapısı                         */
/* ================================================================== */

/**
 * Cihazda çalışır. Bunlardan biri geçmiyorsa hiçbir şey olmaz.
 *
 * NESNEL Mİ? Evet — bunlar konuşma dilinde belirsizlik bildiren kalıplar,
 * niyet tahmini değil. Konuşmacı "sanırım" diyorsa emin değildir, nokta.
 * Bilgi isteyip istemediği ayrı soru (intent.js).
 */
export const HEDGE = [
  // belirsizlik
  "sanırım", "sanıyorum", "galiba", "zannedersem", "zannediyorum",
  "herhalde", "yanılmıyorsam", "yanlış hatırlamıyorsam", "yanlış bilmiyorsam",
  "emin değilim", "emin olamadım", "tam emin değilim", "kesin değil",
  // hafıza
  "hatırladığım kadarıyla", "aklımda kaldığı kadarıyla", "tam hatırlamıyorum",
  "şimdi hatırlayamadım", "aklıma gelmiyor", "dilimin ucunda",
  "hafızam beni yanıltmıyorsa", "ismini unuttum", "aklımdan çıktı",
  // soru kalıpları
  "neydi", "kaçtı", "ne kadardı", "kaç yılında", "hangi yıldı",
  "ne zamandı", "kim demişti", "kim söylemişti", "ne oldu", "ne olmuş",
  "kaç kişiydi", "yüzde kaç", "ne kadar",
  // onay arama
  "değil miydi", "öyle miydi", "doğru mu", "yanlış mıyım",
  "doğru mu söylüyorum", "yanılıyor muyum", "öyle değil mi",
  // yayıncı refleksleri
  "teyit edelim", "kontrol edelim", "bir bakalım", "araştıralım",
  "diye biliyorum", "gibi bir şeydi", "gibi hatırlıyorum",
];

/** Tereddüt kelimesi geçse de kesinlikle tetiklememesi gerekenler. */
export const HEDGE_IGNORE = [
  "neyse", "her neyse", "boş ver", "hadi canım", "bilmiyorum ki",
  "sanırım öyle", "neyse konumuza",
];

/* ================================================================== */
/* 2. ZAMAN — nesnel, tazelik göstergesi                               */
/* ================================================================== */

/**
 * Geçmiş zaman ifadeleri. `gun` alanı arama sorgusuna tarih eklemek için.
 * Yakından uzağa sıralı — ilk eşleşen kazanır.
 *
 * NESNEL Mİ? Evet — "dün" kelimesi geçen bir cümle dünü kastediyordur.
 */
/**
 * BU LİSTE KONU BELİRLER, NİYET BELİRLEMEZ.
 * "dün" geçen bir cümle güncel bir konudan bahsediyordur — bu kesindir.
 * Ama konuşmacının soru sorduğu anlamına GELMEZ.
 */
export const TIME_PAST = [
  { k: "az önce", gun: 0 }, { k: "biraz önce", gun: 0 }, { k: "az evvel", gun: 0 },
  { k: "demin", gun: 0 }, { k: "bu sabah", gun: 0 }, { k: "bu öğlen", gun: 0 },
  { k: "bu akşam", gun: 0 }, { k: "bugün", gun: 0 }, { k: "bugünkü", gun: 0 },
  { k: "son dakika", gun: 0 }, { k: "şu an", gun: 0 },

  { k: "dün akşam", gun: 1 }, { k: "dün gece", gun: 1 }, { k: "dün sabah", gun: 1 },
  { k: "dünkü", gun: 1 }, { k: "dün", gun: 1 }, { k: "geçen gece", gun: 1 },

  { k: "evvelsi gün", gun: 2 }, { k: "önceki gün", gun: 2 },
  { k: "geçen gün", gun: 3 }, { k: "hafta sonu", gun: 3 },
  { k: "geçenlerde", gun: 5 }, { k: "son günlerde", gun: 5 },

  { k: "bu hafta", gun: 3 }, { k: "geçen hafta", gun: 7 },
  { k: "geçtiğimiz hafta", gun: 7 }, { k: "son haftalarda", gun: 14 },
  { k: "bu ay", gun: 15 }, { k: "geçen ay", gun: 30 }, { k: "geçtiğimiz ay", gun: 30 },
];

/** Gelecek zaman ifadeleri — nesnel. */
export const TIME_FUTURE = [
  "yarın", "yarınki", "öbür gün", "haftaya", "gelecek hafta",
  "önümüzdeki hafta", "gelecek ay", "önümüzdeki ay", "seneye",
  "gelecek sene", "az sonra", "birazdan",
];

/**
 * GELECEK ZAMAN FİİL EKİ — henüz olmamış bir şey doğrulanamaz.
 *
 *   "grev ne zaman bitECEK"  -> tahmin, cevaplanamaz
 *   "grev bitTİ mi"          -> gerçek soru, cevaplanabilir
 *
 * ÖNEMLİ İSTİSNA — bu ek TEK BAŞINA "kesin ele" demek DEĞİL.
 * Gelecek zamanlı bir cümle TAKVİM/TARİH sorusu olabilir:
 *
 *   "seçim ne zaman yapılacak"      -> tarih sorusu, CEVAPLANABİLİR
 *   "maç saat kaçta başlayacak"     -> program, CEVAPLANABİLİR
 *   "yeni bakan ne zaman açıklanacak" -> tarih, CEVAPLANABİLİR
 *   "zam ne kadar olacak"           -> tahmin, cevaplanamaz
 *
 * İlk üçü bilgi isteği; regex bunları eleyip susarsa gerçek soruyu
 * kaçırırız. Kural: -acak eki VAR ama tarih/program işareti de VARSA
 * (ne zaman, saat kaç, kaçta, hangi gün...) regex KESİN kabul etmez,
 * Llama'ya bırakır. Şüphe varsa modele — bizim temel ilkemiz.
 */
export const FUTURE_TENSE = /\b\p{L}+(acak|ecek|acağ|eceğ)\b/u;

/**
 * TARİH/PROGRAM İŞARETİ — "ne zaman", "saat kaç" gibi.
 * Gelecek zamanlı cümlede bu varsa, cümle tahmin değil takvim sorusudur;
 * regex kesin eleme yapmaz, model karar verir.
 */
export const SCHEDULE_MARKER = [
  "ne zaman", "saat kaç", "kaçta", "hangi gün", "hangi tarih",
  "hangi saat", "kaç günde", "ne vakit", "günü belli", "tarihi belli",
  "açıklanacak mı", "belli oldu mu", "kesinleşti mi",
];

/** Dönem ifadeleri — tarihsel bağlam, taze değil. */
export const ERA = [
  "pandemi döneminde", "pandemide", "kovid döneminde", "o dönemde",
  "o yıllarda", "eskiden", "geçmişte", "90'larda", "80'lerde", "2000'lerde",
  "çocukluğumda", "eski zamanlarda",
];

/* ================================================================== */
/* 3. KONU — hangi bilgi katmanına gideceğini belirler                 */
/* ================================================================== */

/**
 * Yarı-güncel göstergeler.
 *
 * BU LİSTE SADECE BİR HIZLANDIRMA, GÜVENLİK AĞI DEĞİL.
 *
 * Rolü: bu kelimelerden biri geçen soruyu doğrudan SEMI'ye atıp web'i de
 * seçenek yapmak (bayat yerel veri durumunda web'e düşebilsin diye).
 *
 * Ama bir kelimeyi KAÇIRSA da sorun olmaz: o soru STATIC sayılır, STATIC de
 * Vectorize'a bakar (route'da local:true). Yani "enflasyon" listede olmasa
 * bile, Vectorize'da enflasyon kaydı varsa soru yine oradan cevaplanır.
 *
 * Bu yüzden liste kısa tutulabilir — eksiksiz olması GEREKMEZ. Vectorize
 * anlam eşleştirmesi asıl işi yapıyor. Liste sadece "web'e düşme iznini"
 * önden veriyor.
 */
export const SEMI_INDICATOR = [
  "enflasyon", "tüfe", "üfe", "asgari ücret", "emekli maaşı", "memur zammı",
  "nüfus", "işsizlik", "istihdam", "büyüme oranı", "bütçe açığı", "cari açık",
  "politika faizi", "faiz oranı", "merkez bankası",
  "dolar kuru", "euro kuru", "altın fiyat", "gram altın",
  "kdv oranı", "vergi dilimi", "açlık sınırı", "yoksulluk sınırı",
];

/**
 * Doğası gereği güncel olan olay türleri.
 *
 * BU LİSTE KONU BELİRLER, NİYET BELİRLEMEZ.
 * "dünkü maç" ifadesi bize sadece şunu söyler: konuşulan bilgi günceldir,
 * yani cevap web'den gelmelidir. Konuşmacının bilgi isteyip istemediğini
 * SÖYLEMEZ:
 *
 *   "dünkü maç ne olmuş acaba"        -> istek
 *   "dünkü maçı sonra konuşuruz"      -> istek değil
 *
 * İkisinde de "dün" ve "maç" var. Niyet kararı intent.js'te.
 * Liste bilerek kısa; kaçanları model yakalar.
 */
export const FRESH_EVENT = [
  "maç", "skor", "kaç kaç", "gol", "derbi", "şampiyon",
  "seçim sonuç", "oy oranı", "sandık",
  "deprem", "sel", "yangın", "kaza", "patlama",
  "istifa", "gözaltı", "tutuklandı", "vefat", "hayatını kaybetti",
  "konser", "vizyona girdi", "son dakika",
];

/* ================================================================== */
/* 4. KESİN ELEME — niyet açısından tartışmasız olanlar                */
/* ================================================================== */

/**
 * NİYET sinyalleri. Buradaki her madde şu testi geçmeli:
 *
 *   "Bu kalıp geçen bir cümle, HİÇBİR bağlamda bilgi isteği olabilir mi?"
 *   Cevap kesin HAYIR ise buraya girer. En ufak şüphe varsa GİRMEZ,
 *   model karar verir.
 *
 * Bu yüzden liste kısa ve kısa kalacak. Uzatma isteği geldiğinde şunu
 * hatırla: yanlış eleme, gereksiz tetiklemeden daha kötüdür — sunucu
 * gerçekten yardım isterken sessiz kalırsın.
 */

/**
 * Sadece HİÇ tartışmaya açık olmayanlar. "bence" diyen biri görüş
 * belirtiyordur, nokta.
 *
 * Belirsiz durumlar (retorik ifadeler, dolaylı sorular) BURAYA EKLENMEZ —
 * onlar intent.js'in işi.
 */
export const HARD_SKIP = [
  // Görüş bildirimi — hiçbir bağlamda bilgi isteği değil
  "bence", "sence", "bana kalırsa", "bana göre", "kanaatimce",
  // Doğrudan görüş isteme — bizden değil, muhataptan isteniyor
  "sizce ne olur", "sizce ne olacak", "beklentiniz", "tahmininiz",
  "ne dersiniz", "katılıyor musunuz",
  // Tahmin — henüz olmamış, kaynak yok
  "kim kazanır", "kim kaybeder", "kim şampiyon olur",
];

/**
 * Geriye kalan HER ŞEY modele gider. Buna dahil olanlar:
 *
 *   "göreceğiz"          -> genelde retorik AMA "ne oldu göreceğiz bakalım,
 *                           Veysel bir bakar mısın" gibi kullanımlar var
 *   "bilmiyorum"         -> "asgari ücret ne oldu bilmiyorum" istek olabilir
 *   "ne oldu"            -> hitap varsa istek, yoksa değil
 *   "bunun / o işin"     -> bağlam olmadan anlaşılmaz
 *
 * Bunları listeye eklemek denendi; liste 40 maddeye çıktı ve hâlâ
 * yanlış sonuç veriyordu. Model bağlamla birlikte daha isabetli.
 */

/* ================================================================== */
/* EŞLEŞTİRME                                                          */
/* ================================================================== */

/**
 * Türkçe eklemeli bir dil olduğu için düz substring araması hatalı sonuç verir:
 *
 *     "ne ZAMan"  içinde "zam"  var  -> yanlış eşleşme ❌
 *     "AFiş"      içinde "af"   var  -> yanlış eşleşme ❌
 *     "zamLAR"                        -> doğru eşleşme ✓
 *
 * Çözüm: token'lara böl, token kelimeyle başlıyorsa kalanın geçerli bir
 * Türkçe ek olup olmadığına bak.
 */
const SUFFIX = new Set([
  "",
  "lar", "ler", "ları", "leri", "larda", "lerde", "lardan", "lerden",
  "ı", "i", "u", "ü", "yı", "yi", "yu", "yü",
  "a", "e", "ya", "ye", "na", "ne",
  "da", "de", "ta", "te", "nda", "nde",
  "dan", "den", "tan", "ten", "ndan", "nden",
  "ın", "in", "un", "ün", "nın", "nin", "nun", "nün",
  "la", "le", "yla", "yle",
  "sı", "si", "su", "sü", "m", "n", "mız", "miz", "nız", "niz",
  "mı", "mi", "mu", "mü",
  "larını", "lerini", "ması", "mesi",
]);

function matchWord(tokens, word) {
  for (const tok of tokens) {
    if (!tok.startsWith(word)) continue;
    if (SUFFIX.has(tok.slice(word.length))) return true;
  }
  return false;
}

/**
 * Bir metinde liste elemanlarından biri geçiyor mu?
 *  - Boşluk/kesme/rakam içeren ifadeler -> düz substring
 *  - Tek kelimeler                      -> ek-duyarlı eşleşme
 */
export function matchAny(text, list) {
  const t = (text || "").toLowerCase();
  const tokens = t.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

  for (const w of list) {
    if (/[^\p{L}]/u.test(w)) {
      if (t.includes(w)) return true;
    } else if (matchWord(tokens, w)) {
      return true;
    }
  }
  return false;
}

/* ================================================================== */

/** Android uygulamasına gönderilen paket. */
export function lexiconPayload() {
  return {
    version: VERSION,
    hedge: HEDGE,
    hedgeIgnore: HEDGE_IGNORE,
    // Cihazda kesin elenecekler. Kısa tutuldu; asıl eleme sunucuda,
    // niyet kontrolüyle yapılıyor.
    noTrigger: HARD_SKIP,
    // Cümlede doğrulanabilir bir konu var mı kontrolü için
    checkableHints: [...SEMI_INDICATOR, ...FRESH_EVENT],
  };
}
