//! Замороженные снимки поведения прежнего Python-бота: каждый случай из
//! fixtures/views.json пересчитывается Rust-кодом и сравнивается байт-в-байт.
//!
//! Python-эталона в репозитории больше нет, поэтому проверка отвечает на вопрос
//! «Rust не изменил поведение». Расхождение без смены данных — это баг, а не
//! «новый красивый формат»; обновлять снимки можно только вместе с осознанным
//! изменением текстов, и тогда их пересчитывает сам Rust.

use a11_bot::snapshot::value_for;
use serde_json::Value;

const FIXTURE: &str = include_str!("fixtures/views.json");


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
    assert!(
        cases.len() > 7000,
        "снимков подозрительно мало: {}",
        cases.len()
    );
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
