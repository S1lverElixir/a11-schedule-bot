//! Даты и время без сторонних библиотек — дословный порт rust/src/date.rs.
//!
//! Календарь — арифметика гражданских дат (дни от 1970-01-01), часы — фиксированный
//! UTC+3: летнего времени в Минске нет, а привязка к tz-базе платформы не нужна.

/// Глобальный конструктор даты: в этом модуле имя Date занято нашим классом.
const GlobalDate = globalThis.Date;

/// Целочисленное деление с усечением к нулю, как `/` над целыми в Rust.
function truncDiv(a: number, b: number): number {
  return Math.trunc(a / b);
}

/// Деление с округлением вниз, как `div_euclid` в Rust.
function divEuclid(a: number, b: number): number {
  return Math.floor(a / b);
}

/// Остаток в смысле `rem_euclid` в Rust: всегда в [0, b).
function remEuclid(a: number, b: number): number {
  return a - Math.floor(a / b) * b;
}

/// Разбор целого как `parse::<i32>` в Rust: необязательный знак, только цифры.
function parseI32(s: string): number | null {
  if (!/^[+-]?\d+$/.test(s)) return null;
  const v = Number(s);
  if (!Number.isSafeInteger(v) || v < -2147483648 || v > 2147483647) return null;
  return v;
}

/// Разбор целого как `parse::<u32>` в Rust: без знака, только цифры.
function parseU32(s: string): number | null {
  if (!/^\d+$/.test(s)) return null;
  const v = Number(s);
  if (!Number.isSafeInteger(v) || v > 4294967295) return null;
  return v;
}

const p2 = (n: number): string => String(n).padStart(2, "0");
const p4 = (n: number): string => String(n).padStart(4, "0");

/// Дни от 1970-01-01 до гражданской даты (алгоритм Хауарда Хиннанта).
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = truncDiv(yy >= 0 ? yy : yy - 399, 400);
  const yoe = yy - era * 400;
  const mp = m > 2 ? m - 3 : m + 9;
  const doy = truncDiv(153 * mp + 2, 5) + d - 1;
  const doe = yoe * 365 + truncDiv(yoe, 4) - truncDiv(yoe, 100) + doy;
  return era * 146097 + doe - 719468;
}

/// Обратный переход: гражданская дата по числу дней от 1970-01-01.
function civilFromDays(z: number): [number, number, number] {
  const zz = z + 719468;
  const era = truncDiv(zz >= 0 ? zz : zz - 146096, 146097);
  const doe = zz - era * 146097;
  const yoe = truncDiv(
    doe - truncDiv(doe, 1460) + truncDiv(doe, 36524) - truncDiv(doe, 146096),
    365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + truncDiv(yoe, 4) - truncDiv(yoe, 100));
  const mp = truncDiv(5 * doy + 2, 153);
  const d = doy - truncDiv(153 * mp + 2, 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [m <= 2 ? y + 1 : y, m, d];
}

function leap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(y: number, m: number): number {
  switch (m) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    case 2:
      return leap(y) ? 29 : 28;
    default:
      return 0;
  }
}

/// Дата как число дней от 1970-01-01.
export class Date {
  private readonly n: number;

  private constructor(n: number) {
    this.n = n;
  }

  /// Дата для констант: без проверки, потому что проверяет тест.
  static newConst(y: number, m: number, d: number): Date {
    return new Date(daysFromCivil(y, m, d));
  }

  /// Дата из года, месяца и числа; несуществующая дата — null.
  static new(y: number, m: number, d: number): Date | null {
    if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
    return new Date(daysFromCivil(y, m, d));
  }

  static parseIso(s: string): Date | null {
    if (s.length !== 10 || s[4] !== "-" || s[7] !== "-") return null;
    const y = parseI32(s.slice(0, 4));
    const m = parseU32(s.slice(5, 7));
    const d = parseU32(s.slice(8, 10));
    if (y === null || m === null || d === null) return null;
    return Date.new(y, m, d);
  }

