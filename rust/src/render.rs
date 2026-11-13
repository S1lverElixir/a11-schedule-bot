//! Все текстовые виды бота — чистые функции: строят строку, сети не касаются.
//!
//! Форматы перенесены из bot.py один в один (SPEC.md — контракт), поэтому даже
//! отступы и тире здесь менять нельзя: parity-тест сравнивает байт-в-байт.

use crate::date::{wd_lower, Date, Now, MONTHS, WD_FULL, WD_SHORT};
use crate::schedule::{
    cancelled_nums, day_pairs, kind, week_label, Pair, BELLS, SEMESTER_END, SEMESTER_START,
};
use serde_json::{json, Value};

pub const BTN_TODAY: &str = "Сегодня";
pub const BTN_TOMORROW: &str = "Завтра";
pub const BTN_NOW: &str = "Сейчас";
pub const BTN_WEEK: &str = "Неделя";
pub const BTN_BELLS: &str = "Звонки";
pub const BTN_PICK: &str = "Выбрать день";
/// Приветствие /start: короткая шапка и польза, без перечисления всех функций.
pub const GREETING: &str = "<b>Расписание группы А-11</b>\nДни, неделя, звонки и календарь — кнопками ниже.\n<i>Утром в 07:30 приходит сводка дня.</i>";
/// /help: карта возможностей — единственное место, где перечисление уместно;
/// названия кнопок в «ёлочках», как они выглядят в клавиатуре.
pub const HELP_TEXT: &str = "<b>Что умеет бот</b>\n«Сегодня» и «Завтра» — расписание дня; у «Сегодня» ещё и прогресс-бар.\n«Сейчас» — что идёт и что дальше.\n«Неделя» — раскладка недели; стрелки листают, «Экспорт в календарь» даёт .ics.\n«Выбрать день» — календарь на месяц.\n«Звонки» — время звонков и перемен.\n<i>Утром в 07:30 приходит сводка дня.</i>";
/// Ответ на незнакомый текст владельца: короткая подсказка вместо молчания.
pub const UNKNOWN_TEXT: &str = "Не понял, кнопки ниже.";
pub const PICK_PROMPT: &str = "<b>Выбери день</b>";

/// Экранирование HTML как `html.escape(s)` в Python (включая кавычки).
pub fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#x27;"),
            _ => out.push(c),
        }
    }
    out
}

/// «09:50» → минуты от полуночи.
pub fn hm(s: &str) -> u32 {
    let (h, m) = s.split_once(':').expect("время из данных");
    h.parse::<u32>().expect("часы") * 60 + m.parse::<u32>().expect("минуты")
}

/// Интервал по-человечески: 45 → «45 мин», 60 → «1 ч», 95 → «1 ч 35 мин».
pub fn fmt_minutes(m: u32) -> String {
    if m < 60 {
        return format!("{m} мин");
    }
    let (h, rem) = (m / 60, m % 60);
    if rem == 0 {
        format!("{h} ч")
    } else {
        format!("{h} ч {rem} мин")
    }
}

/// Русская форма слова «пара» по числу.
pub fn pairs_word(n: u32) -> &'static str {
    if n % 10 == 1 && n % 100 != 11 {
        "пара"
    } else if (2..=4).contains(&(n % 10)) && !(12..=14).contains(&(n % 100)) {
        "пары"
    } else {
        "пар"
    }
}

/// Аудитории для вывода: экранирование и пробел после запятой в перечнях.
pub fn fmt_rooms(rooms: Option<&str>) -> String {
    match rooms {
        Some(r) if !r.is_empty() => {
            let mut out = String::with_capacity(r.len() + 4);
            for c in r.chars() {
                match c {
                    '&' => out.push_str("&amp;"),
                    '<' => out.push_str("&lt;"),
                    '>' => out.push_str("&gt;"),
                    '"' => out.push_str("&quot;"),
                    '\'' => out.push_str("&#x27;"),
                    ',' => out.push_str(", "),
                    _ => out.push(c),
                }
            }
            out
        }
        _ => String::new(),
    }
}

/// Заголовок предмета с типом занятия через « · ».
fn subject_title(subj: &str) -> String {
    let k = kind(subj);
    if k.is_empty() {
        esc(subj)
    } else {
        format!("{k} · {}", esc(subj))
    }
}

