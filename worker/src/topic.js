/**
 * KONU SINIFLANDIRICI — nesnel, regex, ~0 ms.
 *
 * SADECE ŞU SORUYA CEVAP VERİR: bu cümlede geçen bilgi hangi türden?
 * "Konuşmacı bilgi istiyor mu?" sorusu BURADA DEĞİL — o intent.js'te.
 *
 * Bu ayrım kritik. Eskiden ikisi tek fonksiyondaydı ve şu hataya yol açıyordu:
 *
 *   "dünkü maç ne olmuş acaba"     -> fresh + istek     ✓
 *   "dünkü maçı sonra konuşuruz"   -> fresh + istek DEĞİL
 *
 * İkisinde de "dün" ve "maç" var. Zaman ifadesi konuyu belirler, niyeti
 * belirlemez. Karıştırınca ikincisi de web araması tetikliyordu.
 *
 * ┌────────┬──────────────────┬───────┬───────┬─────┬───────┬────────┐
 * │ KONU   │ ÖRNEK            │ cache │ yerel │ web │ model │ TTL    │
 * ├────────┼──────────────────┼───────┼───────┼─────┼───────┼────────┤
 * │ FRESH  │ dünkü maç        │   ✓   │   ✗   │ ✓!  │  ✗!   │ 15 dk  │
 * │ SEMI   │ enflasyon        │   ✓   │   ✓   │  ✓  │  ✗    │  6 sa  │
 * │ STATIC │ Çanakkale        │   ✓   │   ✓   │  ✗  │  ✓    │  7 gün │
 * └────────┴──────────────────┴───────┴───────┴─────┴───────┴────────┘
 *
 *   ! FRESH'te model=✗ EN KRİTİK KARAR. Model dünkü maçı bilemez ama
 *     sorulursa eğitim verisindeki bir maçı GÜVENLE söyler.
 */

import {
  HEDGE, HEDGE_IGNORE, HARD_SKIP,
  TIME_PAST, TIME_FUTURE, FUTURE_TENSE, SCHEDULE_MARKER, ERA,
  FRESH_EVENT, SEMI_INDICATOR,
  matchAny,
} from "./lexicon.js";

/** Bilginin türü — nesnel. */
export const TOPIC = {
  FRESH: "fresh",     // son günlerde olmuş, web gerekir
  SEMI: "semi",       // ayda bir değişen gösterge, yerel bilgi tabanında olabilir
  STATIC: "static",   // değişmeyen bilgi, model bilir
};

/** Niyet ön kontrolü sonucu. */
export const PRECHECK = {
  SKIP: "skip",       // kesin bilgi isteği değil -> hiçbir şey yapma
  ASK_MODEL: "ask",   // regex karar veremez -> intent.js'e sor
};

const has = (t, list) => matchAny(t, list);

/* ================================================================== */
/* NİYET ÖN KONTROLÜ — sadece KESİN olanları eler                      */
/* ================================================================== */

/**
 * Bu cümlenin bilgi isteği OLMADIĞI kesin mi?
 *
 * Sadece hiçbir bağlamda istek olamayacak kalıplar burada elenir.
 * En ufak şüphe varsa ASK_MODEL döner — yanlış eleme, gereksiz
 * tetiklemeden daha kötüdür (sunucu gerçekten sorarken sessiz kalırsın).
 *
 * @returns {"skip"|"ask"}
 */
export function precheckIntent(text) {
  const t = (text || "").toLowerCase();

  // Yok sayılan kalıplar ("neyse", "boş ver")
  if (has(t, HEDGE_IGNORE)) return PRECHECK.SKIP;

  // Görüş bildirimi / doğrudan tahmin isteme
  if (has(t, HARD_SKIP)) return PRECHECK.SKIP;

  // Gelecek zaman fiil eki — henüz olmamış bir şey doğrulanamaz.
  //   "grev ne zaman bitECEK"  -> tahmin -> elenir
  //   "grev bitTİ mi"          -> gerçek soru -> elenmez
  //
  // AMA istisna: -acak eki TEK BAŞINA kesin değil. Tarih/program işareti
  // varsa cümle takvim sorusudur, tahmin değil:
  //   "seçim ne zaman yapılacak"  -> tarih sorusu, CEVAPLANABİLİR
  //   "maç saat kaçta başlayacak" -> program, CEVAPLANABİLİR
  // Bu durumda regex kesin karar vermez, Llama'ya bırakır (şüphe varsa modele).
  if (FUTURE_TENSE.test(t) && !has(t, SCHEDULE_MARKER)) return PRECHECK.SKIP;

  // Geri kalan her şey belirsiz -> model karar versin
  return PRECHECK.ASK_MODEL;
}

/** Tereddüt ifadesi var mı? Uygulamanın tetiklenme kapısı. */
export function hasHedge(text) {
  const t = (text || "").toLowerCase();
  if (has(t, HEDGE_IGNORE)) return false;
  return has(t, HEDGE);
}

/* ================================================================== */
/* KONU SINIFLANDIRMA — nesnel                                         */
/* ================================================================== */

/**
 * Cümlede geçen bilgi hangi türden?
 * Niyetten bağımsız çalışır — sadece "hangi katmandan cevaplanmalı" sorusu.
 *
 * @returns {"fresh"|"semi"|"static"}
 */