  /// Разбор «2026-10» — месяц из callback_data календаря.
  static parseMonth(s: string): [number, number] | null {
    if (s.length !== 7 || s[4] !== "-") return null;
    const y = parseI32(s.slice(0, 4));
    const m = parseU32(s.slice(5, 7));
    if (y === null || m === null || m < 1 || m > 12) return null;
    return [y, m];
  }

  days(): number {
    return this.n;
  }

  ymd(): [number, number, number] {
    return civilFromDays(this.n);
  }

  year(): number {
    return this.ymd()[0];
  }

  month(): number {
    return this.ymd()[1];
  }

  day(): number {
    return this.ymd()[2];
  }

  /// День недели: 0 — понедельник … 6 — воскресенье.
  weekday(): number {
    return remEuclid(this.n + 3, 7);
  }

  addDays(n: number): Date {
    return new Date(this.n + n);
  }

  /// Разница в днях: само число минус other.
  daysSince(other: Date): number {
    return this.n - other.n;
  }

  equals(other: Date): boolean {
    return this.n === other.n;
  }

  /// «23.10.2026»
  fmtDmy(): string {
    const [y, m, d] = this.ymd();
    return `${p2(d)}.${p2(m)}.${p4(y)}`;
  }

  /// «23.10»
  fmtDm(): string {
    const [, m, d] = this.ymd();
    return `${p2(d)}.${p2(m)}`;
  }

  /// «2026-10-23» — формат callback_data и разбора дат.
  fmtIso(): string {
    const [y, m, d] = this.ymd();
    return `${p4(y)}-${p2(m)}-${p2(d)}`;
  }

  /// «20261023» — формат UID и DTSTART в .ics.
  fmtCompact(): string {
    const [y, m, d] = this.ymd();
    return `${p4(y)}${p2(m)}${p2(d)}`;
  }

  /// Первое число следующего месяца.
  nextMonthFirst(): Date {
    const [y, m] = [this.year(), this.month()];
    if (m === 12) return Date.new(y + 1, 1, 1)!;
    return Date.new(y, m + 1, 1)!;
  }
}

export const WD_FULL: readonly string[] = [
  "Понедельник",
  "Вторник",
  "Среда",
  "Четверг",
  "Пятница",
  "Суббота",
  "Воскресенье",
];

export const WD_SHORT: readonly string[] = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

export const MONTHS: readonly string[] = [
  "Январь",
  "Февраль",
  "Март",
  "Апрель",
  "Май",
  "Июнь",
  "Июль",
  "Август",
  "Сентябрь",
  "Октябрь",
  "Ноябрь",
  "Декабрь",
];

/// День недели строчными буквами — для подсказки «ближайшая пара: среда, 04.11».
export function wdLower(wd: number): string {
  switch (wd) {
    case 0:
      return "понедельник";
    case 1:
      return "вторник";
    case 2:
      return "среда";
    case 3:
      return "четверг";
    case 4:
      return "пятница";
    case 5:
      return "суббота";
    default:
      return "воскресенье";
  }
}

/// Местные часы: дата и минуты от полуночи (UTC+3).
export interface Now {
  date: Date;
  minute: number;
}

export const TZ_OFFSET_SECS = 3 * 3600;

function wallSeconds(): number {
  return Math.floor(GlobalDate.now() / 1000);
}

/// Текущий момент по UTC+3.
export function nowLocal(): Now {
  const secs = wallSeconds() + TZ_OFFSET_SECS;
  return {
    date: new Date(divEuclid(secs, 86400)),
    minute: Math.trunc(remEuclid(secs, 86400) / 60),
  };
}

export function hhMm(now: Now): string {
  return `${p2(Math.trunc(now.minute / 60))}:${p2(now.minute % 60)}`;
}

