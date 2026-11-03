//! Запуск бота: конфигурация, очистка webhook, два потока-сторожа и поток опроса.
//!
//! Ни async-рантайма, ни базы, ни состояния на диске: рестарт безопасен и теряет
//! только дедупликацию сводки и напоминания.

use std::sync::Arc;
use std::time::Duration;

use a11_bot::bot::{self, Bot, PanelConfig};
use a11_bot::log;
use a11_bot::telegram::Telegram;
use serde_json::{json, Value};

struct Config {
    token: String,
    owner_id: i64,
    morning: String,
    panel: PanelConfig,
}

/// Чтение .env рядом с рабочим каталогом: переменные окружения главнее файла.
fn load_dotenv() {
    let text = match std::fs::read_to_string(".env") {
        Ok(t) => t,
        Err(_) => return,
    };
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let (key, value) = match line.split_once('=') {
            Some(kv) => kv,
            None => continue,
        };
        let key = key.trim();
        let mut value = value.trim();
        if value.len() >= 2
            && ((value.starts_with('"') && value.ends_with('"'))
                || (value.starts_with('\'') && value.ends_with('\'')))
        {
            value = &value[1..value.len() - 1];
        }
        if key.is_empty() || std::env::var_os(key).is_some() {
            continue;
        }
        std::env::set_var(key, value);
    }
}

impl Config {
    fn load() -> Result<Config, String> {
        load_dotenv();
        let token = std::env::var("BOT_TOKEN").map_err(|_| "в окружении нет BOT_TOKEN")?;
        let owner_id = std::env::var("MY_TELEGRAM_ID")
            .map_err(|_| "в окружении нет MY_TELEGRAM_ID")?
            .trim()
            .parse::<i64>()
            .map_err(|_| "MY_TELEGRAM_ID — не число")?;
        Ok(Config {
            token,
            owner_id,
            morning: std::env::var("MORNING_SUMMARY_TIME").unwrap_or_else(|_| "07:30".to_string()),
            panel: PanelConfig {
                api_key: std::env::var("FPSMS_API_KEY").unwrap_or_default(),
                server: std::env::var("FPSMS_SERVER_UUID").unwrap_or_default(),
                panel_url: std::env::var("FPSMS_PANEL_URL")
                    .unwrap_or_else(|_| "https://panel.fps.ms".to_string()),
            },
        })
    }
}

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--selftest") {
        let iterations = std::env::args()
            .nth(2)
            .and_then(|v| v.parse().ok())
            .unwrap_or(1);
        selftest(iterations);
        return;
    }
    if std::env::args().nth(1).as_deref() == Some("--check-net") {
        check_net();
        return;
    }
    let cfg = match Config::load() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("ошибка конфигурации: {e}");
            std::process::exit(1);
        }
    };
    log::set_secret(&cfg.token);
    let tg = Arc::new(Telegram::new(&cfg.token));

    // на случай забытого webhook от прошлых экспериментов; сеть могла ещё не подняться
    match tg.call("deleteWebhook", &json!({})) {
        Ok(_) => log::info("webhook очищен"),
        Err(e) => log::warn(&format!("deleteWebhook: {e}")),
    }

    bot::spawn_morning(tg.clone(), cfg.owner_id, cfg.morning);
    bot::spawn_watchdog(tg.clone(), cfg.owner_id, cfg.panel);
    log::info("Start polling");

    let bot = Bot {
        api: tg.clone(),
        owner_id: cfg.owner_id,
    };
    let mut offset: i64 = 0;
    loop {
        // только нужные типы апдейтов — меньше полезная нагрузка на каждый poll
        let params = json!({
            "timeout": 25,
            "offset": offset,
            "allowed_updates": ["message", "callback_query"]
        });
        match tg.call("getUpdates", &params) {
            Ok(Value::Array(updates)) => {
                for update in &updates {
                    if let Some(id) = update.get("update_id").and_then(Value::as_i64) {
                        offset = id + 1;
                    }
                    bot.handle_update(update, a11_bot::date::Now::local());
                }
            }
            Ok(other) => log::warn(&format!("getUpdates вернул не массив: {other}")),
            Err(e) => {
                log::warn(&format!("poll error: {e}"));
                std::thread::sleep(Duration::from_secs(3));
            }
        }
    }
}

