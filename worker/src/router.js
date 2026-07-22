/**
 * Sınıflandırıcı — LLM'siz, regex, ~0ms.
 *
 * Kelime listeleri BURADA DEĞİL, lexicon.js'te. Tek kaynak oradan yönetilir.
 *
 *   ┌────────┬──────────────────┬───────┬───────┬─────┬───────┬────────┐
 *   │ SINIF  │ ÖRNEK            │ cache │ yerel │ web │ model │ TTL    │
 *   ├────────┼──────────────────┼───────┼───────┼─────┼───────┼────────┤
 *   │ FRESH  │ dünkü maç        │   ✓   │   ✗   │ ✓!  │  ✗!   │ 15 dk  │
 *   │ SEMI   │ enflasyon kaçtı  │   ✓   │   ✓   │  ✓  │  ✗    │  6 sa  │
 *   │ STATIC │ Çanakkale hangi  │   ✓   │   ✓   │  ✗  │  ✓    │  7 gün │
 *   │ SUBJ   │ bence daha iyi   │   ✗   │   ✗   │  ✗  │  ✗    │   —    │
 *   │ UNSURE │ grev bitti mi    │  triage.js modele TEK ikili soru sorar│
 *   │        │                  │  dönen sınıfla (fresh/static) devam   │
 *   └────────┴──────────────────┴───────────────────────────────────────┘
 *
 *   ! FRESH'te model=✗ EN KRİTİK KARAR. Model dünkü maçı bilemez ama
 *     sorulursa eğitim verisindeki bir maçı GÜVENLE söyler. Canlı yayında
 *     bu felakettir. Kanıt yoksa cevap da yok -> "EMİN DEĞİLİM".
 *
 *   ! STATIC'te web=✗ çünkü model zaten biliyor; web'e gitmek 900ms
 *     gecikme + ücret, sıfır fayda.
 */

import {
  HEDGE_ALL, HEDGE_IGNORE,
  TIME_PAST, TIME_FUTURE, PREDICTION, ERA,
  FRESH_EVENT, SEMI_INDICATOR, SUBJECTIVE,
  EVENT_VERB, EVENT_NOUN,
  matchAny,
} from "./lexicon.js";

export const CLASS = {
  FRESH: "fresh",
  SEMI: "semi",
  STATIC: "static",
  SUBJ: "subj",
  UNSURE: "unsure",   // regex karar veremedi -> triage.js modele sorar
};

/* ================================================================== */

// Türkçe ek-duyarlı eşleşme. Düz substring KULLANMA:
//   "ne ZAMan" içinde "zam" var -> yanlış eşleşme.
const has = (t, list) => matchAny(t, list);

/**
 * @param {string} text  STT çıktısı
 * @returns {string} CLASS.*
 */
export function classify(text) {
  const t = (text || "").toLowerCase();

  // 1. Öznel -> doğrulanabilir önerme yok
  if (has(t, SUBJECTIVE)) return CLASS.SUBJ;

  // 2. Gelecek zaman
  if (has(t, TIME_FUTURE)) {
    // Tahmin soruluyorsa doğrulanamaz ("yarın kim kazanır")
    if (has(t, PREDICTION)) return CLASS.SUBJ;
    // Takvim/program soruluyorsa doğrulanabilir ("yarın maç saat kaçta")
    return CLASS.FRESH;
  }

  // 3. Dönem ifadesi -> tarihsel bağlam, taze değil ("pandemi döneminde")
  //    Bu kontrol TIME_PAST'ten ÖNCE olmalı, yoksa "o dönemde" içindeki
  //    kelimeler yanlışlıkla taze sayılabilir.
  const eraHit = has(t, ERA);

  // 4. Geçmiş zaman ifadesi veya güncel olay -> taze
  if (!eraHit) {
    if (has(t, TIME_PAST.map((x) => x.k))) return CLASS.FRESH;
    if (has(t, FRESH_EVENT)) return CLASS.FRESH;
  }

  // 5. Dönem ifadesi varsa tarihsel say — SEMI kontrolünden ÖNCE olmalı.
  //    "90'larda enflasyon kaçtı" güncel enflasyon sorusu DEĞİL.
  if (eraHit) return CLASS.STATIC;

  // 6. Yarı-güncel gösterge
  if (has(t, SEMI_INDICATOR)) return CLASS.SEMI;

  // 7. Yakın yıl geçiyorsa yarı-güncel ("2026 bütçesi")
  const y = new Date().getFullYear();
  if (t.includes(String(y)) || t.includes(String(y - 1))) return CLASS.SEMI;

  // 8. Durum değişikliği soruluyor ama hangi döneme ait belli değil
  //    ("grev bitmiş miydi") -> regex çözemez, modele sor
  if (has(t, EVENT_VERB) || has(t, EVENT_NOUN)) return CLASS.UNSURE;

  return CLASS.STATIC;
}

