//! Замороженные снимки поведения прежнего Python-бота: каждый случай из
//! rust/tests/fixtures/views.json пересчитывается портом и сравнивается байт-в-байт.
//!
//! Это главная проверка переноса: если порт расходится с эталоном, виноват порт —
//! фикстуры не редактируются.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { caseNames, valueFor } from "../src/snapshot.ts";

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../rust/tests/fixtures/views.json",
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

/// Структурное равенство значений снимков: строки — байт в байт.
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