/// HTML-блок пары: жирная строка времени, предмет с аудиторией, преподаватели;
/// note — курсивная приписка (для идущей пары).
fn pair_block(p: &Pair, note: Option<&str>) -> String {
    let second = match p.rooms {
        Some(r) if !r.is_empty() => {
            format!("{}, ауд. {}", subject_title(p.subj), fmt_rooms(Some(r)))
        }
        _ => subject_title(p.subj),
    };
    let teachers = esc(&p.teachers.join(", "));
    let mut text = format!(
        "<b>{}-я пара {}–{}</b>{}\n{second}\n{teachers}",
        p.num,
        p.start,
        p.end,
        if p.sub { "<i> · замена</i>" } else { "" }
    );
    if let Some(note) = note {
        text.push_str("\n<i>");
        text.push_str(note);
        text.push_str("</i>");
    }
    text
}

/// Границы учебного дня в минутах — от первой до последней пары.
fn day_span(pairs: &[Pair]) -> (u32, u32) {
    (hm(pairs[0].start), hm(pairs[pairs.len() - 1].end))
}

/// Округление половины к чётному, как `round()` в Python.
fn round_half_even(num: i64, den: i64) -> i64 {
    let q = num.div_euclid(den);
    let r = num.rem_euclid(den) * 2;
    if r > den || (r == den && q % 2 != 0) {
        q + 1
    } else {
        q
    }
}

/// 10-клеточный прогресс учебного дня: ▰ пройдено, ▱ осталось.
fn progress_bar(pairs: &[Pair], minutes: u32) -> String {
    let (s, e) = day_span(pairs);
    let raw = (minutes as i64 - s as i64) * 10;
    let filled = round_half_even(raw, (e as i64 - s as i64).max(1)).clamp(0, 10) as usize;
    let mut out = String::with_capacity(10 * 3);
    for i in 0..10 {
        out.push(if i < filled { '▰' } else { '▱' });
    }
    out
}

/// Строки отмен: «N-я пара отменена», по одной на слот.
pub fn cancel_lines(nums: &[u8]) -> Vec<String> {
    nums.iter()
        .map(|n| format!("<i>{n}-я пара отменена</i>"))
        .collect()
}

/// Диапазон дня «пары HH:MM–HH:MM»; для сегодня — с прогресс-баром в code-блоке.
fn day_span_block(pairs: &[Pair], minutes_now: Option<u32>) -> String {
    let rng = format!("пары {}–{}", pairs[0].start, pairs[pairs.len() - 1].end);
    match minutes_now {
        Some(m) => format!("<code>{}\n{rng}</code>", progress_bar(pairs, m)),
        None => rng,
    }
}

/// Статус сегодняшнего дня; границы: момент начала пары — уже пара, конец — уже перемена.
fn status_line(pairs: &[Pair], now: u32) -> String {
    for (i, p) in pairs.iter().enumerate() {
        let (s, e) = (hm(p.start), hm(p.end));
        if now < s {
            if i == 0 {
                return format!("до первой пары {}", fmt_minutes(s - now));
            }
            return format!("перемена, до {}-й пары {}", p.num, fmt_minutes(s - now));
        }
        if now < e {
            return format!("идёт {}-я пара, до конца {}", p.num, fmt_minutes(e - now));
        }
    }
    "занятия окончены".to_string()
}

