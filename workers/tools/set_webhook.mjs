//! Установка вебхука на воркер. Токен читает сам из .env в корне репозитория
//! и не печатает его; выводит только ответ Telegram. Секрет вебхука через
//! argv не принимается: он остался бы в истории PowerShell и в списке процессов,
//! поэтому всегда идёт через stdin.
//!
//! Запуск из корня репозитория (секрет — первой строкой stdin):
//!   node workers/tools/set_webhook.mjs <адрес-воркера>
//!
//! Для тестового бота (его токена в .env нет) добавь флаг --stdin и вставь
//! две строки: токен, затем секрет:
//!   node workers/tools/set_webhook.mjs <адрес-воркера> --stdin
//!
//! Секрет — тот же, что в секретe WEBHOOK_SECRET воркера (npx wrangler secret put).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

const [url, flag] = process.argv.slice(2);
if (!url) {
  console.error("нужен аргумент: адрес воркера");
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

async function readStdinLines(count) {
  const rl = createInterface({ input: process.stdin });
  const it = rl[Symbol.asyncIterator]();
  const out = [];
  while (out.length < count) {
    for await (const line of it) {
      const t = line.trim();
      if (t !== "") {
        out.push(t);
        break;
      }
    }
  }
  rl.close();
  return out;
}

let token;
let secret;
if (flag === "--stdin") {
  [token, secret] = await readStdinLines(2);
  if (!token || !secret) {
    console.error("stdin должен дать две строки: токен и секрет вебхука");
    process.exit(1);
  }
} else {
  token = readToken();
  if (!token) {
    console.error("в .env нет BOT_TOKEN");
    process.exit(1);
  }
  [secret] = await readStdinLines(1);
  if (!secret) {
    console.error("секрет вебхука не введён (первая строка stdin)");
    process.exit(1);
  }
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
