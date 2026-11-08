//! Установка вебхука на воркер. Токен читает сам из .env в корне репозитория
//! и не печатает его; выводит только ответ Telegram.
//!
//! Запуск из корня репозитория:
//!   node workers/tools/set_webhook.mjs <адрес-воркера> <секрет-вебхука>
//!
//! Для тестового бота (его токена в .env нет) добавь флаг --stdin и вставь
//! токен первой строкой:
//!   node workers/tools/set_webhook.mjs <адрес-воркера> <секрет-вебхука> --stdin
//!
//! Секрет — тот же, что в секретe WEBHOOK_SECRET воркера (npx wrangler secret put).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

const [url, secret, flag] = process.argv.slice(2);
if (!url || !secret) {
  console.error("нужны два аргумента: адрес воркера и секрет вебхука");
  process.exit(1);
}

// разбор .env как у run.py: BOM, комментарии, кавычки
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

async function readTokenStdin() {
  const rl = createInterface({ input: process.stdin });
  const it = rl[Symbol.asyncIterator]();
  for await (const line of it) {
    const t = line.trim();
    if (t !== "") {
      rl.close();
      return t;
    }
  }
  return null;
}

const token = flag === "--stdin" ? await readTokenStdin() : readToken();
if (!token) {
  console.error(
    flag === "--stdin" ? "токен не введён" : "в .env нет BOT_TOKEN",
  );
  process.exit(1);
}

const resp = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    url,
    secret_token: secret,
    allowed_updates: ["message", "callback_query"],
  }),
});
const body = await resp.json().catch(() => null);
if (body?.ok === true) {
  console.log("вебхук установлен:", url);
} else {
  console.error("setWebhook не прошёл:", body?.description ?? `HTTP ${resp.status}`);
  process.exit(1);
}