/// Сообщение одного дня: шапка, черта, диапазон (у сегодня — бар), блоки пар;
/// в пустом дне — подсказка «ближайшая пара», в конце — отменённые слоты.
pub fn day_text(d: Date, suffix: &str, now: Now) -> String {
    let mut head = format!(
        "<b>{}, {}{}</b>\nНеделя {} чертой",
        WD_FULL[d.weekday() as usize],
        d.fmt_dmy(),
        esc(suffix),
        week_label(d)
    );
    let cancels = cancel_lines(&cancelled_nums(d));
    let pairs = day_pairs(d);
    if pairs.is_empty() {
        let line = if d == now.date {
            "сегодня пар нет"
        } else {
            "пар нет"
        };
        let mut text = format!("{head}\n\n<i>{line}</i>");
        for cl in &cancels {
            text.push_str("\n\n");
            text.push_str(cl);
        }
        if let Some((nd, first)) = next_day_first_pair(d) {
            text.push_str("\n\n<blockquote>");
            text.push_str(&next_pair_hint(d, nd, &first));
            text.push_str("</blockquote>");
        }
        return text;
    }
    let today = d == now.date;
    let mut status: Option<String> = None;
    if today {
        head.push('\n');
        head.push_str(&day_span_block(&pairs, Some(now.minute)));
        status = Some(status_line(&pairs, now.minute));
    } else {
        head.push('\n');
        head.push_str(&day_span_block(&pairs, None));
    }
    let mut text = head;
    let blocks: Vec<String> = match status.as_deref() {
        None => pairs.iter().map(|p| pair_block(p, None)).collect(),
        Some(st)
            if st == "занятия окончены"
                || st.starts_with("перемена")
                || st.starts_with("до первой") =>
        {
            text.push_str("\n\n<i>");
            text.push_str(st);
            text.push_str("</i>");
            pairs.iter().map(|p| pair_block(p, None)).collect()
        }
        Some(_) => {
            let running = pairs
                .iter()
                .position(|p| hm(p.start) <= now.minute && now.minute < hm(p.end));
            pairs
                .iter()
                .enumerate()
                .map(|(i, p)| {
                    if Some(i) == running {
                        let note = format!("до конца {}", fmt_minutes(hm(p.end) - now.minute));
                        pair_block(p, Some(&note))
                    } else {
                        pair_block(p, None)
                    }
                })
                .collect()
        }
    };
    text.push_str("\n\n");
    text.push_str(&blocks.join("\n\n"));
    for cl in &cancels {
        text.push_str("\n\n");
        text.push_str(cl);
    }
    text
}

/// Первая пара ближайшего дня с парами в пределах недели вперёд.
fn next_day_first_pair(after: Date) -> Option<(Date, Pair)> {
    for i in 1..8 {
        let d = after.add_days(i);
        let pairs = day_pairs(d);
        if let Some(first) = pairs.first() {
            return Some((d, *first));
        }
    }
    None
}

/// Текст-подсказка «завтра: …» / «ближайшая пара: …» без обёртки blockquote.
fn next_pair_hint(d: Date, nd: Date, first: &Pair) -> String {
    let rooms = match first.rooms {
        Some(r) if !r.is_empty() => format!(", ауд. {}", fmt_rooms(Some(r))),
        _ => String::new(),
    };
    if nd.days_since(d) == 1 {
        format!(
            "завтра: {}-я пара в {} — {}{rooms}",
            first.num,
            first.start,
            esc(first.subj)
        )
    } else {
        format!(
            "ближайшая пара: {}, {}, {}-я пара в {} — {}{rooms}",
            wd_lower(nd.weekday()),
            nd.fmt_dm(),
            first.num,
            first.start,
            esc(first.subj)
        )
    }
}

/// Кнопка «Сейчас»: что происходит прямо сейчас и что дальше.
pub fn now_text(now: Now) -> String {
    let d = now.date;
    let mut head = format!(
        "<b>Сейчас {} · {}, {}</b>\nНеделя {} чертой",
        now.hh_mm(),
        WD_FULL[d.weekday() as usize],
        d.fmt_dm(),
        week_label(d)
    );
    let pairs = day_pairs(d);
    if pairs.is_empty() {
        let mut text = format!("{head}\n\n<i>сегодня пар нет</i>");
        if let Some((nd, first)) = next_day_first_pair(d) {
            text.push_str("\n\n<blockquote>");
            text.push_str(&next_pair_hint(d, nd, &first));
            text.push_str("</blockquote>");
        }
        return text;
    }
    let running = pairs
        .iter()
        .position(|p| hm(p.start) <= now.minute && now.minute < hm(p.end));
    let upcoming = pairs.iter().position(|p| now.minute < hm(p.start));
    if running.is_some() || upcoming.is_some() {
        head.push('\n');
        head.push_str(&day_span_block(&pairs, Some(now.minute)));
    }
    if let Some(i) = running {
        let p = pairs[i];
        let mut text = format!(
            "{head}\n\n{}\n<i>до конца {}</i>",
            pair_block(&p, None),
            fmt_minutes(hm(p.end) - now.minute)
        );
        if i + 1 < pairs.len() {
            let nxt = pairs[i + 1];
            let rooms = match nxt.rooms {
                Some(r) if !r.is_empty() => format!(", ауд. {}", fmt_rooms(Some(r))),
                _ => String::new(),
            };
            text.push_str(&format!(
                "\n\n<blockquote>дальше: {}-я пара в {} — {}{rooms}</blockquote>",
                nxt.num,
                nxt.start,
                esc(nxt.subj)
            ));
        }
        return text;
    }
    if let Some(i) = upcoming {
        let p = pairs[i];
        let gap = hm(p.start) - now.minute;
        let label = if i == 0 {
            "до первой пары"
        } else {
            "перемена"
        };
        return format!(
            "{head}\n\n<i>{label} {}</i>\n\n{}",
            fmt_minutes(gap),
            pair_block(&p, None)
        );
    }
    let mut text = format!("{head}\n\n<i>занятия окончены</i>");
    if let Some((nd, first)) = next_day_first_pair(d) {
        text.push_str("\n\n<blockquote>");
        text.push_str(&next_pair_hint(d, nd, &first));
        text.push_str("</blockquote>");
    }
    text
}

