/**
 * topic.js test seti — ağ gerektirmez, saf regex mantığını doğrular.
 *
 *   node test/topic.test.mjs
 *
 * NE TEST EDİLİYOR
 *   1. classifyTopic()  — konu sınıflandırma (nesnel)
 *   2. precheckIntent() — niyet ön kontrolü (sadece KESİN elemeler)
 *   3. route()          — yönlendirme planları
 *   4. Güvenlik kuralları
 *   5. Zaman bağlamı enjeksiyonu
 *
 * NE TEST EDİLMİYOR
 *   intent.js — model çağrısı yapar, ancak deploy sonrası test edilebilir.
 *   Bunun için: test/intent.test.sh
 */

import {
  classifyTopic, precheckIntent, route, addTimeContext, buildQuery, hasHedge,
  TOPIC, PRECHECK,
} from "../src/topic.js";

let pass = 0, fail = 0;
const fails = [];

const check = (name, ok, expected, got, note = "") => {
  ok ? pass++ : (fail++, fails.push([name, expected, got, note]));
  return ok;
};

/* ================================================================== */
/* 1. KONU SINIFLANDIRMA — nesnel, niyetten bağımsız                   */
/* ================================================================== */

const TOPIC_CASES = [
  // FRESH — güncel olay
  ["dünkü maç ne olmuş acaba", "fresh", "zaman: dün"],
  ["dün akşam konserde ne olmuş", "fresh", "zaman + olay"],
  ["bu sabah ne açıklandı", "fresh", "zaman: bu sabah"],
  ["az önce bir şey oldu", "fresh", "zaman: az önce"],
  ["derbi kaç kaç bitti", "fresh", "olay: derbi"],
  ["deprem oldu mu", "fresh", "olay: deprem"],
  ["geçen hafta ne oldu", "fresh", "zaman: geçen hafta"],
  ["seçim sonuçları açıklandı mı", "fresh", "olay: seçim sonuç"],
  ["yarın maç saat kaçta", "fresh", "takvim sorusu"],

  // SEMI — yarı-güncel gösterge
  ["enflasyon yüzde 35ti", "semi", "gösterge: enflasyon"],
  ["asgari ücret neydi", "semi", "gösterge: asgari ücret"],
  ["nüfus kaç oldu", "semi", "gösterge: nüfus"],
  ["işsizlik oranı kaçtı", "semi", "gösterge: işsizlik"],
  ["politika faizi neydi", "semi", "gösterge: faiz"],
  ["dolar kuru ne kadar", "semi", "gösterge: kur"],
  ["2026 bütçesi neydi", "semi", "yakın yıl"],

  // STATIC — değişmeyen
  ["Çanakkale Savaşı hangi yıldı", "static", "tarihsel"],
  ["suyun kaynama noktası neydi", "static", "bilimsel sabit"],
  ["Türkiye'nin en yüksek dağı neydi", "static", "coğrafi sabit"],
  ["Cumhuriyet ne zaman ilan edildi", "static", "tarihsel"],
  ["Lozan hangi yıl imzalandı", "static", "tarihsel"],

  // Dönem ifadesi tarihselleştirir
  ["pandemi döneminde vaka sayısı neydi", "static", "dönem -> tarihsel"],
  ["90'larda enflasyon kaçtı", "static", "dönem, SEMI'yi ezer"],
  ["eskiden asgari ücret ne kadardı", "static", "dönem"],

  // Türkçe ek tuzakları
  ["Cumhuriyet ne zaman ilan edildi", "static", "'ne ZAMan' içinde 'zam' eşleşmemeli"],
  ["o zamanlar neler oluyordu", "static", "'zamanlar' eşleşmemeli"],
  ["taraflar anlaştı mı", "static", "'taRAF' içinde 'af' eşleşmemeli"],
];

console.log("\n=== 1. KONU SINIFLANDIRMA (nesnel) ===\n");
console.log("BEKLENEN | GERÇEK  |   | CÜMLE");
console.log("-".repeat(78));

for (const [text, expected, note] of TOPIC_CASES) {
  const got = classifyTopic(text);
  const ok = check(text, got === expected, expected, got, note);
  console.log(`${expected.padEnd(8)} | ${got.padEnd(7)} | ${ok ? "✓" : "✗"} | ${text}`);
}

/* ================================================================== */
/* 2. NİYET ÖN KONTROLÜ — sadece KESİN elemeler                        */
/* ================================================================== */

/**
 * ÖNEMLİ: Buradaki "ask" sonucu "tetiklenecek" demek DEĞİL.
 * "Regex karar veremedi, modele sor" demek. Asıl kararı intent.js verir.
 */
