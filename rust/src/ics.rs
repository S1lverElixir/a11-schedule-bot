//! .ics недели по RFC 5545: событие на каждую пару, время локальное плавающее,
//! DTSTAMP — обязательный UTC. Мелочи (CRLF, фолдинг по 75 октетов, экранирование)
//! перенесены из bot.py дословно: однажды экспорт уже молчал в проде.

use crate::date::{Date, Stamp};
use crate::schedule::day_pairs;

/// Экранирование бэкслэша, точки с запятой, запятой и перевода строки.
fn ics_escape(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace(';', "\\;")
        .replace(',', "\\,")
        .replace('\n', "\\n")
}

/// Фолдинг §3.1: строки длиннее 75 октетов режутся, продолжение — с CRLF и пробелом;
/// многобайтовые символы UTF-8 не рвутся.
fn ics_fold(line: &str) -> String {
    let data = line.as_bytes();
    if data.len() <= 75 {
        return line.to_string();
    }
    let mut parts: Vec<&[u8]> = Vec::new();
    let mut rest = data;
    let mut limit = 75;
    while !rest.is_empty() {
        let mut cut = limit.min(rest.len());
        while cut < rest.len() && (0x80..=0xBF).contains(&rest[cut]) {
            cut -= 1;
        }
        parts.push(&rest[..cut]);
        rest = &rest[cut..];
        limit = 74; // продолжение начинается с пробела, на него отводится 1 октет
    }
    let mut out = String::with_capacity(line.len() + parts.len() * 3);
    for (i, part) in parts.iter().enumerate() {
        if i > 0 {
            out.push_str("\r\n ");
        }
        out.push_str(std::str::from_utf8(part).expect("граница UTF-8"));
    }
    out
}

/// .ics на неделю, начинающуюся с понедельника monday.
pub fn ics_for_week(monday: Date, stamp: Stamp) -> Vec<u8> {
    let mut out: Vec<String> = vec![
        "BEGIN:VCALENDAR".to_string(),
        "VERSION:2.0".to_string(),
        "PRODID:-//a11-schedule-bot//RU".to_string(),
        "CALSCALE:GREGORIAN".to_string(),
    ];
    let dtstamp = stamp.fmt_ics();
    for i in 0..7 {
        let day = monday.add_days(i);
        for p in day_pairs(day) {
            let t = |s: &str| format!("{}00", s.replace(':', ""));
            out.push("BEGIN:VEVENT".to_string());
            out.push(format!("UID:{}-{}@a11-bot", day.fmt_compact(), p.num));
            out.push(format!("DTSTAMP:{dtstamp}"));
            out.push(format!("DTSTART:{}T{}", day.fmt_compact(), t(p.start)));
            out.push(format!("DTEND:{}T{}", day.fmt_compact(), t(p.end)));
            out.push(format!("SUMMARY:{}", ics_escape(p.subj)));
            out.push(format!("LOCATION:{}", ics_escape(p.rooms.unwrap_or(""))));
            out.push(format!(
                "DESCRIPTION:{}",
                ics_escape(&p.teachers.join(", "))
            ));
            out.push("END:VEVENT".to_string());
        }
    }
    out.push("END:VCALENDAR".to_string());
    let mut text = String::new();
    for line in &out {
        text.push_str(&ics_fold(line));
        text.push_str("\r\n");
    }
    text.into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schedule::week_mark;
    use crate::schedule::Weeks;

    #[test]
    fn anchor_week_is_under_the_line() {
        assert_eq!(week_mark(Date::new(2026, 9, 21).unwrap()), Weeks::Under);
    }

    #[test]
    fn ics_has_crlf_and_event_per_pair() {
        let monday = Date::new(2026, 10, 26).unwrap();
        let bytes = ics_for_week(monday, Stamp::from_unix(0));
        let text = String::from_utf8(bytes).unwrap();
        let pairs: usize = (0..7).map(|i| day_pairs(monday.add_days(i)).len()).sum();
        assert_eq!(text.matches("BEGIN:VEVENT").count(), pairs);
        assert!(text.ends_with("END:VCALENDAR\r\n"));
        assert!(!text.contains("\n\n"));
    }
}
