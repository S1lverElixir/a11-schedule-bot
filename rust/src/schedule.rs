//! Данные расписания группы А-11 — единственный источник правды.
//!
//! Строки лежат в бинарнике как статика, поэтому данных в куче нет.
//!
//! Запись пары: номер, начало, конец, предмет, аудитории, преподаватели, недели.
//! - аудитории — строка как в таблице («2-11», «3-36,3-24») или None без аудитории;
//! - недели: Both — в обе, Over — только над чертой, Under — только под чертой;
//! - должность входит в строку преподавателя дословно из таблицы: доц., ст.пр., пр., пр.-ст.;
//! - ключи SCHEDULE — номер дня, 0 — понедельник, 6 — воскресенье.
//!
//! Данные сверены со стабильным расписанием ФЭУ a-1.xls (bteu.by, от 11.09.2026) и
//! таблицей «Формирование учебных недель на 1 семестр 2026/2027». В a-1.xls черта
//! («———») стоит внутри слота и делит его на верхнюю и нижнюю половины: запись над
//! пустой чертой — пара только «над», запись под чертой с датой — пара только «под»,
//! пустая половина — занятий в эту неделю нет. Варианты «под» помечены датами
//! «с 21.09 / 24.09 / 25.09 / 26.09.26», и все они лежат в одной неделе 21–27.09.2026.
//! Отсюда пары только над чертой: понедельник 14:40 (инф. час), четверг 09:00 (ОС),
//! пятница 14:40 (политэкономия) — в под-неделях их нет.
//!
//! Часы звонков — по расписанию звонков bteu.by; у группы А-11 бывают только пары 1–5.

use crate::date::Date;
use serde_json::{json, Value};

/// Границы семестра: пределы календаря «Выбрать день»; вне их — каникулы, «пар нет».
pub const SEMESTER_START: Date = Date::new_const(2026, 9, 1);
pub const SEMESTER_END: Date = Date::new_const(2026, 12, 31);

/// Якорь чередования недель: неделя с этого понедельника — ПОД чертой.
/// Подтверждено таблицей «Формирование учебных недель на 1 семестр 2026/2027» на bteu.by.
pub const ANCHOR_MONDAY: Date = Date::new_const(2026, 9, 21);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Weeks {
    Both,
    Over,
    Under,
}

impl Weeks {
    fn label(self) -> &'static str {
        match self {
            Weeks::Under => "под",
            Weeks::Over => "над",
            Weeks::Both => "both",
        }
    }
}

/// Черта недели, содержащей день: чередование от якоря в обе стороны.
pub fn week_mark(day: Date) -> Weeks {
    let monday = day.add_days(-(day.weekday() as i32));
    let weeks = monday.days_since(ANCHOR_MONDAY).div_euclid(7);
    if weeks % 2 == 0 {
        Weeks::Under
    } else {
        Weeks::Over
    }
}

/// Метка недели строкой, как её писал Python-бот.
pub fn week_label(day: Date) -> &'static str {
    week_mark(day).label()
}

/// Строка стабильного расписания: номер, начало, конец, предмет, аудитории,
/// преподаватели, недели.
#[derive(Clone, Copy)]
pub struct Row {
    pub num: u8,
    pub start: &'static str,
    pub end: &'static str,
    pub subj: &'static str,
    pub rooms: Option<&'static str>,
    pub teachers: &'static [&'static str],
    pub weeks: Weeks,
}

/// То, что бот показывает на слоте дня: строка таблицы (sub=false) либо замена
/// этого дня (sub=true). У отменённой пары начало, конец и предмет пустые.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Pair {
    pub num: u8,
    pub start: &'static str,
    pub end: &'static str,
    pub subj: &'static str,
    pub rooms: Option<&'static str>,
    pub teachers: &'static [&'static str],
    pub weeks: Weeks,
    pub sub: bool,
}

/// Датная замена: в этот день слот num занимает другое занятие. Пустые start и
/// subj — занятие в этом слоте в этот день отменено, и в расписании его нет.
#[derive(Clone, Copy)]
pub struct Sub {
    pub day: (i32, u32, u32),
    pub num: u8,
    pub start: &'static str,
    pub end: &'static str,
    pub subj: &'static str,
    pub rooms: Option<&'static str>,
    pub teachers: &'static [&'static str],
}

/// Замены на текущий семестр: их выкладывает деканат на странице «Начитка» и в
/// графике кураторского часа. Сверяет rust/tools/check_site.py; пусто — значит по
/// сайту замен нет, и бот показывает только стабильное расписание.
pub const SUBSTITUTIONS: &[Sub] = &[];