/// Компактная неделя: шапка и дни жирным, счётчики курсивом, пустые выходные одним блоком.
pub fn render_week(monday: Date, now: Now) -> String {
    let today = now.date;
    let days: Vec<Date> = (0..7).map(|i| monday.add_days(i)).collect();
    // один расчёт на день: раньше пары считались дважды — для счётчика и для строк
    let lists: Vec<Vec<Pair>> = days.iter().map(|d| day_pairs(*d)).collect();
    let counts: Vec<usize> = lists.iter().map(|v| v.len()).collect();
    let mut lines = vec![format!(
        "<b>Неделя {}–{} · {} чертой</b>",
        monday.fmt_dm(),
        days[6].fmt_dm(),
        week_label(monday)
    )];
    if counts.iter().all(|&c| c == 0) {
        // неделя целиком вне семестра: семь «пар нет» — шум
        return format!("{}\n\n<i>пар нет</i>", lines[0]);
    }
    let mut merged: Vec<(&str, Vec<usize>)> = Vec::new();
    let mut i = 0;
    while i < 7 {
        if i == 5 && counts[5] == 0 && counts[6] == 0 {
            merged.push(("Сб–Вс", vec![5, 6]));
            i += 2;
        } else {
            merged.push((WD_SHORT[i], vec![i]));
            i += 1;
        }
    }
    for (wd, idx) in merged {
        lines.push(String::new());
        let mark = if idx.iter().any(|&k| days[k] == today) {
            " · сегодня"
        } else {
            ""
        };
        if idx.len() == 1 {
            lines.push(format!("<b>{wd} {}{mark}</b>", days[idx[0]].fmt_dm()));
        } else {
            lines.push(format!(
                "<b>{wd} {} · {}{mark}</b>",
                days[idx[0]].fmt_dm(),
                days[idx[1]].fmt_dm()
            ));
        }
        let pairs = &lists[idx[0]];
        if pairs.is_empty() {
            lines.push("<i>пар нет</i>".to_string());
            continue;
        }
        for p in pairs {
            let title = subject_title(p.subj);
            let tail = if p.sub { " · замена" } else { "" };
            match p.rooms {
                Some(r) if !r.is_empty() => lines.push(format!(
                    "{} ({}) {title}, ауд. {}{tail}",
                    p.num,
                    p.start,
                    fmt_rooms(Some(r))
                )),
                _ => lines.push(format!("{} ({}) {title}{tail}", p.num, p.start)),
            }
        }
        lines.push(format!(
            "<i>{} {}</i>",
            pairs.len(),
            pairs_word(pairs.len() as u32)
        ));
    }
    lines.join("\n")
}

/// Компактная неделя, содержащая d.
pub fn week_text(d: Date, now: Now) -> String {
    render_week(d.add_days(-(d.weekday() as i32)), now)
}

/// Пересекается ли месяц с семестром — по этому признаку показываются стрелки.
fn month_intersects(y: i32, m: u32) -> bool {
    let first = Date::new(y, m, 1).expect("месяц из callback_data");
    let after = first.next_month_first();
    first <= SEMESTER_END && after.add_days(-1) >= SEMESTER_START
}

/// Inline-клавиатура: строки клеток «текст → callback_data».
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InlineKb {
    pub rows: Vec<Vec<(String, String)>>,
}

impl InlineKb {
    fn row(cells: Vec<(String, String)>) -> Vec<(String, String)> {
        cells
    }

