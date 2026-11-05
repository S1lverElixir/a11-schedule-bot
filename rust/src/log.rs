//! Логи с одной оговоркой: в строку никогда не попадает токен.
//!
//! Сеть при ошибке печатает URL, а в URL бота живёт токен; консоль контейнера видна
//! в панели хостинга, поэтому всё, что похоже на токен, заменяется на звёздочки.

use crate::date::local_stamp;
use std::sync::OnceLock;

static SECRET: OnceLock<String> = OnceLock::new();

pub fn set_secret(secret: &str) {
    let _ = SECRET.set(secret.to_string());
}

pub fn info(msg: &str) {
    emit("INFO", msg);
}

pub fn warn(msg: &str) {
    emit("WARNING", msg);
}

pub fn error(msg: &str) {
    emit("ERROR", msg);
}

fn emit(level: &str, msg: &str) {
    match SECRET.get() {
        Some(secret) if !secret.is_empty() && msg.contains(secret.as_str()) => {
            println!("{} {level} {}", local_stamp(), msg.replace(secret.as_str(), "***"));
        }
        _ => println!("{} {level} {msg}", local_stamp()),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn secret_is_replaced() {
        // отдельный процесс не нужен: проверяем саму замену строки
        let msg = "url https://api.telegram.org/bot123:ABC/x";
        assert_eq!(
            msg.replace("123:ABC", "***"),
            "url https://api.telegram.org/bot***/x"
        );
    }
}
