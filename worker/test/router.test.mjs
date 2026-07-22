/**
 * router.js test seti — ağ gerektirmez, saf regex mantığını doğrular.
 *
 *   node test/router.test.mjs
 *
 * NOT: triage.js BU TESTLERDE YOK. O bir model çağrısı yapar ve ancak
 * deploy edildikten sonra test edilebilir -> test/triage.test.sh
 */

import { classify, route, addTimeContext, CLASS } from "../src/router.js";

/* ================================================================== */
/* Vakalar: [cümle, beklenen sınıf, açıklama]                          */
/* ================================================================== */

const CASES = [
  // ---------------- FRESH: gerçekten taze, web zorunlu ----------------
  ["dünkü maç ne olmuş acaba", "fresh", "zaman: dün"],
  ["dün akşam konserde problem olmuş mu", "fresh", "zaman: dün akşam"],
  ["bu sabah ne açıklandı emin değilim", "fresh", "zaman: bu sabah"],
  ["az önce bir şey oldu galiba", "fresh", "zaman: az önce"],
  ["derbi kaç kaç bitti emin değilim", "fresh", "olay: derbi"],
  ["deprem oldu mu sanırım", "fresh", "olay: deprem"],
  ["geçen hafta mitingde kaç kişi vardı", "fresh", "zaman: geçen hafta"],
  ["son dakika ne geldi bilmiyorum tam", "fresh", "zaman: son dakika"],
  ["dün gece skor neydi", "fresh", "zaman + olay"],
  ["bugünkü toplantıda ne karar aldı acaba", "fresh", "zaman: bugünkü"],

  // ---------------- SEMI: yarı-güncel, Vectorize'da tutulabilir -------
  ["enflasyon sanırım yüzde 35ti", "semi", "gösterge: enflasyon"],
  ["asgari ücret neydi emin değilim", "semi", "gösterge: asgari ücret"],
  ["Türkiye nüfusu galiba 85 milyon", "semi", "gösterge: nüfus"],
  ["işsizlik oranı kaçtı acaba", "semi", "gösterge: işsizlik"],
  ["politika faizi neydi tam hatırlamıyorum", "semi", "gösterge: faiz"],
  ["dolar kuru sanırım 40 lira", "semi", "gösterge: kur"],
  ["emekli maaşı ne kadar oldu emin değilim", "semi", "gösterge: emekli maaşı"],
  ["tüfe kaç açıklandı acaba", "semi", "gösterge: tüfe"],

  // ---------------- STATIC: model zaten bilir, web gereksiz ----------
  ["Çanakkale Savaşı hangi yıldı emin değilim", "static", "tarihsel"],
  ["suyun kaynama noktası neydi", "static", "bilimsel sabit"],
  ["Türkiye'nin en yüksek dağı neydi acaba", "static", "coğrafi sabit"],
  ["Cumhuriyet ne zaman ilan edildi tam hatırlamıyorum", "static", "tarihsel"],
  ["Ay'a ilk kim ayak bastı emin değilim", "static", "tarihsel"],
  ["Karadeniz'in en derin yeri neydi", "static", "coğrafi sabit"],
  ["periyodik tabloda kaç element var acaba", "static", "bilimsel sabit"],
  ["İstanbul'un fethi hangi yıldı emin değilim", "static", "tarihsel"],

  // ---------------- SUBJ: doğrulanamaz, sus -------------------------
  ["bence daha iyiydi değil mi", "subj", "öznel: bence"],
  ["sence bu doğru mu", "subj", "öznel: sence"],
  ["bana kalırsa güzeldi sanırım", "subj", "öznel: bana kalırsa"],
  ["çok beğendim sanırım siz de", "subj", "öznel: beğendim"],

  // ---------------- UNSURE: regex bilemez, modele sor ---------------
  ["grev bitmiş miydi acaba", "unsure", "olay ismi: grev"],
  ["o kanun çıktı mı emin değilim", "unsure", "olay ismi: kanun"],
  ["dava sonuçlandı mı acaba", "unsure", "olay ismi + fiil"],
  ["anlaşma imzalandı mı emin değilim", "unsure", "olay ismi: anlaşma"],
  ["ihale iptal mi oldu acaba", "unsure", "olay ismi: ihale"],
  ["zam onaylandı mı emin değilim", "unsure", "olay ismi: zam"],
  ["soruşturma başladı mı acaba", "unsure", "olay ismi: soruşturma"],
  ["yasak kaldırıldı mı emin değilim", "unsure", "fiil: kaldırıl"],
  ["proje durduruldu mu acaba", "unsure", "olay ismi: proje"],
  // NOT: "istifa" FRESH listesinde olduğu için doğrudan web'e gider,
  // triyaj turu atlanır -> 250ms daha hızlı. Beklenen davranış budur.
  ["istifa etti mi emin değilim", "fresh", "istifa FRESH listesinde"],

  // ---------------- Sınır durumlar ----------------------------------
  ["kısa", null, "çok kısa -> hedge yok, sınıf yine de üretilir"],
  ["2026 bütçesi neydi acaba", "semi", "yıl geçiyor -> semi"],

  // ---------------- TÜRKÇE EK TUZAKLARI -----------------------------
  // Düz substring araması bunlarda hata verir; ek-duyarlı eşleşme şart.
  ["Cumhuriyet ne zaman ilan edildi tam hatırlamıyorum", "static", "'ne ZAMan' içinde 'zam' VAR ama eşleşmemeli"],
  ["afiş asılmış mıydı acaba", "unsure", "'AFiş' içinde 'af' var, eşleşmemeli"],
  // "zamlar" -> "zam" + "lar" eki doğru eşleşiyor (ek-duyarlı eşleşme çalışıyor).
  // Sonuç UNSURE çünkü "zam" tek başına güncel mi tarihsel mi belli değil
  // ("90'larda zam" vs "zam geldi mi") -> triyaj karar verir.
  ["zamlar geldi mi emin değilim", "unsure", "'zamlar' -> 'zam' + ek eşleşmeli"],
  ["taraflar anlaştı mı acaba", "unsure", "'taRAF' içinde 'af' var, eşleşmemeli"],
  ["o zamanlar neler oluyordu acaba", "static", "'zamanlar' eşleşmemeli"],

  // ---------------- GELECEK ZAMAN -----------------------------------
  ["yarın maç saat kaçta emin değilim", "fresh", "gelecek + takvim -> doğrulanabilir"],
  ["yarın kim kazanır acaba", "subj", "gelecek + tahmin -> doğrulanamaz"],
  ["haftaya toplantı var mıydı emin değilim", "fresh", "gelecek + takvim"],
  ["seneye enflasyon ne olur sizce", "subj", "gelecek + tahmin"],
  ["gelecek hafta zam gelir mi acaba", "subj", "gelecek + tahmin"],

  // ---------------- DÖNEM İFADELERİ ---------------------------------
  ["pandemi döneminde vaka sayısı neydi acaba", "static", "dönem -> tarihsel, taze değil"],
  ["90'larda enflasyon kaçtı emin değilim", "static", "dönem -> tarihsel"],
  ["eskiden asgari ücret ne kadardı acaba", "static", "dönem -> tarihsel"],

  // ---------------- YAYINCIYA ÖZGÜ TEREDDÜT -------------------------
  ["dilimin ucunda ama ismini unuttum", "static", "hafıza kalıbı"],
  ["bir düzeltme yapayım rakam neydi", "static", "yayıncı kalıbı"],
  ["teyit edelim dün ne olmuştu", "fresh", "yayıncı kalıbı + taze"],
  ["yanılıyor muyum enflasyon yüzde 35 miydi", "semi", "onay arama + gösterge"],

  // ---------------- SON EDGE CASE'LER -------------------------------
  // Zaman ifadesi + gösterge çakışması: zaman kazanmalı
  ["dün enflasyon açıklandı mı acaba", "fresh", "taze zaman gösterge'yi ezmeli"],
  ["geçen ay asgari ücrete zam geldi mi", "fresh", "taze zaman öncelikli"],

  // Öznel + gösterge: öznel kazanmalı (doğrulanabilir önerme yok)
  ["bence enflasyon çok yüksek", "subj", "öznel her şeyi ezer"],
  ["sence dolar kuru pahalı mı", "subj", "öznel + gösterge -> öznel"],

  // Dönem + olay: dönem kazanmalı (tarihsel)
  ["pandemide grev oldu mu acaba", "static", "dönem, olayı tarihselleştirir"],
  ["eskiden seçim ne zaman yapılırdı", "static", "dönem + olay -> tarihsel"],

  // Çoklu tereddüt kalıbı aynı cümlede
  ["sanırım galiba yanlış hatırlamıyorsam nüfus 85 milyondu", "semi", "üst üste hedge"],

  // Sayı içeren ama sabit
  ["periyodik tabloda 118 element var değil miydi", "static", "sayı var ama sabit"],
  ["bir futbol takımında 11 kişi vardı değil mi", "static", "sayı var ama sabit"],

  // Kısaltma / kurum adı
  ["TÜİK ne açıkladı acaba", "unsure", "kurum + açıklama -> belirsiz"],
  ["TCMB faiz kararı neydi emin değilim", "fresh", "faiz kararı FRESH_EVENT'te"],

  // Spor edge case
  // "kupa" FRESH_EVENT'te: şampiyonluk güncel bir bilgidir. Zaman ifadesi
  // olmasa da web'e gitmek doğru — model geçen sezonu söyleyebilir.
  ["kupayı kim kaldırdı emin değilim", "fresh", "kupa FRESH_EVENT'te"],
  ["derbi ne zaman oynandı acaba", "fresh", "derbi FRESH_EVENT'te"],

  // Negatif kontrol: hedge yok ama sınıflandırma yine çalışmalı
  ["enflasyon yüzde otuz beş", "semi", "hedge yok ama sınıf üretilir"],
];

