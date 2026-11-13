//! Стоп/старт контейнера fps.ms через API панели — только для переключения
//! на Workers и отката. Честное продление это не заменяет и не автоматизирует.
//! Ключ и UUID читает из .env и не печатает; панель за Cloudflare отвечает
//! только браузерному User-Agent, поэтому вызывается curl с браузерным UA.
//!
//! Запуск из корня репозитория: node workers/tools/panel_power.mjs stop|start|restart

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const signal = process.argv[2];
if (!["stop", "start", "restart"].includes(signal)) {
  console.error("аргумент: stop | start | restart");
  process.exit(1);
}

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
    map[kv[0].trim()] = kv.slice(1).join("=").trim().replace(/^["']|["']$/g, "");
  }
  return map;
}

const env = readEnv();
if (!env.FPSMS_API_KEY || !env.FPSMS_SERVER_UUID) {
  console.error("в .env нет FPSMS_API_KEY или FPSMS_SERVER_UUID");
  process.exit(1);
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";
const url = `https://panel.fps.ms/api/client/servers/${env.FPSMS_SERVER_UUID}/power`;
const r = spawnSync(
  "curl",
  [
    "-sf",
    "--max-time",
    "30",
    "-X",
    "POST",
    url,
    "-H",
    `Authorization: Bearer ${env.FPSMS_API_KEY}`,
    "-H",
    `User-Agent: ${UA}`,
    "-H",
    "Content-Type: application/json",
    "-d",
    JSON.stringify({ signal }),
  ],
  { encoding: "utf8", timeout: 45_000 },
);
if (r.status !== 0) {
  console.error(`[FAIL] панель: curl код ${r.status}`);
  process.exit(1);
}
console.log(`[OK] сигнал ${signal} отправлен`);
