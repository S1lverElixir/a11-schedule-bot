//! Все текстовые виды бота — чистые функции: строят строку, сети не касаются.
//!
//! Форматы — контракт SPEC.md, а фикстура views.json сверяется байт-в-байт:
//! даже отступы и тире менять нельзя без пересъёмки эталона.

import {
  MONTHS,
  WD_FULL,
  WD_SHORT,
  Date,
  hhMm,
  pad2,
  pad4,
  wdLower,
  type Now,
} from "./date.ts";
import {
  BELLS,
  SEMESTER_END,
  SEMESTER_START,
  cancelledNums,
  dayPairs,
  weekLabel,
  type Pair,
} from "./schedule.ts";

export const BTN_TODAY = "Сегодня";
export const BTN_TOMORROW = "Завтра";
export const BTN_NOW = "Сейчас";
export const BTN_WEEK = "Неделя";
export const BTN_BELLS = "Звонки";
export const BTN_PICK = "Выбрать день";
/// Приветствие /start: короткая шапка и польза, без перечисления всех функций.
export const GREETING =
  "<b>Расписание группы А-11</b>\nДни, неделя, звонки и календарь — кнопками ниже.\n<i>Утром в 07:30 приходит сводка дня.</i>";
/// /help: карта возможностей — единственное место, где перечисление уместно;
/// названия кнопок в «ёлочках», как они выглядят в клавиатуре.
export const HELP_TEXT =
  "<b>Что умеет бот</b>\n«Сегодня» — расписание дня с прогресс-баром, «Завтра» — расписание дня.\n«Сейчас» — что идёт и что дальше.\n«Неделя» — раскладка недели; стрелки листают, «В календарь» даёт .ics.\n«Выбрать день» — календарь на месяц.\n«Звонки» — время звонков и перемен.\n<i>Утром в 07:30 приходит сводка дня.</i>";
/// Ответ на незнакомый текст владельца: короткая подсказка вместо молчания.
export const UNKNOWN_TEXT = "Не понял, кнопки ниже.";
export const PICK_PROMPT = "<b>Выбери день</b>";

/// Экранирование HTML как `html.escape(s)` в Python (включая кавычки).
export function esc(s: string): string {
  let out = "";
  for (const c of s) {
    switch (c) {
      case "&":
        out += "&amp;";
        break;
      case "<":
        out += "&lt;";
        break;
      case ">":
        out += "&gt;";
        break;
      case '"':
        out += "&quot;";
        break;
      case "'":
        out += "&#x27;";
        break;
      default:
        out += c;
    }
  }
  return out;
}

/// «09:50» → минуты от полуночи.
function hm(s: string): number {
  const [h, m] = s.split(":");
  return Number(h) * 60 + Number(m);
}

