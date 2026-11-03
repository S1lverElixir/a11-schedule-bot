//! Обработчики апдейтов и два фоновых сторожа.
//!
//! Владелец один: всё, что не от него, игнорируется молча — и в сообщениях,
//! и в нажатиях (кнопки существуют только в его личке).

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::date::{local_now_seconds, parse_iso_datetime, Date, Now, Stamp};
use crate::ics::ics_for_week;
use crate::log;
use crate::render;
use crate::schedule::{SEMESTER_END, SEMESTER_START};
use crate::telegram::{send_message_params, Api, Telegram};

const BUTTONS: [&str; 6] = [
    render::BTN_TODAY,
    render::BTN_TOMORROW,
    render::BTN_NOW,
    render::BTN_WEEK,
    render::BTN_BELLS,
    render::BTN_PICK,
];

pub struct Bot<A: Api> {
    pub api: A,
    pub owner_id: i64,
}

impl<A: Api> Bot<A> {
    /// now передаётся снаружи: обработчики становятся проверяемыми без часов и сети.
    pub fn handle_update(&self, update: &Value, now: Now) {
        if let Some(msg) = update.get("message") {
            self.on_message(msg, now);
        } else if let Some(cb) = update.get("callback_query") {
            self.on_callback(cb, now);
        }
    }

    /// Отправка с логированием ошибки: сетевой сбой не должен ронять опрос.
    fn send(&self, chat_id: i64, text: &str, markup: Option<Value>, mode: Option<&str>) {
        let params = send_message_params(chat_id, text, markup, mode);
        if let Err(e) = self.api.call("sendMessage", &params) {
            log::error(&format!("sendMessage: {e}"));
        }
    }

    fn on_message(&self, msg: &Value, now: Now) {
        if msg.pointer("/from/id").and_then(Value::as_i64) != Some(self.owner_id) {
            return; // чужим — молчание
        }
        let text = match msg.get("text").and_then(Value::as_str) {
            Some(t) => t,
            None => return,
        };
        let chat_id = match msg.pointer("/chat/id").and_then(Value::as_i64) {
            Some(id) => id,
            None => {
                log::warn("сообщение без chat_id");
                return;
            }
        };
        if text == "/start" {
            self.send(chat_id, render::GREETING, Some(render::main_kb()), None);
            return;
        }
        if !BUTTONS.contains(&text) {
            return; // незнакомые тексты игнорируются молча
        }
        let today = now.date;
        match text {
            render::BTN_TODAY => self.send(
                chat_id,
                &render::day_text(today, " · сегодня", now),
                None,
                Some("HTML"),
            ),
            render::BTN_TOMORROW => self.send(
                chat_id,
                &render::day_text(today.add_days(1), " · завтра", now),
                None,
                Some("HTML"),
            ),
            render::BTN_NOW => self.send(chat_id, &render::now_text(now), None, Some("HTML")),
            render::BTN_WEEK => {
                let monday = today.add_days(-(today.weekday() as i32));
                self.send(
                    chat_id,
                    &render::week_text(today, now),
                    Some(render::week_kb(monday).to_value()),
                    Some("HTML"),
                );
            }
            render::BTN_BELLS => self.send(chat_id, &render::bells_text(), None, Some("HTML")),
            _ => self.send(
                chat_id,
                "Выбери дату:",
                Some(render::calendar_kb(today.year(), today.month(), now).to_value()),
                None,
            ),
        }
    }

