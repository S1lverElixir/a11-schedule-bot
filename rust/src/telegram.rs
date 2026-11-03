//! Тонкий клиент Bot API: JSON-вызовы и одна multipart-отправка .ics.
//!
//! Без async-рантайма: бот делает десяток запросов в минуту, потоки дешевле.

use serde_json::{json, Value};
use std::io::Write;
use std::sync::Arc;
use std::time::Duration;

/// Что бот умеет у Telegram: ровно то, что нужно обработчикам. Через этот шов
/// тесты подменяют сеть записывающей заглушкой и сверяют поведение с Python-ботом.
pub trait Api {
    fn call(&self, method: &str, params: &Value) -> Result<Value, String>;
    fn send_document(
        &self,
        chat_id: i64,
        filename: &str,
        content: &[u8],
        caption: &str,
    ) -> Result<Value, String>;
}

/// Параметры sendMessage: без пустых полей, как их собирал Python-бот.
pub fn send_message_params(
    chat_id: i64,
    text: &str,
    reply_markup: Option<Value>,
    parse_mode: Option<&str>,
) -> Value {
    let mut params = json!({"chat_id": chat_id, "text": text});
    if let Some(markup) = reply_markup {
        params["reply_markup"] = markup;
    }
    if let Some(mode) = parse_mode {
        params["parse_mode"] = json!(mode);
    }
    params
}

pub struct Telegram {
    agent: ureq::Agent,
    base: String,
}

impl Telegram {
    pub fn new(token: &str) -> Telegram {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            // long poll 25 с сервер держит сам; 40 с — запас на запрос, как у aiohttp
            .timeout_global(Some(Duration::from_secs(40)))
            .timeout_connect(Some(Duration::from_secs(10)))
            .http_status_as_error(false)
            .max_idle_connections_per_host(4)
            .build()
            .into();
        Telegram {
            agent,
            base: format!("https://api.telegram.org/bot{token}"),
        }
    }

    /// Вызов метода Bot API; тело ответа разбирается даже при HTTP 4xx/5xx,
    /// потому что Telegram кладёт описание ошибки в JSON.
    pub fn call(&self, method: &str, params: &Value) -> Result<Value, String> {
        let url = format!("{}/{}", self.base, method);
        let mut resp = self
            .agent
            .post(&url)
            .header("Content-Type", "application/json")
            .send_json(params)
            .map_err(|e| e.to_string())?;
        let body: Value = resp
            .body_mut()
            .read_json()
            .map_err(|e| format!("{method}: ответ не JSON: {e}"))?;
        if body.get("ok").and_then(Value::as_bool) == Some(true) {
            Ok(body.get("result").cloned().unwrap_or(Value::Null))
        } else {
            Err(format!(
                "{method}: {}",
                body.get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("нет описания")
            ))
        }
    }

    /// GET JSON с необязательным Bearer-токеном: панель хостинга отвечает так же.
    pub fn get_json(&self, url: &str, bearer: Option<&str>) -> Result<Value, String> {
        let mut request = self.agent.get(url);
        if let Some(token) = bearer {
            request = request.header("Authorization", format!("Bearer {token}"));
        }
        let mut resp = request.call().map_err(|e| e.to_string())?;
        resp.body_mut()
            .read_json()
            .map_err(|e| format!("ответ не JSON: {e}"))
    }

    pub fn send_message(
        &self,
        chat_id: i64,
        text: &str,
        reply_markup: Option<Value>,
        parse_mode: Option<&str>,
    ) -> Result<Value, String> {
        let params = send_message_params(chat_id, text, reply_markup, parse_mode);
        self.call("sendMessage", &params)
    }

    /// Отправка .ics как документа с подписью и HTML-разметкой подписи.
    pub fn send_document(
        &self,
        chat_id: i64,
        filename: &str,
        content: &[u8],
        caption: &str,
    ) -> Result<Value, String> {
        let boundary = format!("a11bot-boundary-{}", crate::date::Stamp::now().unix());
        let mut body: Vec<u8> = Vec::with_capacity(content.len() + 512);
        let mut field = |name: &str, value: &str| {
            write!(
                body,
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
            )
            .expect("запись в память");
        };
        field("chat_id", &chat_id.to_string());
        field("caption", caption);
        field("parse_mode", "HTML");
        write!(
            body,
            "--{boundary}\r\nContent-Disposition: form-data; name=\"document\"; filename=\"{filename}\"\r\nContent-Type: text/calendar\r\n\r\n"
        )
        .expect("запись в память");
        body.extend_from_slice(content);
        write!(body, "\r\n--{boundary}--\r\n").expect("запись в память");

        let url = format!("{}/sendDocument", self.base);
        let mut resp = self
            .agent
            .post(&url)
            .header(
                "Content-Type",
                format!("multipart/form-data; boundary={boundary}"),
            )
            .send(body)
            .map_err(|e| e.to_string())?;
        let answer: Value = resp
            .body_mut()
            .read_json()
            .map_err(|e| format!("sendDocument: ответ не JSON: {e}"))?;
        if answer.get("ok").and_then(Value::as_bool) == Some(true) {
            Ok(answer)
        } else {
            Err(format!(
                "sendDocument: {}",
                answer
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("нет описания")
            ))
        }
    }
}

impl Api for Telegram {
    fn call(&self, method: &str, params: &Value) -> Result<Value, String> {
        Telegram::call(self, method, params)
    }

    fn send_document(
        &self,
        chat_id: i64,
        filename: &str,
        content: &[u8],
        caption: &str,
    ) -> Result<Value, String> {
        Telegram::send_document(self, chat_id, filename, content, caption)
    }
}

impl<T: Api + ?Sized> Api for Arc<T> {
    fn call(&self, method: &str, params: &Value) -> Result<Value, String> {
        (**self).call(method, params)
    }

    fn send_document(
        &self,
        chat_id: i64,
        filename: &str,
        content: &[u8],
        caption: &str,
    ) -> Result<Value, String> {
        (**self).send_document(chat_id, filename, content, caption)
    }
}

impl<T: Api + ?Sized> Api for &T {
    fn call(&self, method: &str, params: &Value) -> Result<Value, String> {
        (**self).call(method, params)
    }

    fn send_document(
        &self,
        chat_id: i64,
        filename: &str,
        content: &[u8],
        caption: &str,
    ) -> Result<Value, String> {
        (**self).send_document(chat_id, filename, content, caption)
    }
}
