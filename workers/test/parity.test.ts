//! Замороженные снимки поведения бота: каждый случай из views.json пересчитывается
//! портом и сравнивается байт-в-байт. Снимок строит tools-скрипт dump_views.ts —
//! гейт дополнительно сверяет его вывод с фикстурой.
//!
//! Это главная проверка: если порт расходится с эталоном, виноват порт —
//! фикстуры не редактируются.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { caseNames, valueFor } from "../src/snapshot.ts";
import { deepEqual } from "./helpers.ts";

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "./fixtures/views.json",
);

function short(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  const chars = [...s];
  let out = chars.slice(0, 400).join("");
  if (chars.length > 400) out += "…";
  return out.replaceAll("\n", "\\n").replaceAll("\r", "\\r");
}

test("каждый вид совпадает с эталоном байт в байт", () => {
  const doc = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  const cases = doc.cases;
  assert.ok(cases.length > 7000, `снимков подозрительно мало: ${cases.length}`);
  let checked = 0;
  let failed = 0;
  const failures: string[] = [];
  for (const c of cases) {
    const actual = valueFor(c.name);
    checked += 1;
    if (!deepEqual(actual, c.value)) {
      failed += 1;
      if (failures.length < 20) {
        failures.push(
          `${c.name}\n  эталон: ${short(c.value)}\n    порт: ${short(actual)}`,
        );
      } else if (failures.length === 20) {
        failures.push("…");
      }
    }
  }
  assert.equal(
    failed,
    0,
    `расхождений: ${failed} из ${checked}\n${failures.join("\n")}`,
  );
  assert.equal(checked, cases.length);
});

test("перечень имён порта совпадает с эталоном один в один", () => {
  const doc = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  const fixtureNames = doc.cases.map((c: { name: string }) => c.name);
  assert.deepEqual(caseNames(), fixtureNames);
});

test("имена снимков уникальны", () => {
  const doc = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  const seen = new Set<string>();
  for (const c of doc.cases) {
    assert.ok(!seen.has(c.name), `дубль снимка: ${c.name}`);
    seen.add(c.name);
  }
});