    fn on_callback(&self, cb: &Value, now: Now) {
        if cb.pointer("/from/id").and_then(Value::as_i64) != Some(self.owner_id) {
            return;
        }
        let cb_id = match cb.get("id").and_then(Value::as_str) {
            Some(id) => id,
            None => {
                log::warn("callback без id");
                return;
            }
        };
        if let Err(e) = self
            .api
            .call("answerCallbackQuery", &json!({"callback_query_id": cb_id}))
        {
            log::error(&format!("answerCallbackQuery: {e}"));
        }
        let data = match cb.get("data").and_then(Value::as_str) {
            Some(d) => d,
            None => {
                log::warn("пустые callback data");
                return;
            }
        };
        let parts: Vec<&str> = data.split(':').collect();
        if parts.len() < 2 || parts[1] == "x" {
            return;
        }
        // Telegram не присылает message у очень старых сообщений — чат владельца
        // в личке совпадает с его id
        let chat_id = cb
            .pointer("/message/chat/id")
            .and_then(Value::as_i64)
            .unwrap_or(self.owner_id);
        match parts[0] {
            "cal" => {
                let (y, m) = match Date::parse_month(parts[1]) {
                    Some(v) => v,
                    None => return bad_data(data),
                };
                if parts.len() == 3 {
                    let day: u32 = match parts[2].parse() {
                        Ok(v) => v,
                        Err(_) => return bad_data(data),
                    };
                    let d = match Date::new(y, m, day) {
                        Some(v) => v,
                        None => return bad_data(data),
                    };
                    self.send(chat_id, &render::day_text(d, "", now), None, Some("HTML"));
                } else {
                    let message_id = match cb.pointer("/message/message_id").and_then(Value::as_i64)
                    {
                        Some(v) => v,
                        None => return bad_data(data),
                    };
                    let markup = render::calendar_kb(y, m, now).to_value();
                    if let Err(e) = self.api.call(
                        "editMessageReplyMarkup",
                        &json!({
                            "chat_id": chat_id,
                            "message_id": message_id,
                            "reply_markup": markup
                        }),
                    ) {
                        log::error(&format!("editMessageReplyMarkup: {e}"));
                    }
                }
            }
            "wk" => {
                let monday = match Date::parse_iso(parts[1]) {
                    Some(v) => v,
                    None => return bad_data(data),
                };
                self.send(
                    chat_id,
                    &render::render_week(monday, now),
                    Some(render::week_kb(monday).to_value()),
                    Some("HTML"),
                );
            }
            "ics" => {
                let monday = match Date::parse_iso(parts[1]) {
                    Some(v) => v,
                    None => return bad_data(data),
                };
                let sunday = monday.add_days(6);
                let name = format!("raspisanie_{}-{}.ics", monday.fmt_dm(), sunday.fmt_dm());
                let caption = format!(
                    "<b>Неделя {}–{} · {} чертой</b>",
                    monday.fmt_dm(),
                    sunday.fmt_dm(),
                    crate::schedule::week_label(monday)
                );
                // DTSTAMP из тех же условных часов, что и тексты: иначе снимки не сойдутся
                let stamp = Stamp::from_local(now.date, now.minute * 60);
                let file = ics_for_week(monday, stamp);
                if let Err(e) = self.api.send_document(chat_id, &name, &file, &caption) {
                    log::error(&format!("sendDocument: {e}"));
                }
            }
            _ => bad_data(data),
        }
    }
}

fn bad_data(data: &str) {
    log::warn(&format!("bad callback data: {data:?}"));
}

/// Текст напоминания о продлении: та же формулировка, что была у Python-бота,
/// включая обрезанный UUID в ссылке и «не меньше часа» в остатке.
pub fn reminder_text(hours_left: f64, panel_url: &str, server: &str) -> String {
    let hours = (hours_left as i64).max(1);
    let short_id = server.split('-').next().unwrap_or("");
    format!(
        "Напоминание: сервер fps.ms остановится примерно через {hours} ч. \
         Продли сервер в панели (кнопка Add 24 hours): {panel_url}/server/{short_id}"
    )
}

/// Настройки сторожа продления сервера.
pub struct PanelConfig {
    pub api_key: String,
    pub server: String,
    pub panel_url: String,
}

