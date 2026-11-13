//! Три секрета воркера через `npx wrangler secret put`: BOT_TOKEN и
//! MY_TELEGRAM_ID берутся из .env, WEBHOOK_SECRET генерируется на месте
//! (32 байта hex — проходит ограничение Telegram [A-Za-z0-9_-]). Значения
//! нигде не печатаются; секрет вебхука дополнительно кладётся во временный
//! файл, путь которого печатается — его читает set_webhook.mjs через stdin.
//!
//! Запуск из корня репозитория: node workers/tools/set_secrets.mjs

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

function readEnv() {
  let text;
  try {
    text = readFileSync(resolve(".env"), "utf8");
  } catch {
    console.error(".env не найден в корне репозитория");
    process.exit(1);
  }
  const map = {};
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    const kv = t.replace(/^export\s+/, "").split("=");
    if (kv.length < 2) continue;
    let value = kv.slice(1).join("=").trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    map[kv[0].trim()] = value;
  }
  return map;
}

const env = readEnv();
if (!env.BOT_TOKEN || !env.MY_TELEGRAM_ID) {
  console.error("в .env нет BOT_TOKEN или MY_TELEGRAM_ID");
  process.exit(1);
}
const webhookSecret = randomBytes(32).toString("hex");

const dir = mkdtempSync(join(tmpdir(), "a11-secrets-"));
const secretFile = join(dir, "webhook-secret.txt");
writeFileSync(secretFile, webhookSecret + "\n", { mode: 0o600 });

function putSecret(name, value) {
  // значение уходит в stdin, не в argv; вывод wrangler значений не содержит
  const r = spawnSync("npx", ["wrangler", "secret", "put", name], {
    cwd: resolve("workers"),
    input: value + "\n",
    encoding: "utf8",
    shell: process.platform === "win32",
    timeout: 120_000,
  });
  if (r.status !== 0) {
    console.error(`[FAIL] ${name}: wrangler завершился с кодом ${r.status}`);
    console.error((r.stderr || r.stdout || "").split("\n").slice(0, 5).join("\n"));
    process.exit(1);
  }
  console.log(`[OK] ${name} поставлен`);
}

putSecret("BOT_TOKEN", env.BOT_TOKEN);
putSecret("MY_TELEGRAM_ID", env.MY_TELEGRAM_ID);
putSecret("WEBHOOK_SECRET", webhookSecret);
console.log("важно: секрет в воркере уже новый — сразу после этого поставь");
console.log("вебхук с тем же файлом секрета, иначе Telegram будет получать 401:");
console.log(`путь к секрету вебхука (stdin для set_webhook.mjs): ${secretFile}`);
