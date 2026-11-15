//! Снятие вебхука — обратная сторона set_webhook.mjs, шаг при переключениях:
//! воркер перестаёт получать апдейты, Telegram копит их до следующей
//! установки вебхука. Токен читает сам из .env и не печатает его.
//!
//! Запуск из корня репозитория: node workers/tools/remove_webhook.mjs

import { readEnv } from "./env.mjs";

const token = readEnv().BOT_TOKEN;
if (!token) {
  console.error("в .env нет BOT_TOKEN");
  process.exit(1);
}
const resp = await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ drop_pending_updates: false }),
  signal: AbortSignal.timeout(30_000),
});
const body = await resp.json().catch(() => null);
if (body?.ok === true) {
  console.log("вебхук снят");
} else {
  console.error("deleteWebhook не прошёл:", body?.description ?? `HTTP ${resp.status}`);
  process.exit(1);
}
