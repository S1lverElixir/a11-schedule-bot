//! Тесты календаря: арифметика дат, форматы, строгость разбора.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Date, Stamp, wdLower } from "../src/date.ts";

test("форматирование дат: известные значения", () => {
  const d = Date.parseIso("2026-10-23");
  assert.ok(d);
  assert.equal(d.fmtIso(), "2026-10-23");
  assert.equal(d.fmtDmy(), "23.10.2026");
  assert.equal(d.fmtDm(), "23.10");
  assert.equal(d.fmtCompact(), "20261023");
  assert.equal(d.weekday(), 4, "пятница");
  assert.equal(d.year(), 2026);
  assert.equal(d.month(), 10);
  assert.equal(d.day(), 23);
});

test("понедельник якоря — понедельник", () => {
  const d = Date.parseIso("2026-09-21");
  assert.ok(d);
  assert.equal(d.weekday(), 0);
});

test("несуществующая дата не собирается", () => {
  assert.equal(Date.new(2026, 2, 29), null);
  assert.equal(Date.new(2026, 13, 1), null);
  assert.equal(Date.new(2026, 0, 10), null);
  assert.equal(Date.new(2026, 4, 0), null);
  assert.equal(Date.parseIso("2026-2-23"), null);
  assert.equal(Date.parseIso("2026/10/23"), null);
  assert.equal(Date.parseIso("2026-10-23 "), null);
  assert.equal(Date.parseIso(""), null);
});

test("арифметика дней и разница", () => {
  const a = Date.new(2026, 10, 31)!;
  const b = a.addDays(1);
  assert.equal(b.fmtIso(), "2026-11-01");
  assert.equal(b.daysSince(a), 1);
  assert.equal(a.daysSince(b), -1);
  assert.ok(b.equals(Date.parseIso("2026-11-01")!));
  assert.ok(!a.equals(b));
});

test("переход через месяц и год", () => {
  assert.equal(Date.new(2026, 12, 1)!.nextMonthFirst().fmtIso(), "2027-01-01");
  assert.equal(Date.new(2026, 9, 30)!.nextMonthFirst().fmtIso(), "2026-10-01");
});

test("високосные годы", () => {
  assert.equal(Date.new(2000, 2, 29)!.fmtIso(), "2000-02-29");
  assert.equal(Date.new(1900, 2, 29), null);
  assert.equal(Date.new(2028, 2, 29)!.fmtIso(), "2028-02-29");
});

test("разбор месяца из callback_data", () => {
  assert.deepEqual(Date.parseMonth("2026-10"), [2026, 10]);
  assert.equal(Date.parseMonth("2026-13"), null);
  assert.equal(Date.parseMonth("2026-10x"), null);
  assert.equal(Date.parseMonth("2026-1"), null);
});

test("штампы: формат .ics и перевод местное время в UTC", () => {
  assert.equal(Stamp.fromUnix(0).fmtIcs(), "19700101T000000Z");
  const d = Date.parseIso("2026-10-23")!;
  const s = Stamp.fromLocal(d, 8 * 3600 + 34 * 60 + 56);
  assert.equal(s.fmtIcs(), "20261023T053456Z", "UTC+3 отнят от местного времени");
});

test("дни недели строчными — все семь", () => {
  const days = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"];
  days.forEach((name, wd) => assert.equal(wdLower(wd), name));
});