/// Проверка канала до Telegram без отправки сообщений: токен принимается или нет.
/// Ничего не пишет в чат, токен не печатает.
fn check_net() {
    let token = match std::env::var("BOT_TOKEN") {
        Ok(t) => t,
        Err(_) => {
            println!("канал: нет BOT_TOKEN в окружении");
            std::process::exit(1);
        }
    };
    log::set_secret(&token);
    let tg = a11_bot::telegram::Telegram::new(&token);
    match tg.call("getMe", &serde_json::json!({})) {
        Ok(me) => println!(
            "канал: ok, бот @{}",
            me.get("username").and_then(Value::as_str).unwrap_or("?")
        ),
        Err(e) => {
            println!("канал: ошибка {e}");
            std::process::exit(1);
        }
    }
}

/// Проверка «мозга» без сети: строит все виды за семестр, печатает объём, хеш и пик
/// памяти. Нужна, чтобы мерить память на любом хосте одной командой.
fn selftest(iterations: u32) {
    use a11_bot::date::{Date, Now, Stamp};
    use a11_bot::ics::ics_for_week;
    use a11_bot::render;

    fn feed(hash: &mut u64, s: &str) {
        for b in s.as_bytes() {
            *hash ^= *b as u64;
            *hash = hash.wrapping_mul(0x100000001b3);
        }
    }

    let start = Date::new(2026, 9, 1).expect("семестр");
    let end = Date::new(2026, 12, 31).expect("семестр");
    // клиент создаётся заранее: корневые сертификаты и TLS — как в рабочем процессе
    let _tg = a11_bot::telegram::Telegram::new("0:selftest");
    let mut hash: u64 = 0xcbf29ce484222325;
    let mut count = 0usize;
    let mut bytes = 0usize;
    for _ in 0..iterations.max(1) {
        let mut d = start;
        while d <= end {
            let now = Now {
                date: d,
                minute: 12 * 60 + 56,
            };
            for view in [
                render::day_text(d, "", now),
                render::now_text(now),
                render::render_week(d.add_days(-(d.weekday() as i32)), now),
                render::morning_text(d, now),
            ] {
                count += 1;
                bytes += view.len();
                feed(&mut hash, &view);
            }
            let kb = render::calendar_kb(d.year(), d.month(), now)
                .to_value()
                .to_string();
            count += 1;
            bytes += kb.len();
            feed(&mut hash, &kb);
            // штамп фиксированный: хеш должен совпадать на любой машине и любом запуске
            let ics = ics_for_week(d.add_days(-(d.weekday() as i32)), Stamp::from_unix(0));
            count += 1;
            bytes += ics.len();
            feed(&mut hash, &String::from_utf8_lossy(&ics));
            d = d.add_days(1);
        }
        let bells = render::bells_text();
        count += 1;
        bytes += bells.len();
        feed(&mut hash, &bells);
    }
    println!("selftest: {count} видов, {bytes} байт, хеш {hash:016x}");
    if let Some(mb) = peak_rss_mb() {
        println!("пик памяти процесса: {mb:.1} МБ");
    }
}

#[cfg(windows)]
fn peak_rss_mb() -> Option<f64> {
    #[repr(C)]
    #[derive(Default)]
    struct ProcessMemoryCounters {
        cb: u32,
        page_fault_count: u32,
        peak_working_set_size: usize,
        working_set_size: usize,
        quota_peak_paged_pool_usage: usize,
        quota_paged_pool_usage: usize,
        quota_peak_non_paged_pool_usage: usize,
        quota_non_paged_pool_usage: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
    }
    extern "system" {
        fn GetCurrentProcess() -> isize;
        fn K32GetProcessMemoryInfo(
            process: isize,
            counters: *mut ProcessMemoryCounters,
            cb: u32,
        ) -> i32;
    }
    let mut pmc = ProcessMemoryCounters {
        cb: std::mem::size_of::<ProcessMemoryCounters>() as u32,
        ..Default::default()
    };
    let ok = unsafe { K32GetProcessMemoryInfo(GetCurrentProcess(), &mut pmc, pmc.cb) };
    (ok != 0).then(|| pmc.peak_working_set_size as f64 / 1048576.0)
}

#[cfg(target_os = "linux")]
fn peak_rss_mb() -> Option<f64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("VmHWM:") {
            let kb: f64 = rest.trim().trim_end_matches(" kB").trim().parse().ok()?;
            return Some(kb / 1024.0);
        }
    }
    None
}

#[cfg(not(any(windows, target_os = "linux")))]
fn peak_rss_mb() -> Option<f64> {
    None
}