export function classifyTopic(text) {
  const t = (text || "").toLowerCase();

  // Dönem ifadesi varsa tarihsel bağlam — diğer kontrollerden ÖNCE.
  // "90'larda enflasyon kaçtı" güncel enflasyon sorusu DEĞİL.
  const isEra = has(t, ERA);

  if (!isEra) {
    // Geçmiş zaman ifadesi veya güncel olay türü -> taze
    if (has(t, TIME_PAST.map((x) => x.k))) return TOPIC.FRESH;
    if (has(t, FRESH_EVENT)) return TOPIC.FRESH;
    // Gelecek zaman ifadesi + fiil eki yoksa takvim sorusu ("yarın maç kaçta")
    if (has(t, TIME_FUTURE)) return TOPIC.FRESH;

    // GELECEK ZAMANLI TAKVİM SORUSU ASLA STATIC OLAMAZ.
    //   "seçim ne zaman yapılacak"  -> açıklanmış/değişebilen tarih
    //   "maç saat kaçta başlayacak" -> güncel program
    // Bunlar modelin eğitim verisinde eski haliyle durur ve model onu
    // güvenle söyler. Static olsalardı web'e hiç gidilmez, bayat tarih
    // ekrana çıkardı. Fresh yaparak web'i ZORUNLU kılıyoruz.
    //
    // "Lozan ne zaman imzalandı" bundan etkilenmez: gelecek zaman eki yok,
    // sadece SCHEDULE_MARKER var -> aşağıya düşer, static kalır (doğru).
    if (FUTURE_TENSE.test(t) && has(t, SCHEDULE_MARKER)) return TOPIC.FRESH;
  }

  if (isEra) return TOPIC.STATIC;

  // Yarı-güncel gösterge (Vectorize'da kaydı olabilir)
  if (has(t, SEMI_INDICATOR)) return TOPIC.SEMI;

  // Yakın yıl geçiyorsa yarı-güncel ("2026 bütçesi")
  const y = new Date().getFullYear();
  if (t.includes(String(y)) || t.includes(String(y - 1))) return TOPIC.SEMI;

  return TOPIC.STATIC;
}

/* ================================================================== */
/* YÖNLENDİRME PLANI                                                   */
/* ================================================================== */

/**
 * Konuya göre hangi katmanlar denenecek.
 *   ttl: cache ömrü (saniye) — taze veri uzun saklanmamalı
 */
export function route(topic) {
  switch (topic) {
    case TOPIC.FRESH:
      // Model KESİNLİKLE bilemez, yerel bilgi de bilemez.
      // Web yoksa cevap yok — uydurmasına izin verme.
      return { cache: true, local: false, web: true, modelOK: false, ttl: 900 };

    case TOPIC.SEMI:
      // Önce yerel (~80 ms, bedava), bayatsa web.
      return { cache: true, local: true, web: true, modelOK: false, ttl: 21600 };

    case TOPIC.STATIC:
      // local: true ÖNEMLİ — SEMI_INDICATOR listesi bir kelimeyi kaçırsa
      // bile (örn. yeni bir gösterge eklendi ama listeye yazılmadı), static
      // sayılan soru yine de Vectorize'a bakar. Kayıt varsa oradan cevaplanır.
      // Yani liste bir HIZLANDIRMA, güvenlik ağı değil — Vectorize yakalar.
      // web: false çünkü model zaten bilir, web gereksiz maliyet.
      return { cache: true, local: true, web: false, modelOK: true, ttl: 604800 };

    default:
      return { cache: true, local: true, web: true, modelOK: true, ttl: 21600 };
  }
}

/* ================================================================== */
/* ZAMAN BAĞLAMI                                                       */
/* ================================================================== */

const AY = ["Ocak","Şubat","Mart","Nisan","Mayıs","Haziran",
            "Temmuz","Ağustos","Eylül","Ekim","Kasım","Aralık"];

/**
 * Taze konularda arama sorgusuna tarih ekler.
 * Arama motoru "dün" kelimesini mutlak tarihe çeviremez; bu olmadan
 * geçen ayın maçı dönebilir.
 *
 *   "maç sonucu" + fresh  ->  "maç sonucu 21 Temmuz 2026"
 */
export function addTimeContext(query, topic) {
  if (topic !== TOPIC.FRESH) return query;

  const t = query.toLowerCase();
  const now = new Date();

  if (has(t, TIME_FUTURE)) {
    const d = new Date(now.getTime() + 86400000);
    return `${query} ${d.getDate()} ${AY[d.getMonth()]} ${d.getFullYear()}`;
  }

  const hit = TIME_PAST.find((x) => has(t, [x.k]));
  const d = new Date(now.getTime() - (hit ? hit.gun : 0) * 86400000);
  return `${query} ${d.getDate()} ${AY[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * Arama sorgusu üretimi — LLM'siz, ~0 ms.
 * Tereddüt kalıpları ve dolgu kelimeleri atılır, çekirdek terimler kalır.
 */
export function buildQuery(q, context = "") {
  const HEDGE_RE = new RegExp(`\\b(${HEDGE.join("|")})\\b`, "gi");
  const FILLER = /\b(şey|yani|işte|hani|falan|filan|bir|bu|şu|çok|daha|ama|için|ile|olarak|gibi|kadar|sonra|önce|tabii|aslında|acaba)\b/gi;

  const s = ((context ? context + " " : "") + q)
    .replace(HEDGE_RE, " ")
    .replace(FILLER, " ")
    .replace(/[^\p{L}\p{N}\s%.,]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  return s.split(" ").filter((x) => x.length > 2).slice(0, 8).join(" ");
}