/* ================================================================== */
/* Yönlendirme beklentileri: sınıf -> plan                             */
/* ================================================================== */

const PLAN_EXPECT = {
  fresh:  { web: true,  modelOK: false, local: false },
  semi:   { web: true,  modelOK: false, local: true  },
  static: { web: false, modelOK: true,  local: true  },
  subj:   { web: false, modelOK: false, local: false },
  unsure: { web: true,  modelOK: false, local: false },
};

/* ================================================================== */

let pass = 0, fail = 0;
const fails = [];

console.log("\n=== SINIFLANDIRMA ===\n");
console.log("BEKLENEN | GERÇEK  |   | SORU");
console.log("-".repeat(78));

for (const [text, expected, note] of CASES) {
  if (expected === null) continue;
  const got = classify(text);
  const ok = got === expected;
  ok ? pass++ : (fail++, fails.push([text, expected, got, note]));
  console.log(
    `${expected.padEnd(8)} | ${got.padEnd(7)} | ${ok ? "✓" : "✗"} | ${text}`
  );
}

console.log("\n=== YÖNLENDİRME PLANLARI ===\n");
console.log("SINIF  | cache | yerel | web | model | ttl     |   ");
console.log("-".repeat(58));

for (const [cls, exp] of Object.entries(PLAN_EXPECT)) {
  const p = route(cls);
  const ok =
    p.web === exp.web && p.modelOK === exp.modelOK && p.local === exp.local;
  ok ? pass++ : (fail++, fails.push([`route(${cls})`, JSON.stringify(exp), JSON.stringify(p), "plan"]));
  console.log(
    `${cls.padEnd(6)} | ${b(p.cache)} | ${b(p.local)} | ${b(p.web).slice(0,3)} | ${b(p.modelOK)} | ${String(p.ttl).padStart(7)} | ${ok ? "✓" : "✗"}`
  );
}