const INTENT_CASES = [
  // KESİN ELENMELİ — hiçbir bağlamda bilgi isteği olamaz
  ["bence daha iyiydi", "skip", "görüş bildirimi"],
  ["sence bu doğru mu", "skip", "görüş bildirimi"],
  ["bana kalırsa güzeldi", "skip", "görüş bildirimi"],
  ["sizce ne olur", "skip", "doğrudan görüş isteme"],
  ["beklentiniz nedir", "skip", "doğrudan görüş isteme"],
  ["kim kazanır acaba", "skip", "tahmin"],
  ["neyse konumuza dönelim", "skip", "yok sayılan kalıp"],
  ["boş ver şimdi", "skip", "yok sayılan kalıp"],

  // Gelecek zaman fiil eki — henüz olmamış, doğrulanamaz
  ["grev ne zaman bitecek", "skip", "-ecek eki"],
  ["zam gelecek mi", "skip", "-ecek eki"],
  ["yarın ne olacak", "skip", "-acak eki"],
  ["bu davanın sonucu ne olacak", "skip", "-acak eki"],
  ["açıklanacak mı acaba", "skip", "-acak eki"],
  ["hep birlikte göreceğiz", "skip", "-eceğ eki"],

  // MODELE SORULMALI — regex karar veremez
  ["Veysel asgari ücret ne oldu", "ask", "hitap var, model karar versin"],
  ["arkadaşlar asgari ücret ne oldu", "ask", "hitap var"],
  ["asgari ücret ne oldu bilmiyorum", "ask", "belirsiz, model karar versin"],
  ["sonucu ne oldu göreceğiz bakalım", "skip", "-eceğ eki yakaladı"],
  ["bu bilmem kimin olayı en son ne oldu", "ask", "dolaylı soru"],
  ["grev bitmiş miydi acaba", "ask", "geçmiş zaman, gerçek soru olabilir"],
  ["enflasyon sanırım yüzde 35ti", "ask", "doğrulama isteği olabilir"],
  ["dünkü maç ne olmuş acaba", "ask", "gerçek soru olabilir"],
  ["bunun sonucu ne oldu", "ask", "belirsiz gönderim, model karar versin"],
];

console.log("\n=== 2. NİYET ÖN KONTROLÜ (sadece kesin elemeler) ===\n");
console.log("BEKLENEN | GERÇEK  |   | CÜMLE");
console.log("-".repeat(78));

for (const [text, expected, note] of INTENT_CASES) {
  const got = precheckIntent(text);
  const ok = check(text, got === expected, expected, got, note);
  console.log(`${expected.padEnd(8)} | ${got.padEnd(7)} | ${ok ? "✓" : "✗"} | ${text}`);
}

/* ================================================================== */
/* 3. KONU VE NİYET BAĞIMSIZ MI                                        */
/* ================================================================== */

/**
 * Aynı konu (fresh), farklı niyet. classifyTopic ikisinde de aynı
 * sonucu vermeli — konu niyetten bağımsızdır.
 */
console.log("\n=== 3. KONU VE NİYET BAĞIMSIZLIĞI ===\n");

const INDEPENDENCE = [
  ["dünkü maç ne olmuş acaba", "dünkü maçı sonra konuşuruz", "fresh"],
  ["enflasyon kaçtı acaba", "enflasyon bence çok yüksek", "semi"],
];

for (const [a, b, expectedTopic] of INDEPENDENCE) {
  const ta = classifyTopic(a), tb = classifyTopic(b);
  const ok = check(
    `konu bağımsızlığı: "${a}" / "${b}"`,
    ta === expectedTopic && tb === expectedTopic,
    expectedTopic, `${ta} / ${tb}`,
    "konu aynı olmalı, niyet farklı olabilir"
  );
  console.log(`${ok ? "✓" : "✗"} her ikisi de "${expectedTopic}"`);
  console.log(`    "${a}" -> ${ta}`);
  console.log(`    "${b}" -> ${tb}`);
}

/* ================================================================== */
/* 4. YÖNLENDİRME PLANLARI                                             */
/* ================================================================== */

console.log("\n=== 4. YÖNLENDİRME PLANLARI ===\n");
console.log("KONU   | cache | yerel | web | model | ttl     |   ");
console.log("-".repeat(58));

const PLAN_EXPECT = {
  fresh:  { web: true,  modelOK: false, local: false },
  semi:   { web: true,  modelOK: false, local: true  },
  static: { web: false, modelOK: true,  local: true  },
};

