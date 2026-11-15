//! Снятие вебхука — обратная сторона set_webhook.mjs, шаг при переключениях:
//! воркер перестаёт получать апдейты, Telegram копит их до следующей
//! установки вебхука. Токен читает сам из .env и не печатает его.
//!
//! Запуск из корня репозитория: node workers/tools/remove_webhook.mjs

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readToken() {
  let text;
  try {
    text = readFileSync(resolve(".env"), "utf8");
  } catch {
    console.error(".env не найден в корне репозитория");
    process.exit(1);
  }
  text = text.replace(/^\uFEFF/, "");
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    const kv = t.replace(/^export\s+/, "").split("=");
    if (kv.length < 2) continue;
    const key = kv[0].trim();
    let value = kv.slice(1).join("=").trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (key === "BOT_TOKEN") return value;
  }
  return null;
}

const token = readToken();
if (!token) {
  console.error("в .env нет BOT_TOKEN");
  process.exit(1);
}
const resp = await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ drop_pending_updates: false }),
});
const body = await resp.json().catch(() => null);
if (body?.ok === true) {
  console.log("вебхук снят");
} else {
  console.error("deleteWebhook не прошёл:", body?.description ?? `HTTP ${resp.status}`);
  process.exit(1);
}
