//! Поведение обработчиков против снимков: на каждое сообщение и нажатие бот
//! обязан сделать ровно те же вызовы Bot API с теми же параметрами.
//!
//! Снимки обработчиков генератора не имеют: замораживаются руками, правятся
//! только вместе с осознанной сменой поведения и с полным диффом перед глазами.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Bot } from "../src/bot.ts";
import { Date, type Now } from "../src/date.ts";
import { deepEqual, Recorder } from "./helpers.ts";

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "./fixtures/handlers.json",
);

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
