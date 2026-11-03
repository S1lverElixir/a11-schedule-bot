#!/bin/sh
# Скачивание статического бинарника бота с GitHub — для хоста, где нет сборочной
# машины. Публичный репозиторий: обычная ссылка релиза. Приватный: через API,
# нужен ACCESS_TOKEN (тот же, которым хостинг клонирует репозиторий).
#
#   sh rust/tools/fetch.sh [куда_положить]
set -eu

REPO=${A11_REPO:-S1lverElixir/a11-schedule-bot}
ASSET=a11-bot
OUT=${1:-./a11-bot}
TMP="$OUT.tmp"

if [ -n "${ACCESS_TOKEN:-}" ]; then
  echo "скачиваю через API: $REPO (приватный репозиторий)"
  META=$(mktemp)
  curl -fsSL -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$REPO/releases/tags/rust-latest" -o "$META"
  URL=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(next(a["url"] for a in d["assets"] if a["name"]=="'"$ASSET"'"))' "$META")
  rm -f "$META"
  curl -fsSL -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H "Accept: application/octet-stream" "$URL" -o "$TMP"
else
  echo "скачиваю релиз: $REPO/rust-latest"
  curl -fsSL "https://github.com/$REPO/releases/download/rust-latest/$ASSET" -o "$TMP"
fi

chmod +x "$TMP"
mv "$TMP" "$OUT"
echo "готово: $OUT ($(wc -c < "$OUT") байт)"
