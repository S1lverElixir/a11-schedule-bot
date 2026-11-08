//! Тесты данных расписания: зеркала юнит-тестов rust/src/schedule.rs.
//! Шесть дат таблицы bteu.by руками не менять: разошлись — значит якорь неверен.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Date } from "../src/date.ts";
import {
  ANCHOR_MONDAY,
  BELLS,
  SEMESTER_END,
  SEMESTER_START,
  SUBSTITUTIONS,
  dayPairs,
  dayPairsWith,
  kind,
  subsOn,
  weekMark,
  type Sub,
} from "../src/schedule.ts";

test("якорные даты из официальной таблицы", () => {
  const cases: [readonly [number, number, number], string][] = [
    [[2026, 9, 21], "Under"],
    [[2026, 10, 26], "Over"],
    [[2026, 11, 2], "Under"],
    [[2026, 12, 21], "Over"],
    [[2026, 12, 28], "Under"],
    [[2026, 10, 17], "Over"],
  ];
  for (const [[y, m, d], want] of cases) {
    assert.equal(weekMark(Date.new(y, m, d)!), want, `${y}-${m}-${d}`);
  }
  assert.equal(ANCHOR_MONDAY.fmtIso(), "2026-09-21");
});

test("вне семестра пар нет", () => {
  assert.deepEqual(dayPairs(Date.new(2026, 8, 31)!), []);
  assert.deepEqual(dayPairs(Date.new(2027, 1, 1)!), []);
  assert.ok(dayPairs(Date.new(2026, 9, 1)!).length > 0);
  assert.equal(SEMESTER_START.fmtIso(), "2026-09-01");
  assert.equal(SEMESTER_END.fmtIso(), "2026-12-31");
});

function sub(num: number, start: string, end: string, subj: string): Sub {
  return {
    day: [2026, 11, 5],
    num,
    start,
    end,
    subj,
    rooms: "1-9",
    teachers: ["доц. Кузьменкова И.А."],
  };
}

test("замена заменяет только свой слот", () => {
  const d = Date.new(2026, 11, 5)!;
  const base = dayPairs(d);
  const s = sub(2, "10:50", "12:25", "Консультация по математическому анализу");
  const withSub = dayPairsWith(d, [s]);
  assert.equal(withSub.length, base.length, "замена не меняет число пар дня");
  const p = withSub.find((x) => x.num === 2);
  assert.ok(p, "слот 2 остался");
  assert.equal(p.subj, "Консультация по математическому анализу");
  assert.ok(p.sub, "замена помечена");
  for (const x of withSub.filter((x) => x.num !== 2)) {
    const before = base.find((b) => b.num === x.num);
    assert.ok(before, "та же пара");
    assert.equal(x.subj, before.subj);
    assert.ok(!x.sub);
  }
});

test("замена без времени отменяет слот", () => {
  const d = Date.new(2026, 11, 5)!;
  const base = dayPairs(d);
  const withSub = dayPairsWith(d, [sub(3, "", "", "")]);
  assert.equal(withSub.length, base.length - 1, "отменённая пара исчезает");
  assert.ok(!withSub.some((x) => x.num === 3));
});

test("замена может добавить пару в пустой слот", () => {
  const d = Date.new(2026, 11, 5)!;
  // в под-неделю на четверге первой пары нет — замена её добавляет
  assert.ok(!dayPairs(d).some((p) => p.num === 1));
  const withSub = dayPairsWith(d, [sub(1, "09:00", "10:35", "Пересдача по физкультуре")]);
  const p = withSub[0];
  assert.ok(p, "пара стала первой");
  assert.equal(p.num, 1);
  assert.ok(p.sub);
});

test("замена действует только на свою дату", () => {
  const a = sub(2, "10:50", "12:25", "Консультация");
  const b: Sub = {
    day: [2026, 11, 6],
    num: 4,
    start: "14:40",
    end: "16:15",
    subj: "Пересдача",
    rooms: null,
    teachers: ["доц. Котов И.С."],
  };
  const all = [a, b];
  assert.equal(subsOn(Date.new(2026, 11, 5)!, all).length, 1);
  assert.equal(subsOn(Date.new(2026, 11, 6)!, all).length, 1);
  assert.equal(subsOn(Date.new(2026, 11, 7)!, all).length, 0);
  // и дата вне семестра не получает замен: там и так «пар нет»
  assert.ok(dayPairs(Date.new(2026, 11, 5)!).every((p) => !p.sub));
});

test("константная замена попадает в свой день", () => {
  // 16.12.2026 — среда под-недели: 3-й слот заменён «Часом куратора»
  const d = Date.new(2026, 12, 16)!;
  const pairs = dayPairs(d);
  const third = pairs.find((p) => p.num === 3);
  assert.ok(third);
  assert.equal(third.subj, "Час куратора");
  assert.equal(third.rooms, "3-16");
  assert.ok(third.sub);
  assert.equal(SUBSTITUTIONS.length, 1);
});

test("типы занятий", () => {
  assert.equal(kind("Математический анализ"), "Лекция");
  assert.equal(kind("Физическая культура"), "Практика");
  assert.equal(kind("Информационный час"), "");
  assert.equal(kind("Такого предмета нет"), "");
});

test("звонки: пары 1–5 группы А-11 и два ночных слота", () => {
  assert.equal(BELLS.length, 7);
  assert.equal(BELLS[0].start, "09:00");
  assert.equal(BELLS[6].end, "21:50");
  assert.equal(BELLS[6].br, null);
});