/* ================================================================== */

/**
 * Sınıfa göre yönlendirme planı.
 *   cache/local/web/modelOK: hangi katmanlar denenecek
 *   ttl: cache ömrü (saniye) — taze veri uzun saklanmamalı
 */
export function route(cls) {
  switch (cls) {
    case CLASS.FRESH:
      // Model KESİNLİKLE bilemez, yerel bilgi de bilemez.
      // Web yoksa cevap yok — uydurmasına izin verme.
      return { cache: true, local: false, web: true, modelOK: false, ttl: 900 };

    case CLASS.SEMI:
      // Önce yerel (~80ms, bedava), bayatsa web.
      return { cache: true, local: true, web: true, modelOK: false, ttl: 21600 };

    case CLASS.STATIC:
      // Model zaten bilir; web gereksiz maliyet ve gecikme.
      return { cache: true, local: true, web: false, modelOK: true, ttl: 604800 };

    case CLASS.SUBJ:
      return { cache: false, local: false, web: false, modelOK: false, ttl: 0 };

    case CLASS.UNSURE:
      // Doğrudan kullanılmaz; index.js önce triage() çağırır.
      // Buradaki değerler yalnızca triyaj başarısız olursa geçerli:
      // güvenli taraf = web'e git, modele güvenme.
      return { cache: true, local: false, web: true, modelOK: false, ttl: 900 };

    default:
      return { cache: true, local: true, web: true, modelOK: true, ttl: 21600 };
  }
}

/* ================================================================== */

const AY = ["Ocak","Şubat","Mart","Nisan","Mayıs","Haziran",
            "Temmuz","Ağustos","Eylül","Ekim","Kasım","Aralık"];

/**
 * Taze sorularda arama sorgusuna tarih ekler.
 * Arama motoru "dün" kelimesini mutlak tarihe çeviremez; bu olmadan
 * geçen ayın maçı dönebilir.
 *
 *   "maç sonucu" + fresh  ->  "maç sonucu 21 Temmuz 2026"
 */
export function addTimeContext(query, cls) {
  if (cls !== CLASS.FRESH) return query;

  const t = query.toLowerCase();
  const now = new Date();

  // Gelecek ifadesi varsa ileri tarih
  if (has(t, TIME_FUTURE)) {
    const d = new Date(now.getTime() + 86400000);
    return `${query} ${d.getDate()} ${AY[d.getMonth()]} ${d.getFullYear()}`;
  }

  // Geçmiş ifadelerinden ilk eşleşen (liste yakından uzağa sıralı)
  const hit = TIME_PAST.find((x) => has(t, [x.k]));
  const gun = hit ? hit.gun : 0;
  const d = new Date(now.getTime() - gun * 86400000);

  return `${query} ${d.getDate()} ${AY[d.getMonth()]} ${d.getFullYear()}`;
}

/* ================================================================== */

/** Tereddüt tespiti — Worker tarafında da gerekirse (testler için). */
export function hasHedge(text) {
  if (has(text, HEDGE_IGNORE)) return false;
  return has(text, HEDGE_ALL);
}
