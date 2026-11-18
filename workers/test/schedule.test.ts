//! Тесты данных расписания: семестр, черта недели, замены, типы, звонки.
//! Шесть дат таблицы bteu.by руками не менять: разошлись — значит якорь неверен.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Date } from "../src/date.ts";
import {
  ANCHOR_MONDAY,
  dumpSchedule,
  BELLS,
  SEMESTER_END,
  SEMESTER_START,
  SUBSTITUTIONS,
  dayPairs,
  dayPairsWith,
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

test("типы занятий — из регистра предмета в таблице сайта", () => {
  // пн 16.11.2026 (под): матан набран строчными — практика,
  // КИТ капсом и всей группой в 1-2 — лекция
  const mon = dayPairs(Date.new(2026, 11, 16)!);
  assert.equal(mon.find((p) => p.num === 2)!.kind, "Практика");
  assert.equal(mon.find((p) => p.num === 3)!.kind, "Лекция");
  // пн 23.11.2026 (над): ИСТКД строчными — практика, инф. час без типа
  const monOver = dayPairs(Date.new(2026, 11, 23)!);
  assert.equal(monOver.find((p) => p.num === 3)!.kind, "Практика");
  assert.equal(monOver.find((p) => p.num === 4)!.kind, "");
  // вт: матан капсом — лекция, ОАиП на 4-й паре лекция и на 5-й практика
  const tue = dayPairs(Date.new(2026, 11, 17)!);
  assert.equal(tue.find((p) => p.num === 3)!.kind, "Лекция");
  assert.equal(tue.find((p) => p.num === 4)!.kind, "Лекция");
  assert.equal(tue.find((p) => p.num === 5)!.kind, "Практика");
  // сб под-недели: 1-я пара линала лекция, 2-я практика
  const sat = dayPairs(Date.new(2026, 11, 21)!);
  assert.equal(sat.find((p) => p.num === 1)!.kind, "Лекция");
  assert.equal(sat.find((p) => p.num === 2)!.kind, "Практика");
  // замена («Час куратора») без типа
  const wed = dayPairs(Date.new(2026, 12, 16)!);
  assert.ok(wed.some((p) => p.sub && p.kind === ""));
});

test("звонки: пары 1–5 группы А-11 и два ночных слота", () => {
  assert.equal(BELLS.length, 7);
  assert.equal(BELLS[0].start, "09:00");
  assert.equal(BELLS[6].end, "21:50");
  assert.equal(BELLS[6].br, null);
});

test("dumpSchedule: форма данных для сверки с сайтом", () => {
  const doc = dumpSchedule() as Record<string, unknown>;
  assert.deepEqual(Object.keys(doc).sort(), [
    "anchor_monday", "bells", "days", "semester", "substitutions",
  ]);
  assert.deepEqual(doc["semester"], ["2026-09-01", "2026-12-31"]);
  assert.equal(doc["anchor_monday"], "2026-09-21");
  const days = doc["days"] as Record<string, unknown>[][];
  assert.equal(days.length, 7);
  assert.deepEqual(Object.keys(days[0][0]).sort(), [
    "end", "kind", "num", "rooms", "start", "subj", "teachers", "weeks",
  ]);
  const subs = doc["substitutions"] as Record<string, unknown>[];
  assert.equal(subs.length, 1);
  assert.equal(subs[0]!["date"], "2026-12-16");
  assert.deepEqual(Object.keys(subs[0]!).sort(), [
    "date", "end", "num", "rooms", "start", "subj", "teachers",
  ]);
  const bells = doc["bells"] as Record<string, unknown>[];
  assert.equal(bells.length, 7);
  assert.deepEqual(Object.keys(bells[0]).sort(), [
    "break", "end", "first", "num", "second", "start",
  ]);
});
