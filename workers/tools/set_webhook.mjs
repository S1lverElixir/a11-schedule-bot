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
//! Секрет — тот же, что в секрете WEBHOOK_SECRET воркера (npx wrangler secret put).

import { readEnv } from "./env.mjs";
import { createInterface } from "node:readline";

const [url, flag] = process.argv.slice(2);
if (!url) {
  console.error("нужен аргумент: адрес воркера");
  process.exit(1);
}

async function readStdinLines(count) {
  const rl = createInterface({ input: process.stdin });
  const it = rl[Symbol.asyncIterator]();
  const out = [];
  while (out.length < count) {
    let got = false;
    for await (const line of it) {
      const t = line.trim();
      if (t !== "") {
        out.push(t);
        got = true;
        break;
      }
    }
    if (!got) {
      // stdin кончился раньше нужного числа строк — висеть нельзя
      return out;
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
  token = readEnv().BOT_TOKEN;
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
  signal: AbortSignal.timeout(30_000),
});
const body = await resp.json().catch(() => null);
if (body?.ok === true) {
  console.log("вебхук установлен:", url);
  // подтвердить, какому именно боту встал вебхук: токен не печатается
  const me = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
    signal: AbortSignal.timeout(30_000),
  })
    .then((r) => r.json())
    .catch(() => null);
  console.log("бот:", me?.ok ? `@${me.result.username}` : "getMe не ответил");
} else {
  console.error("setWebhook не прошёл:", body?.description ?? `HTTP ${resp.status}`);
  process.exit(1);
}