/// Текущий момент по UTC+3 с точностью до секунды: дата и секунды от полуночи.
export function localNowSeconds(): [Date, number] {
  const secs = wallSeconds() + TZ_OFFSET_SECS;
  return [new Date(divEuclid(secs, 86400)), remEuclid(secs, 86400)];
}

/// «2026-11-03 20:30:56» по UTC+3 — метка строки лога.
export function localStamp(): string {
  const [date, secs] = localNowSeconds();
  const [y, m, d] = date.ymd();
  return `${p4(y)}-${p2(m)}-${p2(d)} ${p2(Math.trunc(secs / 3600))}:${p2(
    Math.trunc((secs % 3600) / 60),
  )}:${p2(secs % 60)}`;
}

/// Момент в UTC с точностью до секунды: для DTSTAMP.
export class Stamp {
  private readonly n: number;

  private constructor(n: number) {
    this.n = n;
  }

  static fromUnix(secs: number): Stamp {
    return new Stamp(secs);
  }

  static now(): Stamp {
    return new Stamp(wallSeconds());
  }

  /// Местный момент (UTC+3) как штамп UTC: так .ics получает DTSTAMP.
  static fromLocal(date: Date, secondsOfDay: number): Stamp {
    return new Stamp(date.days() * 86400 + secondsOfDay - TZ_OFFSET_SECS);
  }

  unix(): number {
    return this.n;
  }

  /// «20261023T083456Z»
  fmtIcs(): string {
    const days = divEuclid(this.n, 86400);
    const rem = remEuclid(this.n, 86400);
    const [y, m, d] = civilFromDays(days);
    return (
      `${p4(y)}${p2(m)}${p2(d)}T${p2(Math.trunc(rem / 3600))}` +
      `${p2(Math.trunc((rem % 3600) / 60))}${p2(rem % 60)}Z`
    );
  }
}

/// Разбор ISO-строки вида «2026-11-04T12:00:00+00:00». Возвращает штамп UTC; кривой ввод — null.
export function parseIsoDatetime(s: string): Stamp | null {
  const t = s.trim();
  const tIdx = t.indexOf("T");
  const spIdx = t.indexOf(" ");
  const sep =
    tIdx === -1 ? spIdx : spIdx === -1 ? tIdx : Math.min(tIdx, spIdx);
  if (sep <= 0) return null;
  const date = Date.parseIso(t.slice(0, sep));
  if (date === null) return null;
  const off = splitOffset(t.slice(sep + 1));
  if (off === null) return null;
  const [timePart, offset] = off;
  const segs = timePart.split(":");
  const hh = parseU32(segs[0] ?? "");
  const mm = parseU32(segs[1] ?? "");
  if (hh === null || mm === null) return null;
  const secStr = segs.length > 2 ? (segs[2] ?? "") : "0";
  const ss = parseU32(secStr.split(".")[0] ?? "");
  if (ss === null) return null;
  if (hh > 23 || mm > 59 || ss > 60) return null;
  const local = date.days() * 86400 + hh * 3600 + mm * 60 + ss;
  return Stamp.fromUnix(local - offset);
}

function splitOffset(s: string): [string, number] | null {
  // «Z» — это UTC, как «+00:00»
  if (s.endsWith("Z")) return [s.slice(0, -1), 0];
  let idx = -1;
  for (let i = 1; i < s.length; i++) {
    if (s[i] === "+" || s[i] === "-") {
      idx = i;
      break;
    }
  }
  if (idx === -1) return [s, 0];
  const time = s.slice(0, idx);
  const off = s.slice(idx);
  const sign = off.startsWith("-") ? -1 : 1;
  const body = off.slice(1);
  const ci = body.indexOf(":");
  const hs = ci === -1 ? body : body.slice(0, ci);
  const ms = ci === -1 ? "0" : body.slice(ci + 1);
  const h = parseI32(hs);
  const m = parseI32(ms);
  if (h === null || m === null) return null;
  return [time, sign * (h * 3600 + m * 60)];
}