fn from_row(r: &Row) -> Pair {
    Pair {
        num: r.num,
        start: r.start,
        end: r.end,
        subj: r.subj,
        rooms: r.rooms,
        teachers: r.teachers,
        weeks: r.weeks,
        sub: false,
    }
}

fn from_sub(s: &Sub) -> Pair {
    Pair {
        num: s.num,
        start: s.start,
        end: s.end,
        subj: s.subj,
        rooms: s.rooms,
        teachers: s.teachers,
        // дата задана прямо, черта недели к замене не применяется
        weeks: Weeks::Both,
        sub: true,
    }
}

fn subs_on(d: Date, all: &[Sub]) -> Vec<Sub> {
    all.iter()
        .copied()
        .filter(|s| Date::new(s.day.0, s.day.1, s.day.2) == Some(d))
        .collect()
}

/// Пары дня: стабильная таблица с учётом черты, поверх — датные замены этого дня.
/// Вне семестра — каникулы, пар нет.
pub fn day_pairs(d: Date) -> Vec<Pair> {
    day_pairs_with(d, &subs_on(d, SUBSTITUTIONS))
}

/// Тот же расчёт с готовым списком замен этого дня — чтобы логику можно было
/// проверить без правки константы.
pub fn day_pairs_with(d: Date, subs: &[Sub]) -> Vec<Pair> {
    if !(SEMESTER_START <= d && d <= SEMESTER_END) {
        return Vec::new();
    }
    let mark = week_mark(d);
    let mut out: Vec<Pair> = SCHEDULE[d.weekday() as usize]
        .iter()
        .filter(|p| p.weeks == Weeks::Both || p.weeks == mark)
        .filter(|p| !subs.iter().any(|s| s.num == p.num))
        .map(from_row)
        .collect();
    out.extend(subs.iter().filter(|s| !s.start.is_empty()).map(from_sub));
    out.sort_by_key(|p| p.num);
    out
}

/// Машинный дамп данных: стабильная таблица, замены, звонки, типы и границы.
/// Нужен rust/tools/check_site.py, чтобы сверять расписание с файлами bteu.by.
pub fn dump_json() -> String {
    let weeks = |w: Weeks| match w {
        Weeks::Both => "both",
        Weeks::Over => "над",
        Weeks::Under => "под",
    };
    let days: Vec<Value> = SCHEDULE
        .iter()
        .map(|rows| {
            Value::Array(
                rows.iter()
                    .map(|r| {
                        json!({
                            "num": r.num,
                            "start": r.start,
                            "end": r.end,
                            "subj": r.subj,
                            "rooms": r.rooms.unwrap_or(""),
                            "teachers": r.teachers,
                            "weeks": weeks(r.weeks),
                        })
                    })
                    .collect(),
            )
        })
        .collect();
    let subs: Vec<Value> = SUBSTITUTIONS
        .iter()
        .map(|s| {
            json!({
                "date": format!("{:04}-{:02}-{:02}", s.day.0, s.day.1, s.day.2),
                "num": s.num,
                "start": s.start,
                "end": s.end,
                "subj": s.subj,
                "rooms": s.rooms.unwrap_or(""),
                "teachers": s.teachers,
            })
        })
        .collect();
    let bells: Vec<Value> = BELLS
        .iter()
        .map(|b| {
            json!({
                "num": b.num,
                "start": b.start,
                "end": b.end,
                "first": b.first,
                "second": b.second,
                "break": b.br.unwrap_or(""),
            })
        })
        .collect();
    let doc = json!({
        "semester": [SEMESTER_START.fmt_iso(), SEMESTER_END.fmt_iso()],
        "anchor_monday": ANCHOR_MONDAY.fmt_iso(),
        "days": days,
        "substitutions": subs,
        "kind": KIND.iter().map(|(n, k)| json!([n, k])).collect::<Vec<_>>(),
        "bells": bells,
    });
    serde_json::to_string(&doc).expect("данные сериализуются")
}

/// Тип занятия по предмету; пустая строка — тип не выводится.
pub fn kind(subj: &str) -> &'static str {
    for (name, kind) in KIND {
        if *name == subj {
            return kind;
        }
    }
    ""
}

