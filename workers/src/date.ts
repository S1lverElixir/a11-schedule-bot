//! Даты и время без сторонних библиотек.
//!
//! Календарь — арифметика гражданских дат (дни от 1970-01-01), часы — фиксированный
//! UTC+3: летнего времени в Минске нет, а привязка к tz-базе платформы не нужна.

/// Глобальный конструктор даты: в этом модуле имя Date занято нашим классом.
const GlobalDate = globalThis.Date;

/// Целочисленное деление с усечением к нулю — не то же, что floor на отрицательных.
function truncDiv(a: number, b: number): number {
  return Math.trunc(a / b);
}

/// Деление с округлением вниз: на отрицательных — к минус бесконечности.
function divEuclid(a: number, b: number): number {
  return Math.floor(a / b);
}

/// Остаток, всегда в [0, b) — в том числе для отрицательного делимого.
function remEuclid(a: number, b: number): number {
  return a - Math.floor(a / b) * b;
}

/// Разбор целого: необязательный знак, только цифры, границы i32.
function parseI32(s: string): number | null {
  if (!/^[+-]?\d+$/.test(s)) return null;
  const v = Number(s);
  if (!Number.isSafeInteger(v) || v < -2147483648 || v > 2147483647) return null;
  return v;
}

/// Разбор целого: без знака, только цифры, границы u32.
function parseU32(s: string): number | null {
  if (!/^\d+$/.test(s)) return null;
  const v = Number(s);
  if (!Number.isSafeInteger(v) || v > 4294967295) return null;
  return v;
}

const p2 = (n: number): string => String(n).padStart(2, "0");
const p4 = (n: number): string => String(n).padStart(4, "0");
export { p2 as pad2, p4 as pad4 };

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

/// Обратный переход, тоже алгоритм Хиннанта: условный сдвиг эры перед делением
/// держит отсечения на границах веков — без него ломаются даты раньше 1 марта 0 года.
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

function daysInMonth(y: number, m: number): number {
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

  /// Дата по числу дней от 1970-01-01 — шов для nowLocal/localStamp в этом модуле.
  static fromDays(n: number): Date {
    return new Date(n);
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

const TZ_OFFSET_SECS = 3 * 3600;

function wallSeconds(): number {
  return Math.floor(GlobalDate.now() / 1000);
}

/// Текущий момент по UTC+3.
export function nowLocal(): Now {
  const secs = wallSeconds() + TZ_OFFSET_SECS;
  return {
    date: Date.fromDays(divEuclid(secs, 86400)),
    minute: Math.trunc(remEuclid(secs, 86400) / 60),
  };
}

export function hhMm(now: Now): string {
  return `${p2(Math.trunc(now.minute / 60))}:${p2(now.minute % 60)}`;
}

/// Текущий момент по UTC+3 с точностью до секунды: дата и секунды от полуночи.
function localNowSeconds(): [Date, number] {
  const secs = wallSeconds() + TZ_OFFSET_SECS;
  return [Date.fromDays(divEuclid(secs, 86400)), remEuclid(secs, 86400)];
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

  /// Конструктор для тестов: детерминированный штамп вместо часов.
  static fromUnix(secs: number): Stamp {
    return new Stamp(secs);
  }

  /// Местный момент (UTC+3) как штамп UTC: так .ics получает DTSTAMP.
  static fromLocal(date: Date, secondsOfDay: number): Stamp {
    return new Stamp(date.days() * 86400 + secondsOfDay - TZ_OFFSET_SECS);
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
