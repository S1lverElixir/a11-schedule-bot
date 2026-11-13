//! Перечисление и вычисление снимков видов — то, чем раньше был gen_views.py.
//!
//! Имена случаев заданы тем же порядком, что и в замороженном эталоне
//! `tests/fixtures/views.json`, поэтому `a11-bot --dump-views` умеет пересобрать
//! эталон после осознанной смены данных или текстов. Паритет-тест берёт значение
//! case по имени отсюда же: тест и снимок не могут разойтись в том, что они сверяют.

use crate::date::{Date, Now, Stamp};
use crate::ics::ics_for_week;
use crate::render::{self, InlineKb};
use crate::schedule::{day_pairs, week_label, Weeks, ANCHOR_MONDAY, SEMESTER_END, SEMESTER_START};
use serde_json::{json, Value};

/// Границы снимков: год вокруг семестра, как в исходном генераторе.
const START: Date = Date::new_const(2026, 5, 1);
const END: Date = Date::new_const(2027, 4, 30);

/// Часы, на которых снимается дневной экран в сам день.
const DAY_HOURS: [(u32, u32); 3] = [(8, 0), (12, 56), (23, 0)];
/// Часы «Сейчас» по всему диапазону.
const NOW_HOURS: [(u32, u32); 10] = [
    (7, 0),
    (8, 30),
    (9, 20),
    (10, 40),
    (12, 56),
    (14, 0),
    (16, 16),
    (18, 5),
    (19, 30),
    (23, 30),
];
/// Границы пар: моменты начала, конца и перемен.
const EDGE_HOURS: [(u32, u32); 19] = [
    (7, 0),
    (8, 59),
    (9, 0),
    (9, 45),
    (9, 49),
    (9, 50),
    (10, 35),
    (10, 36),
    (10, 49),
    (10, 50),
    (12, 54),
    (12, 55),
    (14, 30),
    (14, 40),
    (16, 15),
    (16, 16),
    (16, 25),
    (18, 0),
    (20, 30),
];
const SUFFIXES: [&str; 3] = [" · сегодня", " · завтра", " · <b>x"];
/// «Сегодня», от которого зависит пометка дня в недельном виде.
const WEEK_SHIFTS: [i32; 5] = [0, 2, 6, -30, 400];
const CALENDAR_NOW: [Date; 6] = [
    Date::new_const(2026, 5, 15),
    Date::new_const(2026, 10, 23),
    Date::new_const(2026, 10, 1),
    Date::new_const(2026, 12, 31),
    Date::new_const(2027, 3, 15),
    Date::new_const(2027, 4, 30),
];

fn days(from: Date, to: Date) -> Vec<Date> {
    let mut out = Vec::new();
    let mut d = from;
    while d <= to {
        out.push(d);
        d = d.add_days(1);
    }
    out
}

fn mondays() -> Vec<Date> {
    let mut out = Vec::new();
    let mut m = START.add_days(-(START.weekday() as i32));
    while m <= END {
        out.push(m);
        m = m.add_days(7);
    }
    out
}

fn hm(h: u32, m: u32) -> String {
    format!("{h:02}:{m:02}")
}

fn push(list: &mut Vec<String>, name: String) {
    list.push(name);
}

