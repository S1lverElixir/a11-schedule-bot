//! Профиль бота одним скриптом: аватар, описание, короткое описание, команды
//! и меню-кнопка. Токен читает сам из .env в корне репозитория и не печатает
//! его; вывод — только ответы Telegram по шагам.
//!
//! Запуск из корня репозитория:
//!   node workers/tools/bot_profile.mjs [путь-к-аватару]
//!
//! Аватар — JPG (Bot API принимает статичный JPG в setMyProfilePhoto);
//! по умолчанию assets/bot-avatar.jpg. Остальное ставится всегда.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const avatarPath = process.argv[2] ?? "assets/bot-avatar.jpg";

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
const base = `https://api.telegram.org/bot${token}`;

async function call(method, params) {
  const resp = await fetch(`${base}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params ?? {}),
  });
  const body = await resp.json().catch(() => null);
  return body?.ok === true
    ? { ok: true, result: body.result }
    : { ok: false, error: body?.description ?? `HTTP ${resp.status}` };
}

const DESCRIPTION =
  "Расписание группы А-11 (БТЭУ): пары дня, неделя, звонки, календарь и экспорт недели в .ics. Утром в 07:30 приходит сводка дня.";
const SHORT_DESCRIPTION = "Расписание группы А-11 БТЭУ: пары, неделя, звонки и календарь.";
const COMMANDS = [
  { command: "start", description: "Приветствие и клавиатура" },
  { command: "help", description: "Что умеет бот" },
];

let failed = 0;

// аватар: multipart, photo — InputProfilePhoto с attach://-ссылкой на файл
try {
  const photo = new Uint8Array(readFileSync(resolve(avatarPath)));
  const form = new FormData();
  form.append("photo", JSON.stringify({ type: "static", photo: "attach://avatar" }));
  form.append("avatar", new Blob([photo], { type: "image/jpeg" }), "avatar.jpg");
  const resp = await fetch(`${base}/setMyProfilePhoto`, { method: "POST", body: form });
  const body = await resp.json().catch(() => null);
  if (body?.ok === true) {
    console.log("[OK] setMyProfilePhoto");
  } else {
    failed += 1;
    console.error("[FAIL] setMyProfilePhoto:", body?.description ?? `HTTP ${resp.status}`);
  }
} catch (e) {
  failed += 1;
  console.error("[FAIL] setMyProfilePhoto:", e.message);
}

const steps = [
  ["setMyDescription", { description: DESCRIPTION }],
  ["setMyShortDescription", { short_description: SHORT_DESCRIPTION }],
  ["setMyCommands", { commands: COMMANDS }],
  ["setChatMenuButton", { menu_button: { type: "commands" } }],
];
for (const [method, params] of steps) {
  const r = await call(method, params);
  if (r.ok) {
    console.log(`[OK] ${method}`);
  } else {
    failed += 1;
    console.error(`[FAIL] ${method}: ${r.error}`);
  }
}

// сверка без секретов: что фактически стоит у бота
const me = await call("getMe");
if (me.ok) {
  const m = me.result;
  console.log(
    `[OK] getMe: @${m.username}, фото: ${m.photo ? "есть" : "нет"}, команды видны через getMyCommands`,
  );
} else {
  failed += 1;
  console.error("[FAIL] getMe:", me.error);
}
const cmd = await call("getMyCommands");
console.log(cmd.ok ? `[OK] getMyCommands: ${cmd.result.map((c) => `/${c.command}`).join(", ")}` : `[FAIL] getMyCommands: ${cmd.error}`);
const desc = await call("getMyDescription");
console.log(desc.ok ? `[OK] getMyDescription: ${JSON.stringify(desc.result.description)}` : `[FAIL] getMyDescription: ${desc.error}`);

process.exit(failed === 0 ? 0 : 1);