for (const [topic, exp] of Object.entries(PLAN_EXPECT)) {
  const p = route(topic);
  const ok = check(
    `route(${topic})`,
    p.web === exp.web && p.modelOK === exp.modelOK && p.local === exp.local,
    JSON.stringify(exp), JSON.stringify(p), "plan"
  );
  const b = (v) => (v ? "  ✓  " : "  ✗  ");
  console.log(
    `${topic.padEnd(6)} | ${b(p.cache)} | ${b(p.local)} | ${b(p.web).slice(0,3)} | ${b(p.modelOK)} | ${String(p.ttl).padStart(7)} | ${ok ? "✓" : "✗"}`
  );
}

/* ================================================================== */
/* 5. KRİTİK GÜVENLİK KURALLARI                                        */
/* ================================================================== */

console.log("\n=== 5. KRİTİK GÜVENLİK KURALLARI ===\n");

const SAFETY = [
  ["FRESH'te model devre dışı", () => route(TOPIC.FRESH).modelOK === false,
   "Model dünkü maçı bilemez ama sorulursa eskisini uydurur"],
  ["FRESH'te web zorunlu", () => route(TOPIC.FRESH).web === true,
   "Kanıt yoksa cevap da olmamalı"],
  ["FRESH'te yerel kapalı", () => route(TOPIC.FRESH).local === false,
   "Vectorize ayda bir güncelleniyor, dünkü haberi içeremez"],
  ["STATIC web'e gitmiyor", () => route(TOPIC.STATIC).web === false,
   "Gereksiz 900ms + ücret"],
  ["FRESH TTL kısa (<=15dk)", () => route(TOPIC.FRESH).ttl <= 900,
   "Taze veri uzun saklanmamalı"],
  ["STATIC TTL uzun (>=1 gün)", () => route(TOPIC.STATIC).ttl >= 86400,
   "Çanakkale'nin yılı değişmeyecek"],
  ["Gelecek zaman eki her zaman elenir", () => precheckIntent("bu iş ne zaman bitecek") === PRECHECK.SKIP,
   "Olmamış bir şey doğrulanamaz"],
  ["Hitaplı soru modele gider", () => precheckIntent("Veysel bu ne oldu") === PRECHECK.ASK_MODEL,
   "Regex hitabı değerlendiremez, model değerlendirmeli"],
];

for (const [name, fn, why] of SAFETY) {
  const ok = check(name, fn(), "true", "false", why);
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) console.log(`    → ${why}`);
}

/* ================================================================== */
/* 6. TEREDDÜT KAPISI                                                  */
/* ================================================================== */

console.log("\n=== 6. TEREDDÜT KAPISI ===\n");

const HEDGE_CASES = [
  ["enflasyon sanırım yüzde 35ti", true, "hedge: sanırım"],
  ["asgari ücret neydi", true, "hedge: neydi"],
  ["Enflasyon yüzde 32,11 oldu.", false, "emin konuşuyor, hedge yok"],
  ["neyse konumuza dönelim", false, "yok sayılan kalıp"],
];

for (const [text, expected, note] of HEDGE_CASES) {
  const got = hasHedge(text);
  const ok = check(text, got === expected, String(expected), String(got), note);
  console.log(`${ok ? "✓" : "✗"} ${String(got).padEnd(5)} | ${text}`);
}

/* ================================================================== */
/* 7. ZAMAN BAĞLAMI VE SORGU ÜRETİMİ                                   */
/* ================================================================== */

console.log("\n=== 7. ZAMAN BAĞLAMI ENJEKSİYONU ===\n");

const TIME_CASES = [
  ["maç sonucu", "fresh", true, "taze -> tarih eklenmeli"],
  ["Çanakkale savaşı", "static", false, "sabit -> tarih EKLENMEMELİ"],
  ["enflasyon oranı", "semi", false, "yarı-güncel -> tarih eklenmemeli"],
];

for (const [q, topic, shouldAdd, note] of TIME_CASES) {
  const out = addTimeContext(q, topic);
  const added = out !== q;
  const ok = check(q, added === shouldAdd, String(shouldAdd), String(added), note);
  console.log(`${ok ? "✓" : "✗"} ${q.padEnd(20)} -> ${out}`);
}

console.log("\n=== 8. SORGU ÜRETİMİ ===\n");

const QUERY_CASES = [
  ["enflasyon sanırım yüzde 35ti", ["enflasyon"], ["sanırım"]],
  ["dünkü maç ne olmuş acaba", ["maç"], ["acaba"]],
];

for (const [input, mustHave, mustNotHave] of QUERY_CASES) {
  const out = buildQuery(input);
  const okHave = mustHave.every((w) => out.toLowerCase().includes(w));
  const okNot = mustNotHave.every((w) => !out.toLowerCase().includes(w));
  const ok = check(input, okHave && okNot, mustHave.join(","), out, "hedge temizliği");
  console.log(`${ok ? "✓" : "✗"} "${input}" -> "${out}"`);
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
