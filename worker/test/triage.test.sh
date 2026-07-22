#!/usr/bin/env bash
#
# Triyaj testi — GERÇEK model çağrısı yapar, deploy sonrası çalıştırılır.
#
# router.test.mjs saf regex'i test eder (ağ gerekmez).
# Bu script triage.js'i test eder: model gerçekten doğru karar veriyor mu,
# kaç ms sürüyor?
#
# Kullanım:
#   export WORKER=https://teyit-asistani.xxx.workers.dev
#   ./test/triage.test.sh
#
set -euo pipefail
: "${WORKER:?WORKER değişkenini ayarla, örn: export WORKER=https://...workers.dev}"

echo "Worker: $WORKER"
echo

# Beklenen sonuçlar yorumda. Model bunlarda hangi kararı veriyor, bakalım.
cat > /tmp/triage_cases.json <<'EOF'
{
  "texts": [
    "grev bitmiş miydi acaba",
    "o kanun çıktı mı emin değilim",
    "dava sonuçlandı mı acaba",
    "anlaşma imzalandı mı emin değilim",
    "ihale iptal mi oldu acaba",
    "zam onaylandı mı emin değilim",
    "soruşturma başladı mı acaba",
    "yasak kaldırıldı mı emin değilim",
    "proje durduruldu mu acaba",
    "Osmanlı'da ilk anayasa ne zaman kabul edildi emin değilim",
    "Fransız İhtilali kaç yılında başladı acaba",
    "Lozan Antlaşması imzalandı mı emin değilim",
    "Kanal İstanbul projesi onaylandı mı acaba",
    "asgari ücrete zam yapıldı mı emin değilim"
  ]
}
EOF

echo "=== TRİYAJ TESTİ (gerçek model çağrısı) ==="
echo
curl -sS -X POST "$WORKER/classify" \
  -H 'content-type: application/json' \
  --data-binary @/tmp/triage_cases.json \
| python3 - <<'PY'
import sys, json
d = json.load(sys.stdin)
print(f"Triyaj oranı      : {d['triyaj_orani']}")
print(f"Triyaj ort. süre  : {d['triyaj_ortalama_ms']} ms")
print()
print(f"{'REGEX':<8} | {'TRİYAJ':<7} | {'ms':>5} | YOL          | METİN")
print("-" * 92)
for r in d["sonuclar"]:
    p = r["plan"]
    yol = "SUS" if not (p["web"] or p["model"]) else \
          " → ".join(x for x, on in
                     [("yerel", p["yerel"]), ("web", p["web"]), ("model", p["model"])] if on)
    tri = r["triyaj_sonuc"] or "-"
    print(f"{r['regex_sinif']:<8} | {tri:<7} | {r['triyaj_ms']:>5} | {yol:<12} | {r['metin'][:44]}")
print()
print("BEKLENTİ:")
print("  - Tarihsel olanlar (Osmanlı, Fransız İhtilali, Lozan) -> static")
print("  - Güncel olanlar (grev, kanun, dava, zam, Kanal İstanbul) -> fresh")
print("  - Triyaj süresi 150-250ms bandında olmalı. 400ms üstü ise")
print("    triage.js tavanı devreye giriyor demektir, kontrol et.")
PY

echo
echo "=== GECİKME TESTİ ==="
curl -sS "$WORKER/bench" | python3 -m json.tool
