//! Тесты .ics: зеркала юнит-тестов rust/src/ics.rs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Date, Stamp } from "../src/date.ts";
import { icsForWeek } from "../src/ics.ts";
import { dayPairs, weekMark } from "../src/schedule.ts";

test("неделя якоря после таблицы — над чертой", () => {
  assert.equal(weekMark(Date.new(2026, 9, 21)!), "Under");
  assert.equal(weekMark(Date.new(2026, 10, 26)!), "Over");
});

test("ics: CRLF и событие на каждую пару", () => {
  const monday = Date.new(2026, 10, 26)!;
  const text = icsForWeek(monday, Stamp.fromUnix(0));
  const pairs = [0, 1, 2, 3, 4, 5, 6].map((i) =>
    dayPairs(monday.addDays(i)).length,
  ).reduce((a, b) => a + b, 0);
  assert.equal(text.split("BEGIN:VEVENT").length - 1, pairs);
  assert.ok(text.endsWith("END:VCALENDAR\r\n"));
  assert.ok(!text.includes("\n\n"));
});

test("ics: DTSTAMP в UTC, DTSTART плавающее локальное", () => {
  const monday = Date.new(2026, 10, 26)!;
  // местные 08:00 UTC+3 → DTSTAMP 05:00Z
  const text = icsForWeek(monday, Stamp.fromLocal(monday, 8 * 3600));
  assert.ok(text.includes("DTSTAMP:20261026T050000Z"));
  assert.ok(text.includes("DTSTART:20261026T090000"));
  assert.ok(!text.includes("DTSTART:20261026T090000Z"));
});

test("ics: фолдинг длинных строк по 75 октетов без разрыва UTF-8", () => {
  const monday = Date.new(2026, 10, 26)!;
  const text = icsForWeek(monday, Stamp.fromUnix(0));
  for (const line of text.split("\r\n")) {
    assert.ok(
      Buffer.byteLength(line, "utf8") <= 75,
      `строка длиннее 75 октетов: ${line.slice(0, 80)}`,
    );
  }
});
