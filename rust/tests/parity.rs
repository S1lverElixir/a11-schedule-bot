//! Паритет с прежним Python-ботом: каждый снимок из fixtures/views.json
//! пересчитывается Rust-кодом и сравнивается байт-в-байт.
//!
//! Снимки создаёт rust/tools/gen_views.py, когда меняются данные или SPEC.md;
//! расхождение — это баг переписки, а не «новый красивый формат».

use a11_bot::date::{Date, Now, Stamp};
use a11_bot::ics::ics_for_week;
use a11_bot::render::{self, InlineKb};
use a11_bot::schedule::{day_pairs, week_label, Weeks};
use serde_json::{json, Value};

const FIXTURE: &str = include_str!("fixtures/views.json");

fn now_at(d: Date, hhmm: &str) -> Now {
    let (h, m) = hhmm.split_once(':').expect("HH:MM");
    Now {
        date: d,
        minute: h.parse::<u32>().unwrap() * 60 + m.parse::<u32>().unwrap(),
    }
}

fn date_of(s: &str) -> Date {
    Date::parse_iso(s).or_else(|| {
        // неделя в снимках записана как YYYY-MM-DD, как и всё остальное
        None
    }).unwrap_or_else(|| panic!("дата {s:?}"))
}

fn rows_value(kb: &InlineKb) -> Value {
    Value::Array(
        kb.rows
            .iter()
            .map(|row| {
                Value::Array(
                    row.iter()
                        .map(|(t, c)| json!({"t": t, "c": c}))
                        .collect(),
                )
            })
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

/// Значение, которое снимок должен содержать для случая с таким именем.
fn value_for(name: &str) -> Option<Value> {
    let parts: Vec<&str> = name.split('|').collect();
    let v = match parts[0] {
        "greeting" => Value::String(render::GREETING.to_string()),
        "bells" => Value::String(render::bells_text()),
        "pairs_word" => Value::String(render::pairs_word(parts[1].parse().unwrap()).to_string()),
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
                        }
                    ])
                })
                .collect();
            Value::Array(list)
        }
        "day_text" => {
            let d = date_of(parts[1]);
            Value::String(render::day_text(d, parts[3], now_at(d, parts[2])))
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
            let (y, m) = parts[1].split_once('-').unwrap();
            let now_day = date_of(parts[2]);
            rows_value(&render::calendar_kb(
                y.parse().unwrap(),
                m.parse().unwrap(),
                now_at(now_day, "12:00"),
            ))
        }
        "ics" => {
            let monday = date_of(parts[1]);
            let t = parts[2];
            let secs = t.get(0..2).unwrap().parse::<u32>().unwrap() * 3600
                + t.get(2..4).unwrap().parse::<u32>().unwrap() * 60
                + t.get(4..6).unwrap().parse::<u32>().unwrap();
            let stamp = Stamp::from_local(monday, secs);
            Value::String(String::from_utf8(ics_for_week(monday, stamp)).unwrap())
        }
        "morning" => {
            let d = date_of(parts[1]);
            Value::String(render::morning_text(d, now_at(d, parts[2])))
        }
        other => panic!("неизвестный вид снимка: {other}"),
    };
    Some(v)
}

fn short(v: &Value) -> String {
    let s = match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    let mut out: String = s.chars().take(400).collect();
    if s.chars().count() > 400 {
        out.push('…');
    }
    out.replace('\n', "\\n").replace('\r', "\\r")
}

#[test]
fn every_view_matches_python_bot_byte_for_byte() {
    let doc: Value = serde_json::from_str(FIXTURE).expect("фикстура — это JSON");
    let cases = doc["cases"].as_array().expect("cases");
    assert!(cases.len() > 7000, "снимков подозрительно мало: {}", cases.len());
    let mut checked = 0usize;
    let mut failed = 0usize;
    let mut failures: Vec<String> = Vec::new();
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let expected = &case["value"];
        let actual = value_for(name).expect("вид снимка");
        checked += 1;
        if &actual != expected {
            failed += 1;
            if failures.len() < 20 {
                failures.push(format!(
                    "{name}\n  python: {}\n    rust: {}",
                    short(expected),
                    short(&actual)
                ));
            } else if failures.len() == 20 {
                failures.push("…".to_string());
            }
        }
    }
    assert!(
        failed == 0,
        "расхождений: {failed} из {checked}\n{}",
        failures.join("\n")
    );
    assert_eq!(checked, cases.len());
}

#[test]
fn snapshot_names_are_unique() {
    let doc: Value = serde_json::from_str(FIXTURE).unwrap();
    let mut seen = std::collections::BTreeSet::new();
    for case in doc["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        assert!(seen.insert(name.to_string()), "дубль снимка: {name}");
    }
}
