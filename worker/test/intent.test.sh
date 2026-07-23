#!/usr/bin/env bash
#
# NİYET TESTİ — GERÇEK model çağrısı yapar, deploy sonrası çalıştırılır.
#
# topic.test.mjs saf regex mantığını test eder (ağ gerekmez).
# Bu script intent.js'i test eder: model niyeti doğru anlıyor mu, kaç ms sürüyor?
#
# Kullanım:
#   export WORKER=https://mai.xxx.workers.dev
#   ./test/intent.test.sh
#
set -euo pipefail
: "${WORKER:?WORKER degiskenini ayarla, orn: export WORKER=https://mai.xxx.workers.dev}"

echo "Worker: $WORKER"
echo

cat > /tmp/mai_intent_cases.json <<'JSONEOF'
{
  "texts": [
    "Veysel asgari ucret ne oldu",
    "arkadaslar asgari ucret ne oldu",
    "bu bilmem kimin olayi en son ne oldu",
    "grev bitmis miydi acaba",
    "enflasyon sanirim yuzde 35ti",
    "Lozan hangi yil imzalandi emin degilim",
    "dunku mac ne olmus acaba",
    "asgari ucret ne oldu bilmiyorum",
    "sonucu ne oldu gorecegiz",
    "bunun sonucu ne olacak bilmiyorum",
    "dunku maci sonra konusuruz",
    "neyse konumuza donelim",
    "bence enflasyon cok yuksek"
  ]
}
JSONEOF

echo "=== NIYET TESTI (gercek model cagrisi) ==="
echo

curl -sS -X POST "$WORKER/classify" \
  -H 'content-type: application/json' \
  --data-binary @/tmp/mai_intent_cases.json > /tmp/mai_intent_out.json

python3 - /tmp/mai_intent_out.json <<'PYEOF'
import sys, json
d = json.load(open(sys.argv[1]))
print(f"Analiz edilen   : {d['questionsAnalyzed']}")
print(f"Regex cozdu     : {d['regexResolvedCount']}")
print(f"Modele soruldu  : {d['modelCheckedCount']}")
print(f"Cevaplanacak    : {d['willAnswerCount']}")
print(f"Niyet ort. sure : {d['intentAvgLatencyMs']} ms")
print()
print(f"{'CEVAP':<6} | {'KARAR':<6} | {'KONU':<7} | {'ms':>4} | CUMLE")
print("-" * 88)
for r in d["results"]:
    ans = "EVET" if r["willAnswer"] else "hayir"
    print(f"{ans:<6} | {r['intentDecidedBy']:<6} | {r['topicClass']:<7} | "
          f"{r['intentLatencyMs']:>4} | {r['text'][:44]}")
print()
print("BEKLENTI")
print("  EVET  : Veysel/arkadaslar hitapli sorular, grev bitmis miydi,")
print("          enflasyon dogrulama, Lozan, dunku mac")
print("  hayir : ne oldu bilmiyorum, gorecegiz, ne olacak, sonra konusuruz,")
print("          neyse konumuza, bence")
print()
print("  Niyet suresi 150-250ms bandinda olmali.")
print("  400ms ustu ise intent.js tavani devreye giriyor demektir.")
print("  KARAR sutunu 'regex' ise model hic cagrilmadi (0 ms).")
PYEOF

echo
echo "=== GECIKME TESTI ==="
curl -sS "$WORKER/bench" | python3 -m json.tool
