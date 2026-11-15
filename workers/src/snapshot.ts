//! Перечисление и вычисление снимков видов — множество случаев, по которым бот
//! сверяется с замороженным эталоном.
//!
//! Имена случаев заданы тем же порядком, что и в замороженном эталоне
//! `workers/test/fixtures/views.json`, поэтому паритет-тест сверяет код с эталоном
//! по одному и тому же списку: тест и снимок не могут разойтись в том, что они сверяют.

import { Date, Stamp, type Now } from "./date.ts";
import { icsForWeek } from "./ics.ts";
import {
  GREETING,
  HELP_TEXT,
  InlineKb,
  bellsText,
  calendarKb,
  dayText,
  mainKb,
  morningText,
  nowText,
  pairsWord,
  renderWeek,
  weekKb,
  weekText,
} from "./render.ts";
import {
  ANCHOR_MONDAY,
  SEMESTER_END,
  SEMESTER_START,
  dayPairs,
  weekLabel,
  weeksLabel,
} from "./schedule.ts";

/// Границы снимков: год вокруг семестра, как в замороженном эталоне.
const START = Date.newConst(2026, 5, 1);
const END = Date.newConst(2027, 4, 30);

/// Часы, на которых снимается дневной экран в сам день.
const DAY_HOURS: readonly [number, number][] = [
  [8, 0],
  [12, 56],
  [23, 0],
];
/// Часы «Сейчас» по всему диапазону.
const NOW_HOURS: readonly [number, number][] = [
  [7, 0],
  [8, 30],
  [9, 20],
  [10, 40],
  [12, 56],
  [14, 0],
  [16, 16],
  [18, 5],
  [19, 30],
  [23, 30],
];
/// Границы пар: моменты начала, конца и перемен.
const EDGE_HOURS: readonly [number, number][] = [
  [7, 0],
  [8, 59],
  [9, 0],
  [9, 45],
  [9, 49],
  [9, 50],
  [10, 35],
  [10, 36],
  [10, 49],
  [10, 50],
  [12, 54],
  [12, 55],
  [14, 30],
  [14, 40],
  [16, 15],
  [16, 16],
  [16, 25],
  [18, 0],
  [20, 30],
];
const SUFFIXES: readonly string[] = [" · сегодня", " · завтра", " · <b>x"];
/// «Сегодня», от которого зависит пометка дня в недельном виде.
const WEEK_SHIFTS: readonly number[] = [0, 2, 6, -30, 400];
const CALENDAR_NOW: readonly Date[] = [
  Date.newConst(2026, 5, 15),
  Date.newConst(2026, 10, 23),
  Date.newConst(2026, 10, 1),
  Date.newConst(2026, 12, 31),
  Date.newConst(2027, 3, 15),
  Date.newConst(2027, 4, 30),
];

function days(from: Date, to: Date): Date[] {
  const out: Date[] = [];
  let d = from;
  while (d.days() <= to.days()) {
    out.push(d);
    d = d.addDays(1);
  }
  return out;
}

function mondays(): Date[] {
  const out: Date[] = [];
  let m = START.addDays(-START.weekday());
  while (m.days() <= END.days()) {
    out.push(m);
    m = m.addDays(7);
  }
  return out;
}