    /// JSON для Bot API.
    pub fn to_value(&self) -> Value {
        let rows: Vec<Value> = self
            .rows
            .iter()
            .map(|row| {
                Value::Array(
                    row.iter()
                        .map(|(text, data)| json!({"text": text, "callback_data": data}))
                        .collect(),
                )
            })
            .collect();
        json!({"inline_keyboard": rows})
    }
}

fn btn(text: impl Into<String>, data: impl Into<String>) -> (String, String) {
    (text.into(), data.into())
}

/// Постоянная клавиатура: два ряда кнопок.
pub fn main_kb() -> Value {
    json!({
        "keyboard": [
            [{"text": BTN_TODAY}, {"text": BTN_TOMORROW}, {"text": BTN_NOW}, {"text": BTN_WEEK}],
            [{"text": BTN_BELLS}, {"text": BTN_PICK}]
        ],
        "resize_keyboard": true
    })
}

/// Кнопки под неделей: ‹ | Экспорт в календарь | ›.
pub fn week_kb(monday: Date) -> InlineKb {
    InlineKb {
        rows: vec![InlineKb::row(vec![
            btn("‹", format!("wk:{}", monday.add_days(-7).fmt_iso())),
            btn("Экспорт в календарь", format!("ics:{}", monday.fmt_iso())),
            btn("›", format!("wk:{}", monday.add_days(7).fmt_iso())),
        ])],
    }
}

/// Сетка месяца: шапка со стрелками, дни недели, даты; вне семестра — пустые клетки.
pub fn calendar_kb(y: i32, m: u32, now: Now) -> InlineKb {
    let first = Date::new(y, m, 1).expect("месяц календаря");
    let after = first.next_month_first();
    let mut head: Vec<(String, String)> = Vec::new();
    let prev = first.add_days(-1);
    if month_intersects(prev.year(), prev.month()) {
        let (py, pm) = (prev.year(), prev.month());
        head.push(btn("‹", format!("cal:{py:04}-{pm:02}")));
    }
    head.push(btn(format!("{} {y}", MONTHS[m as usize - 1]), "cal:x"));
    let (ny, nm) = (after.year(), after.month());
    if month_intersects(ny, nm) {
        head.push(btn("›", format!("cal:{ny:04}-{nm:02}")));
    }

    let mut rows = vec![head];
    rows.push(WD_SHORT.iter().map(|wd| btn(*wd, "cal:x")).collect());
    let today = now.date;
    let mut cell = first.add_days(-(first.weekday() as i32));
    while cell < after {
        let mut row = Vec::with_capacity(7);
        for _ in 0..7 {
            if cell.month() == m && SEMESTER_START <= cell && cell <= SEMESTER_END {
                let mark = if cell == today { "·" } else { "" };
                row.push(btn(
                    format!("{mark}{}", cell.day()),
                    format!(
                        "cal:{:04}-{:02}:{:02}",
                        cell.year(),
                        cell.month(),
                        cell.day()
                    ),
                ));
            } else {
                row.push(btn(" ", "cal:x"));
            }
            cell = cell.add_days(1);
        }
        rows.push(row);
    }
    InlineKb { rows }
}

/// «Звонки» в HTML: дерево — пара целиком, внутри 1-й час, перемена, 2-й час.
pub fn bells_text() -> String {
    let width = BELLS.iter().map(|b| b.end.len()).max().unwrap_or(0);
    let mut lines: Vec<String> = Vec::with_capacity(BELLS.len() * 4);
    for b in BELLS {
        let tail = match b.br {
            Some(br) => format!("   перерыв {br}"),
            None => String::new(),
        };
        let pad = " ".repeat(width - b.end.len());
        let line = format!("{}-я  {}–{}{pad}{tail}", b.num, b.start, b.end);
        lines.push(line.trim_end().to_string());
        let gap = hm(b.second.split('–').next().unwrap()) - hm(b.first.split('–').nth(1).unwrap());
        lines.push(format!("├ 1-й час  {}", b.first));
        lines.push(format!("├ перемена {gap} мин"));
        lines.push(format!("└ 2-й час  {}", b.second));
    }
    let body = lines.join("\n");
    format!("<b>Расписание звонков</b>\n<code>{body}</code>")
}