/// Полный список имён снимков в том порядке, в котором их пишет генератор.
/// Повторы убираются в пользу первого вхождения — как делал Python-скрипт.
pub fn case_names() -> Vec<String> {
    let mut raw: Vec<String> = Vec::with_capacity(8000);
    let all = days(START, END);
    let mons = mondays();

    push(&mut raw, "greeting".to_string());
    push(&mut raw, "help".to_string());
    push(&mut raw, "main_kb".to_string());
    push(&mut raw, "bells".to_string());
    for n in 0..26 {
        push(&mut raw, format!("pairs_word|{n}"));
    }
    for d in &all {
        push(&mut raw, format!("pairs|{}", d.fmt_iso()));
        push(&mut raw, format!("week_mark|{}", d.fmt_iso()));
    }
    for d in &all {
        for (h, m) in DAY_HOURS {
            push(
                &mut raw,
                format!("day_text|{}|{}|", d.fmt_iso(), hm(h, m)),
            );
        }
    }
    // границы пар: базы вокруг краёв семестра и якоря, шаг ±2 дня, без дублей
    let mut edges: Vec<Date> = Vec::new();
    for base in [
        START,
        SEMESTER_START,
        ANCHOR_MONDAY,
        SEMESTER_END.add_days(-6),
        END,
    ] {
        for shift in [-2, -1, 0, 1, 2] {
            edges.push(base.add_days(shift));
        }
    }
    edges.push(ANCHOR_MONDAY.add_days(5));
    edges.push(ANCHOR_MONDAY.add_days(-2));
    let mut seen: Vec<Date> = Vec::new();
    for d in edges {
        if seen.contains(&d) {
            continue;
        }
        seen.push(d);
        for (h, m) in EDGE_HOURS {
            push(&mut raw, format!("day_text|{}|{}|", d.fmt_iso(), hm(h, m)));
            push(&mut raw, format!("now_text|{}|{}", d.fmt_iso(), hm(h, m)));
        }
        for s in SUFFIXES {
            push(&mut raw, format!("day_text|{}|12:00|{s}", d.fmt_iso()));
        }
    }
    for d in &all {
        for (h, m) in NOW_HOURS {
            push(&mut raw, format!("now_text|{}|{}", d.fmt_iso(), hm(h, m)));
        }
    }
    for mon in &mons {
        for shift in WEEK_SHIFTS {
            let now_day = mon.add_days(shift);
            push(&mut raw, format!("week|{}|{}", mon.fmt_iso(), now_day.fmt_iso()));
            push(&mut raw, format!("week_text|{}", now_day.fmt_iso()));
        }
        push(&mut raw, format!("week_kb|{}", mon.fmt_iso()));
    }
    for y in 2026..=2027 {
        let months: Vec<u32> = if y == 2026 {
            (5..=12).collect()
        } else {
            (1..=4).collect()
        };
        for m in months {
            for now_day in CALENDAR_NOW {
                push(
                    &mut raw,
                    format!("calendar_kb|{y:04}-{m:02}|{}", now_day.fmt_iso()),
                );
            }
        }
    }
    for mon in &mons {
        push(&mut raw, format!("ics|{}|123456", mon.fmt_iso()));
    }
    for d in &all {
        push(&mut raw, format!("morning|{}|07:30", d.fmt_iso()));
    }

    let mut out: Vec<String> = Vec::with_capacity(raw.len());
    for name in raw {
        if !out.contains(&name) {
            out.push(name);
        }
    }
    out
}

fn rows_value(kb: &InlineKb) -> Value {
    Value::Array(
        kb.rows
            .iter()
            .map(|row| Value::Array(row.iter().map(|(t, c)| json!({"t": t, "c": c})).collect()))
            .collect(),
    )
}

fn reply_rows_value() -> Value {
    let mk = render::main_kb();
    let rows = mk["keyboard"].as_array().expect("keyboard").clone();
    Value::Array(
        rows.iter()
            .map(|row| {
                Value::Array(
                    row.as_array()
                        .unwrap()
                        .iter()
                        .map(|c| json!({"t": c["text"], "c": ""}))
                        .collect(),
                )
            })
            .collect(),
    )
}

fn now_at(d: Date, hhmm: &str) -> Now {
    let (h, m) = hhmm.split_once(':').unwrap_or(("12", "00"));
    Now {
        date: d,
        minute: h.parse::<u32>().unwrap_or(12) * 60 + m.parse::<u32>().unwrap_or(0),
    }
}

