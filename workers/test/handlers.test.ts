//! Поведение обработчиков против снимков: на каждое сообщение и нажатие порт
//! обязан сделать ровно те же вызовы Bot API с теми же параметрами.
//!
//! Зеркало rust/tests/handlers.rs: записывающая заглушка вместо сети.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Bot } from "../src/bot.ts";
import { Date, type Now } from "../src/date.ts";
import type { Api } from "../src/telegram.ts";

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../rust/tests/fixtures/handlers.json",
);

class Recorder implements Api {
  calls: { method: string; params: unknown }[] = [];

  async call(method: string, params: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    return null;
  }

  async sendDocument(
    chatId: number,
    filename: string,
    content: Uint8Array,
    caption: string,
  ): Promise<unknown> {
    const text = new TextDecoder().decode(content);
    this.calls.push({
      method: "sendDocument",
      params: { chat_id: chatId, filename, caption, content: text },
    });
    return null;
  }
}

/// «2026-10-23T12:56:00+03:00» → условные часы бота.
function nowOf(s: string): Now {
  const [dateStr, time] = s.split("T");
  const date = Date.parseIso(dateStr ?? "");
  if (date === null) throw new Error(`дата снимка ${s}`);
  const hh = Number((time ?? "").slice(0, 2));
  const mm = Number((time ?? "").slice(3, 5));
  return { date, minute: hh * 60 + mm };
}

function short(v: unknown): string {
  const s = JSON.stringify(v);
  const chars = [...(s ?? "")];
  let out = chars.slice(0, 500).join("");
  if (chars.length > 500) out += "…";
  return out;
}

test("обработчики делают те же вызовы, что и эталон", async () => {
  const doc = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  const cases = doc.cases;
  assert.ok(cases.length >= 60, `случаев подозрительно мало: ${cases.length}`);
  let failedCount = 0;
  const failures: string[] = [];
  for (const c of cases) {
    const recorder = new Recorder();
    const bot = new Bot(recorder, 1);
    const now = nowOf(c.now);
    await bot.handleUpdate(c.update, now);
    const actual = recorder.calls;
    if (!deepEqual(actual, c.calls)) {
      failedCount += 1;
      if (failures.length < 10) {
        failures.push(
          `${c.name}\n  эталон: ${short(c.calls)}\n    порт: ${short(actual)}`,
        );
      }
    }
  }
  assert.equal(
    failedCount,
    0,
    `расхождений: ${failedCount} из ${cases.length}\n${failures.join("\n")}`,
  );
});

/// Структурное равенство: массивы поэлементно, объекты — по набору ключей.
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (a instanceof Object && b instanceof Object) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (!deepEqual(ka, kb)) return false;
    const oa = a as Record<string, unknown>;
    const ob = b as Record<string, unknown>;
    return ka.every((k) => deepEqual(oa[k], ob[k]));
  }
  return false;
}
