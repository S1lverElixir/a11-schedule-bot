//! Даты и время без сторонних библиотек.
//!
//! Календарь — арифметика гражданских дат (дни от 1970-01-01), часы — фиксированный
//! UTC+3: на хостинге нет tz-базы, а летнего времени в Минске нет.

/// Дата как число дней от 1970-01-01 (так же считает `date.toordinal` минус константа).
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub struct Date(i32);

/// Дни от 1970-01-01 до гражданской даты (алгоритм Хауарда Хиннанта).
const fn days_from_civil(y: i32, m: u32, d: u32) -> i32 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 } as i32;
    let doy = (153 * mp + 2) / 5 + d as i32 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Обратный переход: гражданская дата по числу дней от 1970-01-01.
fn civil_from_days(z: i32) -> (i32, u32, u32) {
    let z = z + 719468;
    let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn leap(y: i32) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

pub fn days_in_month(y: i32, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap(y) => 29,
        2 => 28,
        _ => 0,
    }
}

impl Date {
    /// Дата для констант: без проверки, потому что проверяет тест.
    pub const fn new_const(y: i32, m: u32, d: u32) -> Date {
        Date(days_from_civil(y, m, d))
    }

    /// Число дней от 1970-01-01.
    pub const fn days(self) -> i32 {
        self.0
    }

    /// Дата из года, месяца и числа; несуществующая дата — None (как `date()` в Python).
    pub fn new(y: i32, m: u32, d: u32) -> Option<Date> {
        if !(1..=12).contains(&m) || d < 1 || d > days_in_month(y, m) {
            return None;
        }
        Some(Date(days_from_civil(y, m, d)))
    }

    pub fn ymd(self) -> (i32, u32, u32) {
        civil_from_days(self.0)
    }

    pub fn year(self) -> i32 {
        self.ymd().0
    }

    pub fn month(self) -> u32 {
        self.ymd().1
    }

    pub fn day(self) -> u32 {
        self.ymd().2
    }

    /// День недели: 0 — понедельник … 6 — воскресенье (как у `date.weekday`).
    pub fn weekday(self) -> u32 {
        (self.0 + 3).rem_euclid(7) as u32
    }

    pub fn add_days(self, n: i32) -> Date {
        Date(self.0 + n)
    }

    /// Разница в днях: само число минус `other`.
    pub fn days_since(self, other: Date) -> i32 {
        self.0 - other.0
    }

    /// «23.10.2026»
    pub fn fmt_dmy(self) -> String {
        let (y, m, d) = self.ymd();
        format!("{d:02}.{m:02}.{y:04}")
    }

    /// «23.10»
    pub fn fmt_dm(self) -> String {
        let (_, m, d) = self.ymd();
        format!("{d:02}.{m:02}")
    }

    /// «2026-10-23» — формат callback_data и разбора дат.
    pub fn fmt_iso(self) -> String {
        let (y, m, d) = self.ymd();
        format!("{y:04}-{m:02}-{d:02}")
    }

    /// «20261023» — формат UID и DTSTART в .ics.
    pub fn fmt_compact(self) -> String {
        let (y, m, d) = self.ymd();
        format!("{y:04}{m:02}{d:02}")
    }

    /// Разбор «2026-10-23».
    pub fn parse_iso(s: &str) -> Option<Date> {
        let b = s.as_bytes();
        if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
            return None;
        }
        let y: i32 = s.get(0..4)?.parse().ok()?;
        let m: u32 = s.get(5..7)?.parse().ok()?;
        let d: u32 = s.get(8..10)?.parse().ok()?;
        Date::new(y, m, d)
    }

    /// Разбор «2026-10» — месяц из callback_data календаря.
    pub fn parse_month(s: &str) -> Option<(i32, u32)> {
        let b = s.as_bytes();
        if b.len() != 7 || b[4] != b'-' {
            return None;
        }
        let y: i32 = s.get(0..4)?.parse().ok()?;
        let m: u32 = s.get(5..7)?.parse().ok()?;
        if !(1..=12).contains(&m) {
            return None;
        }
        Some((y, m))
    }

    /// Первое число следующего месяца.
    pub fn next_month_first(self) -> Date {
        let (y, m) = (self.year(), self.month());
        if m == 12 {
            Date::new(y + 1, 1, 1).unwrap()
        } else {
            Date::new(y, m + 1, 1).unwrap()
        }
    }
}

pub const WD_FULL: [&str; 7] = [
    "Понедельник",
    "Вторник",
    "Среда",
    "Четверг",
    "Пятница",
    "Суббота",
    "Воскресенье",
];

pub const WD_SHORT: [&str; 7] = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