console.log("\n=== KRİTİK GÜVENLİK KURALLARI ===\n");

const SAFETY = [
  [
    "FRESH'te model devre dışı",
    () => route(CLASS.FRESH).modelOK === false,
    "Model dünkü maçı bilemez ama sorulursa eskisini uydurur",
  ],
  [
    "FRESH'te web zorunlu",
    () => route(CLASS.FRESH).web === true,
    "Kanıt yoksa cevap da olmamalı",
  ],
  [
    "FRESH'te yerel kapalı",
    () => route(CLASS.FRESH).local === false,
    "Vectorize ayda bir güncelleniyor, dünkü haberi içermez",
  ],
  [
    "UNSURE'da model devre dışı",
    () => route(CLASS.UNSURE).modelOK === false,
    "Triyaj başarısız olursa güvenli taraf: web'e git",
  ],
  [
    "SUBJ hiçbir yere gitmiyor",
    () => {
      const p = route(CLASS.SUBJ);
      return !p.web && !p.local && !p.modelOK;
    },
    "Doğrulanabilir önerme yok",
  ],
  [
    "STATIC web'e gitmiyor",
    () => route(CLASS.STATIC).web === false,
    "Gereksiz 900ms + ücret",
  ],
  [
    "FRESH TTL kısa (<=15dk)",
    () => route(CLASS.FRESH).ttl <= 900,
    "Taze veri uzun saklanmamalı",
  ],
  [
    "STATIC TTL uzun (>=1 gün)",
    () => route(CLASS.STATIC).ttl >= 86400,
    "Çanakkale'nin yılı değişmeyecek",
  ],
];

for (const [name, fn, why] of SAFETY) {
  const ok = fn();
  ok ? pass++ : (fail++, fails.push([name, "true", "false", why]));
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) console.log(`    → ${why}`);
}

console.log("\n=== ZAMAN BAĞLAMI ENJEKSİYONU ===\n");

const TIME = [
  ["maç sonucu", "fresh", true, "taze -> tarih eklenmeli"],
  ["Çanakkale savaşı", "static", false, "sabit -> tarih EKLENMEMELİ"],
  ["enflasyon oranı", "semi", false, "yarı-güncel -> tarih eklenmemeli"],
];

for (const [q, cls, shouldAdd, note] of TIME) {
  const out = addTimeContext(q, cls);
  const added = out !== q;
  const ok = added === shouldAdd;
  ok ? pass++ : (fail++, fails.push([q, String(shouldAdd), String(added), note]));
  console.log(`${ok ? "✓" : "✗"} ${q.padEnd(20)} -> ${out}`);
}

/* ================================================================== */

console.log("\n" + "=".repeat(78));
if (fail === 0) {
  console.log(`TÜM TESTLER GEÇTİ  (${pass}/${pass})`);
} else {
  console.log(`${pass} geçti, ${fail} KALDI\n`);
  for (const [what, exp, got, note] of fails) {
    console.log(`  ✗ ${what}`);
    console.log(`      beklenen: ${exp}  |  gerçek: ${got}`);
    console.log(`      not: ${note}\n`);
  }
}
console.log("=".repeat(78) + "\n");

process.exit(fail === 0 ? 0 : 1);

function b(v) {
  return v ? "  ✓  " : "  ✗  ";
}
