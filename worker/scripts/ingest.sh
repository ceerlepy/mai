#!/usr/bin/env bash
# Yerel bilgi tabanını (Vectorize) doldurur.
#
# Kullanım:
#   export WORKER=https://mai.veyseltosun-vt.workers.dev
#   export TOKEN=<INGEST_TOKEN>
#   bash scripts/ingest.sh                 # varsayılan seed.json
#   bash scripts/ingest.sh baska.json      # başka dosya
#
# Ayda bir çalıştırman yeterli — seed.json güncel kaldığı sürece
# semi sorular web'e gitmeden ~80ms'de cevaplanır.
set -euo pipefail

# --- Değişken kontrolü: boşsa net hata ver, sessizce asılı kalma ---
if [ -z "${WORKER:-}" ]; then
  echo "HATA: WORKER ayarlı değil." >&2
  echo "  export WORKER=https://mai.veyseltosun-vt.workers.dev" >&2
  exit 1
fi
if [ -z "${TOKEN:-}" ]; then
  echo "HATA: TOKEN ayarlı değil (INGEST_TOKEN secret değeri)." >&2
  echo "  export TOKEN=<girdiğin INGEST_TOKEN>" >&2
  exit 1
fi

FILE="${1:-scripts/seed.json}"
if [ ! -f "$FILE" ]; then
  echo "HATA: '$FILE' bulunamadı. worker/ klasöründen çalıştır." >&2
  exit 1
fi

echo "Worker : $WORKER"
echo "Dosya  : $FILE"
echo "Yükleniyor..."
echo ""

curl -sS -X POST "$WORKER/ingest" \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  --data-binary "@$FILE" | python3 -m json.tool