const SCHEDULE: [&[Row]; 7] = [
    // понедельник
    &[
        Row {
            num: 1,
            start: "09:00",
            end: "10:35",
            subj: "Физическая культура",
            rooms: None,
            teachers: &[
                "ст.пр. Маркевич О.П.",
                "пр. Руденко Т.Н.",
                "ст.пр. Степанцов В.М.",
            ],
            weeks: Weeks::Both,
        },
        Row {
            num: 2,
            start: "10:50",
            end: "12:25",
            subj: "Математический анализ",
            rooms: Some("1-13"),
            teachers: &["доц. Кузьменкова И.А."],
            weeks: Weeks::Both,
        },
        Row {
            num: 3,
            start: "12:55",
            end: "14:30",
            subj: "История и теория кооперативного движения",
            rooms: Some("1-9"),
            teachers: &["доц. Котов И.С."],
            weeks: Weeks::Over,
        },
        Row {
            num: 3,
            start: "12:55",
            end: "14:30",
            subj: "Компьютерные информационные технологии",
            rooms: Some("1-2"),
            teachers: &["доц. Лебедева Е.В."],
            weeks: Weeks::Under,
        },
        Row {
            num: 4,
            start: "14:40",
            end: "16:15",
            subj: "Информационный час",
            rooms: Some("3-27"),
            teachers: &["ст.пр. Игнатьев А.М."],
            weeks: Weeks::Over,
        },
    ],
    // вторник
    &[
        Row {
            num: 2,
            start: "10:50",
            end: "12:25",
            subj: "Экономическая теория",
            rooms: Some("1-13"),
            teachers: &["ст.пр. Барабанова И.В."],
            weeks: Weeks::Both,
        },
        Row {
            num: 3,
            start: "12:55",
            end: "14:30",
            subj: "Математический анализ",
            rooms: Some("1-13"),
            teachers: &["доц. Кузьменкова И.А."],
            weeks: Weeks::Both,
        },
        Row {
            num: 4,
            start: "14:40",
            end: "16:15",
            subj: "Основы алгоритмизации и программирования",
            rooms: Some("1-14"),
            teachers: &["пр. Сыч Д.С."],
            weeks: Weeks::Both,
        },
        Row {
            num: 5,
            start: "16:25",
            end: "18:00",
            subj: "Основы алгоритмизации и программирования",
            rooms: Some("3-27,3-30"),
            teachers: &["пр. Сыч Д.С.", "пр. Шкрабков Я.Н."],
            weeks: Weeks::Both,
        },
    ],
    // среда
    &[
        Row {
            num: 1,
            start: "09:00",
            end: "10:35",
            subj: "Физическая культура",
            rooms: None,
            teachers: &[
                "ст.пр. Маркевич О.П.",
                "пр. Руденко Т.Н.",
                "ст.пр. Степанцов В.М.",
            ],
            weeks: Weeks::Both,
        },
        Row {
            num: 2,
            start: "10:50",
            end: "12:25",
            subj: "Иностранный язык",
            rooms: Some("2-3"),
            teachers: &["ст.пр. Селицкая Е.Ю."],
            weeks: Weeks::Both,
        },
        Row {
            num: 3,
            start: "12:55",
            end: "14:30",
            subj: "Иностранный язык",
            rooms: Some("2-3"),
            teachers: &["ст.пр. Селицкая Е.Ю."],
            weeks: Weeks::Both,
        },
    ],
    // четверг
    &[
        Row {
            num: 1,
            start: "09:00",
            end: "10:35",
            subj: "Операционные системы",
            rooms: Some("3-36,3-24"),
            teachers: &["ст.пр. Воруева В.И.", "ст.пр. Сон С.Б."],
            weeks: Weeks::Over,
        },
        Row {
            num: 2,
            start: "10:50",
            end: "12:25",
            subj: "Линейная алгебра и аналитическая геометрия",
            rooms: Some("1-25"),
            teachers: &["доц. Кузьменкова И.А."],
            weeks: Weeks::Over,
        },
        Row {
            num: 2,
            start: "10:50",
            end: "12:25",
            subj:
                "Великая Отечественная война советского народа (в контексте Второй мировой войны)",
            rooms: Some("1-2"),
            teachers: &["доц. Котов И.С."],
            weeks: Weeks::Under,
        },
        Row {
            num: 3,
            start: "12:55",
            end: "14:30",
            subj: "Компьютерные информационные технологии",
            rooms: Some("2-22,3-16"),
            teachers: &["ст.пр. Конша И.Г.", "пр.-ст. Днепровский А.Р."],
            weeks: Weeks::Over,
        },
        Row {
            num: 3,
            start: "12:55",
            end: "14:30",
            subj: "История и теория кооперативного движения",
            rooms: Some("1-2"),
            teachers: &["доц. Котов И.С."],
            weeks: Weeks::Under,
        },
        Row {
            num: 4,
            start: "14:40",
            end: "16:15",
            subj: "История и теория кооперативного движения",
            rooms: Some("1-10"),
            teachers: &["доц. Котов И.С."],
            weeks: Weeks::Over,
        },
        Row {
            num: 4,
            start: "14:40",
            end: "16:15",
            subj: "Компьютерные информационные технологии",
            rooms: Some("2-22,3-16"),
            teachers: &["ст.пр. Конша И.Г.", "пр.-ст. Днепровский А.Р."],
            weeks: Weeks::Under,
        },
        Row {
            num: 5,
            start: "16:25",
            end: "18:00",
            subj: "Информационный час",
            rooms: Some("1-21"),
            teachers: &["ст.пр. Игнатьев А.М."],
            weeks: Weeks::Under,
        },
    ],
    // пятница
    &[
        Row {
            num: 1,
            start: "09:00",
            end: "10:35",
            subj: "Экономическая теория",
            rooms: Some("2-11"),
            teachers: &["ст.пр. Барабанова И.В."],
            weeks: Weeks::Both,
        },
        Row {
            num: 2,
            start: "10:50",
            end: "12:25",
            subj: "Современная политэкономия",
            rooms: Some("1-22"),
            teachers: &["ст.пр. Чернявский М.Р."],
            weeks: Weeks::Both,
        },
        Row {
            num: 3,
            start: "12:55",
            end: "14:30",
            subj: "Линейная алгебра и аналитическая геометрия",
            rooms: Some("1-21"),
            teachers: &["доц. Кузьменкова И.А."],
            weeks: Weeks::Over,
        },
        Row {
            num: 3,
            start: "12:55",
            end: "14:30",
            subj: "Операционные системы",
            rooms: Some("3-36,3-24"),
            teachers: &["ст.пр. Воруева В.И.", "ст.пр. Сон С.Б."],
            weeks: Weeks::Under,
        },
        Row {
            num: 4,
            start: "14:40",
            end: "16:15",
            subj: "Современная политэкономия",
            rooms: Some("1-21"),
            teachers: &["ст.пр. Чернявский М.Р."],
            weeks: Weeks::Over,
        },
    ],
    // суббота (пары только под чертой)
    &[
        Row {
            num: 1,
            start: "09:00",
            end: "10:35",
            subj: "Линейная алгебра и аналитическая геометрия",
            rooms: Some("1-9"),
            teachers: &["доц. Кузьменкова И.А."],
            weeks: Weeks::Under,
        },
        Row {
            num: 2,
            start: "10:50",
            end: "12:25",
            subj: "Линейная алгебра и аналитическая геометрия",
            rooms: Some("1-9"),
            teachers: &["доц. Кузьменкова И.А."],
            weeks: Weeks::Under,
        },
    ],
    // воскресенье
    &[],
];