fn date_of(s: &str) -> Date {
    Date::parse_iso(s).unwrap_or_else(|| panic!("дата {s:?} в имени снимка"))
}

/// Значение снимка по его имени — тот же разбор имени, что и в паритет-тесте.
pub fn value_for(name: &str) -> Option<Value> {
    let parts: Vec<&str> = name.split('|').collect();
    let v = match parts[0] {
        "greeting" => Value::String(render::GREETING.to_string()),
        "help" => Value::String(render::HELP_TEXT.to_string()),
        "bells" => Value::String(render::bells_text()),
        "pairs_word" => Value::String(render::pairs_word(parts[1].parse().ok()?).to_string()),
        "main_kb" => reply_rows_value(),
        "week_mark" => Value::String(week_label(date_of(parts[1])).to_string()),
        "pairs" => {
            let d = date_of(parts[1]);
            let list: Vec<Value> = day_pairs(d)
                .iter()
                .map(|p| {
                    json!([
                        p.num,
                        p.start,
                        p.end,
                        p.subj,
                        p.rooms.unwrap_or(""),
                        p.teachers,
                        match p.weeks {
                            Weeks::Both => "both",
                            Weeks::Over => "над",
                            Weeks::Under => "под",
                        },
                        if p.sub { "замена" } else { "" }
                    ])
                })
                .collect();
            Value::Array(list)
        }
        "day_text" => {
            let d = date_of(parts[1]);
            Value::String(render::day_text(d, parts.get(3).copied().unwrap_or(""), now_at(d, parts[2])))
        }
        "now_text" => {
            let d = date_of(parts[1]);
            Value::String(render::now_text(now_at(d, parts[2])))
        }
        "week" => {
            let monday = date_of(parts[1]);
            let now_day = date_of(parts[2]);
            Value::String(render::render_week(monday, now_at(now_day, "12:00")))
        }
        "week_text" => {
            let d = date_of(parts[1]);
            Value::String(render::week_text(d, now_at(d, "12:00")))
        }
        "week_kb" => rows_value(&render::week_kb(date_of(parts[1]))),
        "calendar_kb" => {
            let (y, m) = parts[1].split_once('-')?;
            let now_day = date_of(parts[2]);
            rows_value(&render::calendar_kb(
                y.parse().ok()?,
                m.parse().ok()?,
                now_at(now_day, "12:00"),
            ))
        }
        "ics" => {
            let monday = date_of(parts[1]);
            let t = parts[2];
            let secs = t.get(0..2)?.parse::<u32>().ok()? * 3600
                + t.get(2..4)?.parse::<u32>().ok()? * 60
                + t.get(4..6)?.parse::<u32>().ok()?;
            let stamp = Stamp::from_local(monday, secs);
            Value::String(String::from_utf8(ics_for_week(monday, stamp)).ok()?)
        }
        "morning" => {
            let d = date_of(parts[1]);
            Value::String(render::morning_text(d, now_at(d, parts[2])))
        }
        _ => return None,
    };
    Some(v)
}

/// Вид снимка для поля kind — как его писал генератор.
pub fn kind_of(name: &str) -> &'static str {
    match name.split('|').next().unwrap_or("") {
        "pairs" => "pairs",
        "main_kb" => "reply_kb",
        "week_kb" | "calendar_kb" => "inline_kb",
        "ics" => "bytes",
        _ => "text",
    }
}

/// Готовый документ эталона: те же поля и тот же порядок случаев.
pub fn snapshot_document() -> Value {
    let cases: Vec<Value> = case_names()
        .into_iter()
        .filter_map(|name| {
            let value = value_for(&name)?;
            Some(json!({"name": name, "kind": kind_of(&name), "value": value}))
        })
        .collect();
    json!({
        "generator": "a11-bot --dump-views (rust/src/snapshot.rs)",
        "freeze_default": "2026-10-23T08:00:00+03:00",
        "cases": cases,
    })
}