/// Интервал по-человечески: 45 → «45 мин», 60 → «1 ч», 95 → «1 ч 35 мин».
export function fmtMinutes(m: number): string {
  if (m < 60) return `${m} мин`;
  const h = Math.trunc(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h} ч` : `${h} ч ${rem} мин`;
}

/// Русская форма слова «пара» по числу.
export function pairsWord(n: number): string {
  if (n % 10 === 1 && n % 100 !== 11) return "пара";
  if (n % 10 >= 2 && n % 10 <= 4 && !(n % 100 >= 12 && n % 100 <= 14)) return "пары";
  return "пар";
}

/// Аудитории для вывода: экранирование и пробел после запятой в перечнях.
export function fmtRooms(rooms: string | null): string {
  if (rooms === null || rooms === "") return "";
  return rooms.split(",").map(esc).join(", ");
}

/// Хвост «, ауд. …» для подсказок и строк пар; без аудитории — пусто.
function roomsTail(rooms: string | null): string {
  return rooms !== null && rooms !== "" ? `, ауд. ${fmtRooms(rooms)}` : "";
}

/// Строка пары для компактных видов («Неделя», утренняя сводка):
/// «N (HH:MM) Предмет[, ауд. …][ · замена]».
function pairLine(p: Pair): string {
  const tail = p.sub ? " · замена" : "";
  return `${p.num} (${p.start}) ${subjectTitle(p.subj, p.kind)}${roomsTail(p.rooms)}${tail}`;
}

/// Заголовок предмета с типом занятия через « · »; тип приходит с парой —
/// у одного предмета типы бывают разные (матан: пн практика, вт лекция).
function subjectTitle(subj: string, k: string): string {
  return k === "" ? esc(subj) : `${k} · ${esc(subj)}`;
}

/// HTML-блок пары: жирная строка времени, предмет с аудиторией, преподаватели;
/// note — курсивная приписка (для идущей пары).
function pairBlock(p: Pair, note: string | null): string {
  const rooms = p.rooms !== null && p.rooms !== "";
  const second = rooms
    ? `${subjectTitle(p.subj, p.kind)}, ауд. ${fmtRooms(p.rooms)}`
    : subjectTitle(p.subj, p.kind);
  const teachers = esc(p.teachers.join(", "));
  let text = `<b>${p.num}-я пара ${p.start}–${p.end}</b>${
    p.sub ? "<i> · замена</i>" : ""
  }\n${second}\n${teachers}`;
  if (note !== null) {
    text += `\n<i>${note}</i>`;
  }
  return text;
}

/// Границы учебного дня в минутах — от первой до последней пары.
function daySpan(pairs: readonly Pair[]): [number, number] {
  return [hm(pairs[0]!.start), hm(pairs[pairs.length - 1]!.end)];
}

/// Округление половины к чётному, как `round()` в Python; экспортировано для теста.
export function roundHalfEven(num: number, den: number): number {
  const q = Math.floor(num / den);
  const r = (num - Math.floor(num / den) * den) * 2;
  if (r > den || (r === den && q % 2 !== 0)) {
    return q + 1;
  }
  return q;
}

/// 10-клеточный прогресс учебного дня: ▰ пройдено, ▱ осталось.
function progressBar(pairs: readonly Pair[], minutes: number): string {
  const [s, e] = daySpan(pairs);
  const raw = (minutes - s) * 10;
  const filled = Math.min(
    10,
    Math.max(0, roundHalfEven(raw, Math.max(e - s, 1))),
  );
  let out = "";
  for (let i = 0; i < 10; i++) {
    out += i < filled ? "▰" : "▱";
  }
  return out;
}

/// Строки отмен: «N-я пара отменена», по одной на слот.
export function cancelLines(nums: readonly number[]): string[] {
  return nums.map((n) => `<i>${n}-я пара отменена</i>`);
}

/// Диапазон дня «пары HH:MM–HH:MM»; для сегодня — с прогресс-баром в code-блоке.
function daySpanBlock(pairs: readonly Pair[], minutesNow: number | null): string {
  const rng = `пары ${pairs[0]!.start}–${pairs[pairs.length - 1]!.end}`;
  return minutesNow === null
    ? rng
    : `<code>${progressBar(pairs, minutesNow)}\n${rng}</code>`;
}

/// Статус сегодняшнего дня; границы: момент начала пары — уже пара, конец — уже перемена.
function statusLine(pairs: readonly Pair[], now: number): string {
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i]!;
    const s = hm(p.start);
    const e = hm(p.end);
    if (now < s) {
      if (i === 0) {
        return `до первой пары ${fmtMinutes(s - now)}`;
      }
      return `перемена, до ${p.num}-й пары ${fmtMinutes(s - now)}`;
    }
    if (now < e) {
      return `идёт ${p.num}-я пара, до конца ${fmtMinutes(e - now)}`;
    }
  }
  return "занятия окончены";
}

/// Сообщение одного дня: шапка, черта, диапазон (у сегодня — бар), блоки пар;
/// в пустом дне — подсказка «ближайшая пара», в конце — отменённые слоты.
export function dayText(d: Date, suffix: string, now: Now): string {
  let head = `<b>${WD_FULL[d.weekday()]}, ${d.fmtDmy()}${esc(suffix)}</b>\nНеделя ${weekLabel(d)} чертой`;
  const cancels = cancelLines(cancelledNums(d));
  const pairs = dayPairs(d);
  if (pairs.length === 0) {
    const line = d.equals(now.date) ? "сегодня пар нет" : "пар нет";
    let text = `${head}\n\n<i>${line}</i>`;
    for (const cl of cancels) {
      text += `\n\n${cl}`;
    }
    const next = nextDayFirstPair(d);
    if (next !== null) {
      text += `\n\n<blockquote>${nextPairHint(d, next[0], next[1], true)}</blockquote>`;
    }
    return text;
  }
  const today = d.equals(now.date);
  let status: string | null = null;
  if (today) {
    head += "\n" + daySpanBlock(pairs, now.minute);
    status = statusLine(pairs, now.minute);
  } else {
    head += "\n" + daySpanBlock(pairs, null);
  }
  let text = head;
  let blocks: string[];
  if (
    status !== null &&
    (status === "занятия окончены" ||
      status.startsWith("перемена") ||
      status.startsWith("до первой"))
  ) {
    text += `\n\n<i>${status}</i>`;
    blocks = pairs.map((p) => pairBlock(p, null));
  } else if (status !== null) {
    const running = pairs.findIndex(
      (p) => hm(p.start) <= now.minute && now.minute < hm(p.end),
    );
    blocks = pairs.map((p, i) => {
      if (i === running) {
        const note = `до конца ${fmtMinutes(hm(p.end) - now.minute)}`;
        return pairBlock(p, note);
      }
      return pairBlock(p, null);
    });
  } else {
    blocks = pairs.map((p) => pairBlock(p, null));
  }
  text += "\n\n" + blocks.join("\n\n");
  for (const cl of cancels) {
    text += `\n\n${cl}`;
  }
  return text;
}

/// Первая пара ближайшего дня с парами в пределах недели вперёд.
function nextDayFirstPair(after: Date): [Date, Pair] | null {
  for (let i = 1; i < 8; i++) {
    const d = after.addDays(i);
    const pairs = dayPairs(d);
    if (pairs.length > 0) {
      return [d, pairs[0]!];
    }
  }
  return null;
}

/// Текст-подсказка «завтра: …» / «ближайшая пара: …» без обёртки blockquote.
/// nearest всегда называет день явно — в дне с пометкой «· завтра» второе
/// «завтра» читается как тот же день и путает.
function nextPairHint(d: Date, nd: Date, first: Pair, nearest = false): string {
  const rooms = roomsTail(first.rooms);
  if (!nearest && nd.daysSince(d) === 1) {
    return `завтра: ${first.num}-я пара в ${first.start} — ${esc(first.subj)}${rooms}`;
  }
  return `ближайшая пара: ${wdLower(nd.weekday())}, ${nd.fmtDm()}, ${first.num}-я пара в ${first.start} — ${esc(first.subj)}${rooms}`;
}

/// Кнопка «Сейчас»: что происходит прямо сейчас и что дальше.
export function nowText(now: Now): string {
  const d = now.date;
  let head = `<b>Сейчас ${hhMm(now)} · ${WD_FULL[d.weekday()]}, ${d.fmtDmy()}</b>\nНеделя ${weekLabel(d)} чертой`;
  const pairs = dayPairs(d);
  if (pairs.length === 0) {
    let text = `${head}\n\n<i>сегодня пар нет</i>`;
    const next = nextDayFirstPair(d);
    if (next !== null) {
      text += `\n\n<blockquote>${nextPairHint(d, next[0], next[1])}</blockquote>`;
    }
    return text;
  }
  const running = pairs.findIndex(
    (p) => hm(p.start) <= now.minute && now.minute < hm(p.end),
  );
  const upcoming = pairs.findIndex((p) => now.minute < hm(p.start));
  if (running !== -1 || upcoming !== -1) {
    head += "\n" + daySpanBlock(pairs, now.minute);
  }
  if (running !== -1) {
    const p = pairs[running]!;
    let text = `${head}\n\n${pairBlock(p, null)}\n<i>до конца ${fmtMinutes(hm(p.end) - now.minute)}</i>`;
    if (running + 1 < pairs.length) {
      const nxt = pairs[running + 1]!;
      text += `\n\n<blockquote>дальше: ${nxt.num}-я пара в ${nxt.start} — ${esc(nxt.subj)}${roomsTail(nxt.rooms)}</blockquote>`;
    }
    return text;
  }
  if (upcoming !== -1) {
    const p = pairs[upcoming]!;
    const gap = hm(p.start) - now.minute;
    // та же формулировка, что и статусная строка дня: «10 мин» — это остаток,
    // а не длительность перемены
    const label =
      upcoming === 0 ? "до первой пары" : `перемена, до ${p.num}-й пары`;
    return `${head}\n\n<i>${label} ${fmtMinutes(gap)}</i>\n\n${pairBlock(p, null)}`;
  }
  let text = `${head}\n\n<i>занятия окончены</i>`;
  const next = nextDayFirstPair(d);
  if (next !== null) {
    text += `\n\n<blockquote>${nextPairHint(d, next[0], next[1])}</blockquote>`;
  }
  return text;
}

/// Компактная неделя: шапка и дни жирным, счётчики курсивом, пустые выходные одним блоком.
export function renderWeek(monday: Date, now: Now): string {
  const today = now.date;
  const days: Date[] = [];
  for (let i = 0; i < 7; i++) days.push(monday.addDays(i));
  const lists: Pair[][] = days.map((d) => dayPairs(d));
  const counts: number[] = lists.map((v) => v.length);
  const firstLine = `<b>Неделя ${monday.fmtDm()}–${days[6]!.fmtDm()} · ${weekLabel(monday)} чертой</b>`;
  if (counts.every((c) => c === 0)) {
    // неделя целиком вне семестра: семь «пар нет» — шум
    return `${firstLine}\n\n<i>пар нет</i>`;
  }
  const merged: [string, number[]][] = [];
  let i = 0;
  while (i < 7) {
    if (i === 5 && counts[5] === 0 && counts[6] === 0) {
      merged.push(["Сб–Вс", [5, 6]]);
      i += 2;
    } else {
      merged.push([WD_SHORT[i]!, [i]]);
      i += 1;
    }
  }
  const lines: string[] = [firstLine];
  for (const [wd, idx] of merged) {
    lines.push("");
    const mark = idx.some((k) => days[k]!.equals(today)) ? " · сегодня" : "";
    if (idx.length === 1) {
      lines.push(`<b>${wd} ${days[idx[0]]!.fmtDm()}${mark}</b>`);
    } else {
      // у каждого выходного своё имя рядом с датой — «Сб 14.11 · Вс 15.11»
      lines.push(
        `<b>${WD_SHORT[idx[0]]} ${days[idx[0]]!.fmtDm()} · ${WD_SHORT[idx[1]]} ${days[idx[1]]!.fmtDm()}${mark}</b>`,
      );
    }
    const pairs = lists[idx[0]]!;
    if (pairs.length === 0) {
      lines.push("<i>пар нет</i>");
      continue;
    }
    for (const p of pairs) {
      lines.push(pairLine(p));
    }
    lines.push(`<i>${pairs.length} ${pairsWord(pairs.length)}</i>`);
  }
  return lines.join("\n");
}

/// Компактная неделя, содержащая d.
export function weekText(d: Date, now: Now): string {
  return renderWeek(d.addDays(-d.weekday()), now);
}

/// Пересекается ли месяц с семестром — по этому признаку показываются стрелки.
function monthIntersects(y: number, m: number): boolean {
  const first = Date.new(y, m, 1)!;
  const after = first.nextMonthFirst();
  return (
    first.days() <= SEMESTER_END.days() &&
    after.addDays(-1).days() >= SEMESTER_START.days()
  );
}

/// Inline-клавиатура: строки клеток «текст → callback_data».
interface KbCell {
  text: string;
  callback_data: string;
}

interface InlineKbValue {
  inline_keyboard: KbCell[][];
}

export class InlineKb {
  readonly rows: [string, string][][];

  constructor(rows: [string, string][][]) {
    this.rows = rows;
  }

  /// JSON для Bot API.
  toValue(): InlineKbValue {
    return {
      inline_keyboard: this.rows.map((row) =>
        row.map(([text, data]) => ({ text, callback_data: data })),
      ),
    };
  }
}

function btn(text: string, data: string): [string, string] {
  return [text, data];
}

interface ReplyKbValue {
  keyboard: { text: string }[][];
  resize_keyboard: boolean;
}

/// Постоянная клавиатура: два ряда кнопок.
export function mainKb(): ReplyKbValue {
  return {
    keyboard: [
      [
        { text: BTN_TODAY },
        { text: BTN_TOMORROW },
        { text: BTN_NOW },
        { text: BTN_WEEK },
      ],
      [{ text: BTN_BELLS }, { text: BTN_PICK }],
    ],
    resize_keyboard: true,
  };
}

/// Кнопки под неделей: ‹ | В календарь | ›. Подпись короткая — длинная
/// обрезалась клиентом посреди ряда.
export function weekKb(monday: Date): InlineKb {
  return new InlineKb([
    [
      btn("‹", `wk:${monday.addDays(-7).fmtIso()}`),
      btn("В календарь", `ics:${monday.fmtIso()}`),
      btn("›", `wk:${monday.addDays(7).fmtIso()}`),
    ],
  ]);
}

/// Сетка месяца: шапка со стрелками, дни недели, даты; вне семестра — пустые клетки.
export function calendarKb(y: number, m: number, now: Now): InlineKb {
  const first = Date.new(y, m, 1)!;
  const after = first.nextMonthFirst();
  const head: [string, string][] = [];
  const prev = first.addDays(-1);
  if (monthIntersects(prev.year(), prev.month())) {
    head.push(btn("‹", `cal:${pad4(prev.year())}-${pad2(prev.month())}`));
  }
  head.push(btn(`${MONTHS[m - 1]!} ${y}`, "cal:x"));
  const [ny, nm] = [after.year(), after.month()];
  if (monthIntersects(ny, nm)) {
    head.push(btn("›", `cal:${pad4(ny)}-${pad2(nm)}`));
  }

  const rows: [string, string][][] = [head];
  rows.push(WD_SHORT.map((wd) => btn(wd, "cal:x")));
  const today = now.date;
  let cell = first.addDays(-first.weekday());
  while (cell.days() < after.days()) {
    const row: [string, string][] = [];
    for (let i = 0; i < 7; i++) {
      if (
        cell.month() === m &&
        SEMESTER_START.days() <= cell.days() &&
        cell.days() <= SEMESTER_END.days()
      ) {
        const mark = cell.equals(today) ? "·" : "";
        row.push(
          btn(
            `${mark}${cell.day()}`,
            `cal:${pad4(cell.year())}-${pad2(cell.month())}:${pad2(cell.day())}`,
          ),
        );
      } else {
        row.push(btn(" ", "cal:x"));
      }
      cell = cell.addDays(1);
    }
    rows.push(row);
  }
  return new InlineKb(rows);
}

/// «Звонки» в HTML: дерево — пара целиком, внутри 1-й час, перемена, 2-й час.
export function bellsText(): string {
  const width = Math.max(...BELLS.map((b) => b.end.length));
  const lines: string[] = [];
  for (const b of BELLS) {
    const tail = b.br !== null ? `   перерыв ${b.br}` : "";
    const pad = " ".repeat(width - b.end.length);
    const line = `${b.num}-я  ${b.start}–${b.end}${pad}${tail}`;
    lines.push(line.trimEnd());
    const gap =
      hm(b.second.split("–")[0]!) - hm(b.first.split("–")[1]!);
    lines.push(`├ 1-й час  ${b.first}`);
    lines.push(`├ перемена ${gap} мин`);
    lines.push(`└ 2-й час  ${b.second}`);
  }
  return `<b>Расписание звонков</b>\n<code>${lines.join("\n")}</code>`;
}

/// Утренняя сводка: компактная раскладка дня в одну строку на пару.
export function morningText(d: Date, now: Now): string {
  const head = `<b>Доброе утро · ${WD_FULL[d.weekday()]}, ${d.fmtDmy()}</b>\nНеделя ${weekLabel(d)} чертой`;
  const pairs = dayPairs(d);
  if (pairs.length === 0) {
    let text = `${head}\n\n<i>сегодня пар нет</i>`;
    for (const cl of cancelLines(cancelledNums(d))) {
      text += `\n${cl}`;
    }
    // единообразие с пустым днём: подсказка и здесь
    const next = nextDayFirstPair(d);
    if (next !== null) {
      text += `\n\n<blockquote>${nextPairHint(d, next[0], next[1], true)}</blockquote>`;
    }
    return text;
  }
  const gap = hm(pairs[0]!.start) - now.minute;
  let info = daySpanBlock(pairs, now.minute);
  if (gap > 0) {
    info += `\n\n<i>до первой пары ${fmtMinutes(gap)}</i>`;
  }
  const lines: string[] = [];
  for (const p of pairs) {
    lines.push(pairLine(p));
  }
  let text = `${head}\n${info}\n\n${lines.join("\n")}\n<i>${pairs.length} ${pairsWord(pairs.length)}</i>`;
  for (const cl of cancelLines(cancelledNums(d))) {
    text += `\n${cl}`;
  }
  return text;
}