/// Тип занятия по предмету: «Лекция» / «Практика» / "" (без типа).
/// Источник — скриншоты оригинального бота и структура официального стабильного
/// расписания (две аудитории и два преподавателя = подгруппы = практика).
const KIND: &[(&str, &str)] = &[
    ("Физическая культура", "Практика"),
    ("Математический анализ", "Лекция"),
    ("Экономическая теория", "Лекция"),
    ("История и теория кооперативного движения", "Лекция"),
    ("Компьютерные информационные технологии", "Практика"),
    ("Информационный час", ""),
    ("Основы алгоритмизации и программирования", "Практика"),
    ("Иностранный язык", "Практика"),
    ("Операционные системы", "Практика"),
    ("Линейная алгебра и аналитическая геометрия", "Лекция"),
    (
        "Великая Отечественная война советского народа (в контексте Второй мировой войны)",
        "Лекция",
    ),
    ("Современная политэкономия", "Лекция"),
];

/// Расписание звонков: номер, начало, конец, 1-й час, 2-й час, перерыв после пары.
pub struct Bell {
    pub num: u8,
    pub start: &'static str,
    pub end: &'static str,
    pub first: &'static str,
    pub second: &'static str,
    pub br: Option<&'static str>,
}

pub const BELLS: &[Bell] = &[
    Bell {
        num: 1,
        start: "09:00",
        end: "10:35",
        first: "09:00–09:45",
        second: "09:50–10:35",
        br: Some("15 мин"),
    },
    Bell {
        num: 2,
        start: "10:50",
        end: "12:25",
        first: "10:50–11:35",
        second: "11:40–12:25",
        br: Some("30 мин"),
    },
    Bell {
        num: 3,
        start: "12:55",
        end: "14:30",
        first: "12:55–13:40",
        second: "13:45–14:30",
        br: Some("10 мин"),
    },
    Bell {
        num: 4,
        start: "14:40",
        end: "16:15",
        first: "14:40–15:25",
        second: "15:30–16:15",
        br: Some("10 мин"),
    },
    Bell {
        num: 5,
        start: "16:25",
        end: "18:00",
        first: "16:25–17:10",
        second: "17:15–18:00",
        br: Some("30 мин"),
    },
    Bell {
        num: 6,
        start: "18:30",
        end: "20:05",
        first: "18:30–19:15",
        second: "19:20–20:05",
        br: Some("10 мин"),
    },
    Bell {
        num: 7,
        start: "20:15",
        end: "21:50",
        first: "20:15–21:00",
        second: "21:05–21:50",
        br: None,
    },
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anchor_dates_from_official_table() {
        // даты из официальной таблицы bteu.by — руками не менять под код
        let cases = [
            ((2026, 9, 21), Weeks::Under),
            ((2026, 10, 26), Weeks::Over),
            ((2026, 11, 2), Weeks::Under),
            ((2026, 12, 21), Weeks::Over),
            ((2026, 12, 28), Weeks::Under),
            ((2026, 10, 17), Weeks::Over),
        ];
        for ((y, m, d), want) in cases {
            assert_eq!(week_mark(Date::new(y, m, d).unwrap()), want, "{y}-{m}-{d}");
        }
    }

    #[test]
    fn outside_semester_has_no_pairs() {
        assert!(day_pairs(Date::new(2026, 8, 31).unwrap()).is_empty());
        assert!(day_pairs(Date::new(2027, 1, 1).unwrap()).is_empty());
        assert!(!day_pairs(Date::new(2026, 9, 1).unwrap()).is_empty());
    }

    fn sub(num: u8, start: &'static str, end: &'static str, subj: &'static str) -> Sub {
        Sub {
            day: (2026, 11, 5),
            num,
            start,
            end,
            subj,
            rooms: Some("1-9"),
            teachers: &["доц. Кузьменкова И.А."],
        }
    }

    #[test]
    fn substitution_replaces_only_its_slot() {
        let d = Date::new(2026, 11, 5).unwrap();
        let base = day_pairs(d);
        let s = sub(2, "10:50", "12:25", "Консультация по математическому анализу");
        let with = day_pairs_with(d, &[s]);
        assert_eq!(with.len(), base.len(), "замена не меняет число пар дня");
        let p = with.iter().find(|p| p.num == 2).expect("слот 2 остался");
        assert_eq!(p.subj, "Консультация по математическому анализу");
        assert!(p.sub, "замена помечена");
        // остальные слоты — те же строки таблицы и без пометки
        for x in with.iter().filter(|p| p.num != 2) {
            let before = base.iter().find(|b| b.num == x.num).expect("та же пара");
            assert_eq!(x.subj, before.subj);
            assert!(!x.sub);
        }
    }

    #[test]
    fn substitution_without_time_cancels_the_slot() {
        let d = Date::new(2026, 11, 5).unwrap();
        let base = day_pairs(d);
        let with = day_pairs_with(d, &[sub(3, "", "", "")]);
        assert_eq!(with.len(), base.len() - 1, "отменённая пара исчезает");
        assert!(!with.iter().any(|p| p.num == 3));
    }

    #[test]
    fn substitution_can_add_a_pair_to_an_empty_slot() {
        let d = Date::new(2026, 11, 5).unwrap();
        // в под-неделю на четверге первой пары нет — замена её добавляет
        assert!(!day_pairs(d).iter().any(|p| p.num == 1));
        let with = day_pairs_with(d, &[sub(1, "09:00", "10:35", "Пересдача по физкультуре")]);
        let p = with.first().expect("пара стала первой");
        assert_eq!(p.num, 1);
        assert!(p.sub);
    }

    #[test]
    fn substitution_applies_only_to_its_own_date() {
        let a = sub(2, "10:50", "12:25", "Консультация");
        let b = Sub {
            day: (2026, 11, 6),
            num: 4,
            start: "14:40",
            end: "16:15",
            subj: "Пересдача",
            rooms: None,
            teachers: &["доц. Котов И.С."],
        };
        let all = [a, b];
        assert_eq!(subs_on(Date::new(2026, 11, 5).unwrap(), &all).len(), 1);
        assert_eq!(subs_on(Date::new(2026, 11, 6).unwrap(), &all).len(), 1);
        assert!(subs_on(Date::new(2026, 11, 7).unwrap(), &all).is_empty());
        // и дата вне семестра не получает замен: там и так «пар нет»
        assert!(day_pairs(Date::new(2026, 11, 5).unwrap()).iter().all(|p| !p.sub));
    }
}