/// Утренняя сводка: ежедневно в MORNING_SUMMARY_TIME (±полтора часа окна на случай
/// простоя). Если бот был выключен в окно — сводка пропускается, догоняющих нет.
pub fn spawn_morning(tg: Arc<Telegram>, owner_id: i64, time: String) {
    if time.is_empty() {
        return;
    }
    let (hh, mm) = match time.split_once(':') {
        Some((h, m)) => match (h.parse::<u32>(), m.parse::<u32>()) {
            (Ok(h), Ok(m)) if h < 24 && m < 60 => (h, m),
            _ => {
                log::error(&format!(
                    "MORNING_SUMMARY_TIME {time:?} — не HH:MM, сводка выключена"
                ));
                return;
            }
        },
        None => {
            log::error(&format!(
                "MORNING_SUMMARY_TIME {time:?} — не HH:MM, сводка выключена"
            ));
            return;
        }
    };
    std::thread::Builder::new()
        .name("morning".to_string())
        .spawn(move || {
            let target = (hh * 60 + mm) * 60;
            let mut last_sent: Option<Date> = None;
            loop {
                let (date, secs) = local_now_seconds();
                if SEMESTER_START <= date
                    && date <= SEMESTER_END
                    && (target..target + 90 * 60).contains(&secs)
                    && last_sent != Some(date)
                {
                    match tg.send_message(
                        owner_id,
                        &render::morning_text(date, Now::local()),
                        None,
                        Some("HTML"),
                    ) {
                        Ok(_) => {
                            last_sent = Some(date);
                            log::info("morning summary sent");
                        }
                        Err(e) => log::error(&format!("morning summary failed: {e}")),
                    }
                }
                std::thread::sleep(Duration::from_secs(60));
            }
        })
        .expect("поток утренней сводки");
}

/// Сторож срока сервера fps.ms: напоминает владельцу продлить.
/// Продление защищено reCAPTCHA, поэтому автоматом — только напоминание.
pub fn spawn_watchdog(tg: Arc<Telegram>, owner_id: i64, cfg: PanelConfig) {
    if cfg.api_key.is_empty() || cfg.server.is_empty() {
        return;
    }
    std::thread::Builder::new()
        .name("watchdog".to_string())
        .spawn(move || {
            let url = format!("{}/api/client/servers/{}", cfg.panel_url, cfg.server);
            let mut last_bucket: Option<&'static str> = None;
            loop {
                let mut bucket: Option<&'static str> = None;
                match tg.get_json(&url, Some(&cfg.api_key)) {
                    Ok(answer) => {
                        if let Some(expires) = answer
                            .pointer("/attributes/expires_at")
                            .and_then(Value::as_str)
                            .and_then(parse_iso_datetime)
                        {
                            let hours_left = (expires.unix() - Stamp::now().unix()) as f64 / 3600.0;
                            bucket = Some(if hours_left > 30.0 {
                                "ok"
                            } else if hours_left > 6.0 {
                                "soon"
                            } else {
                                "urgent"
                            });
                            if bucket != Some("ok") && bucket != last_bucket {
                                let text = reminder_text(hours_left, &cfg.panel_url, &cfg.server);
                                if let Err(e) = tg.send_message(owner_id, &text, None, None) {
                                    log::error(&format!("watchdog send: {e}"));
                                }
                            }
                        }
                    }
                    Err(e) => {
                        bucket = None;
                        log::error(&format!("watchdog check failed: {e}"));
                    }
                }
                last_bucket = bucket;
                std::thread::sleep(Duration::from_secs(3600));
            }
        })
        .expect("поток сторожа продления");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reminder_text_matches_python_bot() {
        // строка снята с Python-бота при тех же входных данных, не переписывать «по смыслу»
        assert_eq!(
            reminder_text(5.7, "https://panel.fps.ms", "abc-def-123"),
            "Напоминание: сервер fps.ms остановится примерно через 5 ч. \
             Продли сервер в панели (кнопка Add 24 hours): https://panel.fps.ms/server/abc"
        );
    }

    #[test]
    fn reminder_never_says_zero_hours() {
        assert!(reminder_text(0.4, "https://panel.fps.ms", "x").contains("через 1 ч"));
    }
}
