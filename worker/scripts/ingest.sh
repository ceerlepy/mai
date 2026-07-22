#!/usr/bin/env bash
# Yerel bilgi tabanını doldurur.
#
# Kullanım:
#   export WORKER=https://teyit-asistani.xxx.workers.dev
#   export TOKEN=<INGEST_TOKEN>
#   ./scripts/ingest.sh scripts/seed.json
#
# Önce seed.json içindeki "GÜNCELLE:" satırlarını gerçek rakamlarla doldur.
# Ayda bir çalıştırman yeterli — bu dosya güncel kaldığı sürece
# web aramasına neredeyse hiç gidilmez.
set -euo pipefail
FILE="${1:-scripts/seed.json}"
curl -sS -X POST "$WORKER/ingest" \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  --data-binary "@$FILE" | python3 -m json.tool