/// Утренняя сводка: компактная раскладка дня в одну строку на пару.
pub fn morning_text(d: Date, now: Now) -> String {
    let head = format!(
        "<b>Доброе утро · {}, {}</b>\nНеделя {} чертой",
        WD_FULL[d.weekday() as usize],
        d.fmt_dmy(),
        week_label(d)
    );
    let pairs = day_pairs(d);
    if pairs.is_empty() {
        let mut text = format!("{head}\n\n<i>сегодня пар нет</i>");
        for cl in cancel_lines(&cancelled_nums(d)) {
            text.push('\n');
            text.push_str(&cl);
        }
        return text;
    }
    let gap = hm(pairs[0].start) as i64 - now.minute as i64;
    let mut info = day_span_block(&pairs, Some(now.minute));
    if gap > 0 {
        info.push_str(&format!(
            "\n\n<i>до первой пары {}</i>",
            fmt_minutes(gap as u32)
        ));
    }
    let mut lines = Vec::with_capacity(pairs.len());
    for p in &pairs {
        let title = subject_title(p.subj);
        let tail = if p.sub { " · замена" } else { "" };
        match p.rooms {
            Some(r) if !r.is_empty() => lines.push(format!(
                "{} ({}) {title}, ауд. {}{tail}",
                p.num,
                p.start,
                fmt_rooms(Some(r))
            )),
            _ => lines.push(format!("{} ({}) {title}{tail}", p.num, p.start)),
        }
    }
    let mut text = format!(
        "{head}\n{info}\n\n{}\n<i>{} {}</i>",
        lines.join("\n"),
        pairs.len(),
        pairs_word(pairs.len() as u32)
    );
    for cl in cancel_lines(&cancelled_nums(d)) {
        text.push('\n');
        text.push_str(&cl);
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_half_even_matches_python() {
        assert_eq!(round_half_even(4, 2), 2);
        assert_eq!(round_half_even(5, 2), 2);
        assert_eq!(round_half_even(7, 2), 4);
        assert_eq!(round_half_even(45, 10), 4);
        assert_eq!(round_half_even(46, 10), 5);
    }

    #[test]
    fn escaping_matches_python_html_escape() {
        assert_eq!(esc("a&b<c>d\"e'f"), "a&amp;b&lt;c&gt;d&quot;e&#x27;f");
    }

    #[test]
    fn minutes_without_remainder_have_no_zero_tail() {
        assert_eq!(fmt_minutes(45), "45 мин");
        assert_eq!(fmt_minutes(60), "1 ч");
        assert_eq!(fmt_minutes(120), "2 ч");
        assert_eq!(fmt_minutes(95), "1 ч 35 мин");
    }

    #[test]
    fn cancel_lines_one_per_slot() {
        assert!(cancel_lines(&[]).is_empty());
        assert_eq!(cancel_lines(&[3]), vec!["<i>3-я пара отменена</i>"]);
        assert_eq!(
            cancel_lines(&[3, 5]),
            vec!["<i>3-я пара отменена</i>", "<i>5-я пара отменена</i>"]
        );
    }

    #[test]
    fn cancelled_nums_empty_until_data_has_cancellations() {
        // в данных пока нет отмен — функция обязана вернуть пусто;
        // случай с отменой проверяется через cancel_lines и придёт с данными
        let d = Date::parse_iso("2026-12-16").expect("дата");
        assert!(cancelled_nums(d).is_empty());
    }

    #[test]
    fn empty_day_inside_semester_hints_the_next_pair() {
        let now = Now {
            date: Date::parse_iso("2026-10-23").expect("дата"),
            minute: 720,
        };
        let sunday = day_text(Date::parse_iso("2026-10-25").expect("дата"), "", now);
        assert!(sunday.contains("<i>пар нет</i>"));
        assert!(sunday.contains("<blockquote>завтра:"));
        let vacation = day_text(Date::parse_iso("2027-01-05").expect("дата"), "", now);
        assert!(vacation.contains("<i>пар нет</i>"));
        assert!(!vacation.contains("<blockquote>"));
    }

    #[test]
    fn cancellation_mark_does_not_break_a_day_with_pairs() {
        let now = Now {
            date: Date::parse_iso("2026-12-16").expect("дата"),
            minute: 720,
        };
        let text = day_text(Date::parse_iso("2026-12-16").expect("дата"), "", now);
        assert!(text.contains("Час куратора"));
        assert!(text.contains(" · замена"));
        assert!(!text.contains("отменена"));
    }
}