function hm(h: number, m: number): string {
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/// Полный список имён снимков в том порядке, в котором их записывает фикстура.
/// Повторы убираются в пользу первого вхождения — порядок обязан совпасть с ней.
export function caseNames(): string[] {
  const raw: string[] = [];
  const push = (name: string) => raw.push(name);
  const all = days(START, END);
  const mons = mondays();

  push("greeting");
  push("help");
  push("main_kb");
  push("bells");
  for (let n = 0; n < 26; n++) {
    push(`pairs_word|${n}`);
  }
  for (const d of all) {
    push(`pairs|${d.fmtIso()}`);
    push(`week_mark|${d.fmtIso()}`);
  }
  for (const d of all) {
    for (const [h, m] of DAY_HOURS) {
      push(`day_text|${d.fmtIso()}|${hm(h, m)}|`);
    }
  }
  // границы пар: базы вокруг краёв семестра и якоря, шаг ±2 дня, без дублей
  const edges: Date[] = [];
  for (const base of [
    START,
    SEMESTER_START,
    ANCHOR_MONDAY,
    SEMESTER_END.addDays(-6),
    END,
  ]) {
    for (const shift of [-2, -1, 0, 1, 2]) {
      edges.push(base.addDays(shift));
    }
  }
  edges.push(ANCHOR_MONDAY.addDays(5));
  edges.push(ANCHOR_MONDAY.addDays(-2));
  const seen: number[] = [];
  for (const d of edges) {
    if (seen.includes(d.days())) {
      continue;
    }
    seen.push(d.days());
    for (const [h, m] of EDGE_HOURS) {
      push(`day_text|${d.fmtIso()}|${hm(h, m)}|`);
      push(`now_text|${d.fmtIso()}|${hm(h, m)}`);
    }
    for (const s of SUFFIXES) {
      push(`day_text|${d.fmtIso()}|12:00|${s}`);
    }
  }
  for (const d of all) {
    for (const [h, m] of NOW_HOURS) {
      push(`now_text|${d.fmtIso()}|${hm(h, m)}`);
    }
  }
  for (const mon of mons) {
    for (const shift of WEEK_SHIFTS) {
      const nowDay = mon.addDays(shift);
      push(`week|${mon.fmtIso()}|${nowDay.fmtIso()}`);
      push(`week_text|${nowDay.fmtIso()}`);
    }
    push(`week_kb|${mon.fmtIso()}`);
  }
  for (let y = 2026; y <= 2027; y++) {
    const months: number[] =
      y === 2026
        ? [5, 6, 7, 8, 9, 10, 11, 12]
        : [1, 2, 3, 4];
    for (const m of months) {
      for (const nowDay of CALENDAR_NOW) {
        push(`calendar_kb|${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}|${nowDay.fmtIso()}`);
      }
    }
  }
  for (const mon of mons) {
    push(`ics|${mon.fmtIso()}|123456`);
  }
  for (const d of all) {
    push(`morning|${d.fmtIso()}|07:30`);
  }

  const out: string[] = [];
  for (const name of raw) {
    if (!out.includes(name)) {
      out.push(name);
    }
  }
  return out;
}

function rowsValue(kb: InlineKb): unknown {
  return kb.rows.map((row) => row.map(([t, c]) => ({ t, c })));
}

function replyRowsValue(): unknown {
  const mk = mainKb();
  return mk.keyboard.map((row) =>
    row.map((c) => ({ t: c.text, c: "" })),
  );
}

function nowAt(d: Date, hhmm: string): Now {
  const ci = hhmm.indexOf(":");
  const hs = ci === -1 ? "12" : hhmm.slice(0, ci);
  const ms = ci === -1 ? "00" : hhmm.slice(ci + 1);
  const h = /^\d+$/.test(hs) ? Number(hs) : 12;
  const m = /^\d+$/.test(ms) ? Number(ms) : 0;
  return { date: d, minute: h * 60 + m };
}

function dateOf(s: string): Date {
  const d = Date.parseIso(s);
  if (d === null) throw new Error(`дата ${s} в имени снимка`);
  return d;
}

/// Значение снимка по его имени — тот же разбор имени, что и в паритет-тесте.
/// null означает «случай не вычисляется»: в документ эталона он не попадает.
export function valueFor(name: string): unknown {
  const parts = name.split("|");
  switch (parts[0]) {
    case "greeting":
      return GREETING;
    case "help":
      return HELP_TEXT;
    case "bells":
      return bellsText();
    case "pairs_word": {
      const n = /^\d+$/.test(parts[1] ?? "") ? Number(parts[1]) : null;
      return n === null ? null : pairsWord(n);
    }
    case "main_kb":
      return replyRowsValue();
    case "week_mark":
      return weekLabel(dateOf(parts[1]!));
    case "pairs": {
      const d = dateOf(parts[1]!);
      return dayPairs(d).map((p) => [
        p.num,
        p.start,
        p.end,
        p.subj,
        p.rooms ?? "",
        p.teachers,
        weeksLabel(p.weeks),
        p.sub ? "замена" : "",
      ]);
    }
    case "day_text": {
      const d = dateOf(parts[1]!);
      return dayText(d, parts[3] ?? "", nowAt(d, parts[2] ?? ""));
    }
    case "now_text": {
      const d = dateOf(parts[1]!);
      return nowText(nowAt(d, parts[2]!));
    }
    case "week": {
      const monday = dateOf(parts[1]!);
      const nowDay = dateOf(parts[2]!);
      return renderWeek(monday, nowAt(nowDay, "12:00"));
    }
    case "week_text": {
      const d = dateOf(parts[1]!);
      return weekText(d, nowAt(d, "12:00"));
    }
    case "week_kb":
      return rowsValue(weekKb(dateOf(parts[1]!)));
    case "calendar_kb": {
      const ym = (parts[1] ?? "").split("-");
      const y = Number(ym[0]);
      const m = Number(ym[1]);
      const nowDay = dateOf(parts[2]!);
      return rowsValue(calendarKb(y, m, nowAt(nowDay, "12:00")));
    }
    case "ics": {
      const monday = dateOf(parts[1]!);
      const t = parts[2] ?? "";
      const secs =
        Number(t.slice(0, 2)) * 3600 + Number(t.slice(2, 4)) * 60 + Number(t.slice(4, 6));
      const stamp = Stamp.fromLocal(monday, secs);
      return icsForWeek(monday, stamp);
    }
    case "morning": {
      const d = dateOf(parts[1]!);
      return morningText(d, nowAt(d, parts[2]!));
    }
    default:
      return null;
  }
}

/// Вид снимка для поля kind — как его писал генератор.
export function kindOf(name: string): string {
  switch (name.split("|")[0]) {
    case "pairs":
      return "pairs";
    case "main_kb":
      return "reply_kb";
    case "week_kb":
    case "calendar_kb":
      return "inline_kb";
    case "ics":
      return "bytes";
    default:
      return "text";
  }
}

/// Готовый документ эталона: те же поля и тот же порядок случаев.
/// dump_views.ts подставляет своё имя генератора; форма полей — как в фикстуре.
export function snapshotDocument(): object {
  const cases: object[] = [];
  for (const name of caseNames()) {
    const value = valueFor(name);
    if (value === null) continue;
    cases.push({ name, kind: kindOf(name), value });
  }
  return {
    generator: "node workers/tools/dump_views.ts",
    freeze_default: "2026-10-23T08:00:00+03:00",
    cases,
  };
}