pub const MONTHS: [&str; 12] = [
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
pub fn wd_lower(wd: u32) -> &'static str {
    match wd {
        0 => "понедельник",
        1 => "вторник",
        2 => "среда",
        3 => "четверг",
        4 => "пятница",
        5 => "суббота",
        _ => "воскресенье",
    }
}

/// Местные часы: дата и минуты от полуночи (UTC+3).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Now {
    pub date: Date,
    pub minute: u32,
}

pub const TZ_OFFSET_SECS: i64 = 3 * 3600;

impl Now {
    pub fn from_parts(y: i32, m: u32, d: u32, minute: u32) -> Now {
        Now {
            date: Date::new(y, m, d).expect("дата из данных"),
            minute,
        }
    }

    /// Текущий момент по UTC+3.
    pub fn local() -> Now {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
            + TZ_OFFSET_SECS;
        Now {
            date: Date((secs.div_euclid(86400)) as i32),
            minute: (secs.rem_euclid(86400) / 60) as u32,
        }
    }

    pub fn hh_mm(self) -> String {
        format!("{:02}:{:02}", self.minute / 60, self.minute % 60)
    }

    pub fn seconds_of_day(self) -> i64 {
        self.minute as i64 * 60
    }
}

/// Текущий момент по UTC+3 с точностью до секунды: дата и секунды от полуночи.
pub fn local_now_seconds() -> (Date, u32) {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
        + TZ_OFFSET_SECS;
    (
        Date(secs.div_euclid(86400) as i32),
        secs.rem_euclid(86400) as u32,
    )
}

/// «2026-11-03 20:30:56» по UTC+3 — метка строки лога.
pub fn local_stamp() -> String {
    let (date, secs) = local_now_seconds();
    let (y, m, d) = date.ymd();
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}",
        secs / 3600,
        secs % 3600 / 60,
        secs % 60
    )
}

/// Момент в UTC с точностью до секунды: для DTSTAMP и срока сервера.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub struct Stamp(i64);

impl Stamp {
    pub fn from_unix(secs: i64) -> Stamp {
        Stamp(secs)
    }

    pub fn now() -> Stamp {
        Stamp(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0),
        )
    }

    /// Местный момент (UTC+3) как штамп UTC: так .ics получает DTSTAMP.
    pub fn from_local(date: Date, seconds_of_day: u32) -> Stamp {
        Stamp(date.days() as i64 * 86400 + seconds_of_day as i64 - TZ_OFFSET_SECS)
    }

    pub fn unix(self) -> i64 {
        self.0
    }

    /// «20261023T083456Z»
    pub fn fmt_ics(self) -> String {
        let days = self.0.div_euclid(86400) as i32;
        let rem = self.0.rem_euclid(86400);
        let (y, m, d) = Date(days).ymd();
        format!(
            "{y:04}{m:02}{d:02}T{:02}{:02}{:02}Z",
            rem / 3600,
            rem % 3600 / 60,
            rem % 60
        )
    }
}

/// Разбор `datetime.fromisoformat`-строки вида «2026-11-04T12:00:00+00:00».
/// Возвращает штамп UTC; кривой ввод — None.
pub fn parse_iso_datetime(s: &str) -> Option<Stamp> {
    let s = s.trim();
    let (date_part, rest) = s.split_once(['T', ' '])?;
    let date = Date::parse_iso(date_part)?;
    let (time_part, offset) = split_offset(rest)?;
    let mut it = time_part.split(':');
    let hh: u32 = it.next()?.parse().ok()?;
    let mm: u32 = it.next()?.parse().ok()?;
    let sec_str = it.next().unwrap_or("0");
    let ss: u32 = sec_str.split('.').next()?.parse().ok()?;
    if hh > 23 || mm > 59 || ss > 60 {
        return None;
    }
    let local = date.days() as i64 * 86400 + hh as i64 * 3600 + mm as i64 * 60 + ss as i64;
    Some(Stamp(local - offset))
}

fn split_offset(s: &str) -> Option<(&str, i64)> {
    // «Z» — это UTC, как «+00:00»
    if let Some(stripped) = s.strip_suffix('Z') {
        return Some((stripped, 0));
    }
    let idx = s
        .char_indices()
        .skip(1)
        .find(|(_, c)| *c == '+' || *c == '-')
        .map(|(i, _)| i);
    match idx {
        None => Some((s, 0)),
        Some(i) => {
            let (time, off) = s.split_at(i);
            let sign = if off.starts_with('-') { -1 } else { 1 };
            let body = &off[1..];
            let (h, m) = body.split_once(':').unwrap_or((body, "0"));
            let h: i64 = h.parse().ok()?;
            let m: i64 = m.parse().ok()?;
            Some((time, sign * (h * 3600 + m * 60)))
        }
    }
}
