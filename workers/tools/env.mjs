//! Разбор .env из корня репозитория, общий для инструментов: BOM, комментарии,
//! export-префикс, парные кавычки. Значения никогда не печатаются.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function readEnv(file = ".env") {
  let text;
  try {
    text = readFileSync(resolve(file), "utf8");
  } catch {
    console.error(".env не найден в корне репозитория");
    process.exit(1);
  }
  const env = {};
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
    if (key !== "") env[key] = value;
  }
  return env;
}
