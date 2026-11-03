//! Поведение обработчиков против снимков Python-бота: на каждое сообщение и нажатие
//! Rust обязан сделать ровно те же вызовы Bot API с теми же параметрами.
//!
//! Это закрывает дыру старой проверки: там обработчики не вызывались вообще, и зелёный
//! цвет означал только «рендеры собираются».

use a11_bot::bot::Bot;
use a11_bot::date::{Date, Now};
use a11_bot::telegram::Api;
use serde_json::{json, Value};
use std::cell::RefCell;

const FIXTURE: &str = include_str!("fixtures/handlers.json");

#[derive(Default)]
struct Recorder {
    calls: RefCell<Vec<Value>>,
}

impl Recorder {
    fn take(&self) -> Value {
        Value::Array(self.calls.borrow().clone())
    }
}

impl Api for &Recorder {
    fn call(&self, method: &str, params: &Value) -> Result<Value, String> {
        self.calls
            .borrow_mut()
            .push(json!({"method": method, "params": params}));
        Ok(Value::Null)
    }

    fn send_document(
        &self,
        chat_id: i64,
        filename: &str,
        content: &[u8],
        caption: &str,
    ) -> Result<Value, String> {
        let text = String::from_utf8_lossy(content).to_string();
        self.calls.borrow_mut().push(json!({
            "method": "sendDocument",
            "params": {
                "chat_id": chat_id,
                "filename": filename,
                "caption": caption,
                "content": text
            }
        }));
        Ok(Value::Null)
    }
}

/// «2026-10-23T12:56:00+03:00» → условные часы бота.
fn now_of(s: &str) -> Now {
    let (date, time) = s.split_once('T').expect("дата и время");
    let date = Date::parse_iso(date).expect("дата снимка");
    let hh: u32 = time.get(0..2).unwrap().parse().unwrap();
    let mm: u32 = time.get(3..5).unwrap().parse().unwrap();
    Now {
        date,
        minute: hh * 60 + mm,
    }
}

fn short(v: &Value) -> String {
    let s = v.to_string();
    let mut out: String = s.chars().take(500).collect();
    if s.chars().count() > 500 {
        out.push('…');
    }
    out
}

#[test]
fn handlers_make_the_same_calls_as_python_bot() {
    let doc: Value = serde_json::from_str(FIXTURE).expect("фикстура — JSON");
    let cases = doc["cases"].as_array().expect("cases");
    assert!(cases.len() >= 60, "случаев подозрительно мало: {}", cases.len());
    let mut failed: Vec<String> = Vec::new();
    let mut failed_count = 0usize;
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let recorder = Recorder::default();
        let bot = Bot {
            api: &recorder,
            owner_id: 1,
        };
        let now = now_of(case["now"].as_str().expect("now"));
        bot.handle_update(&case["update"], now);
        let actual = recorder.take();
        let expected = &case["calls"];
        if &actual != expected {
            failed_count += 1;
            if failed.len() < 10 {
                failed.push(format!(
                    "{name}\n  python: {}\n    rust: {}",
                    short(expected),
                    short(&actual)
                ));
            }
        }
    }
    assert!(
        failed_count == 0,
        "расхождений: {failed_count} из {}\n{}",
        cases.len(),
        failed.join("\n")
    );
}
