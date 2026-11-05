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

/// Запись пары: номер, начало, конец, предмет, аудитории, преподаватели, недели.
#[derive(Clone, Copy)]
pub struct Pair {
    pub num: u8,
    pub start: &'static str,
    pub end: &'static str,
    pub subj: &'static str,
    pub rooms: Option<&'static str>,
    pub teachers: &'static [&'static str],
    pub weeks: Weeks,
}

/// Пары дня с учётом черты; вне семестра — каникулы, пар нет.
pub fn day_pairs(d: Date) -> Vec<&'static Pair> {
    if !(SEMESTER_START <= d && d <= SEMESTER_END) {
        return Vec::new();
    }
    let mark = week_mark(d);
    SCHEDULE[d.weekday() as usize]
        .iter()
        .filter(|p| p.weeks == Weeks::Both || p.weeks == mark)
        .collect()
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

const SCHEDULE: [&[Pair]; 7] = [
    // понедельник
    &[
        Pair {
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
        Pair {
            num: 2,
            start: "10:50",
            end: "12:25",
            subj: "Математический анализ",
            rooms: Some("1-13"),
            teachers: &["доц. Кузьменкова И.А."],
            weeks: Weeks::Both,
        },
        Pair {
            num: 3,
            start: "12:55",
            end: "14:30",
            subj: "История и теория кооперативного движения",
            rooms: Some("1-9"),
            teachers: &["доц. Котов И.С."],
            weeks: Weeks::Over,
        },
        Pair {
            num: 3,
            start: "12:55",
            end: "14:30",
            subj: "Компьютерные информационные технологии",
            rooms: Some("1-2"),
            teachers: &["доц. Лебедева Е.В."],
            weeks: Weeks::Under,
        },
        Pair {
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
        Pair {
            num: 2,
            start: "10:50",
            end: "12:25",
            subj: "Экономическая теория",
            rooms: Some("1-13"),
            teachers: &["ст.пр. Барабанова И.В."],
            weeks: Weeks::Both,
        },
        Pair {
            num: 3,
            start: "12:55",
            end: "14:30",
            subj: "Математический анализ",
            rooms: Some("1-13"),
            teachers: &["доц. Кузьменкова И.А."],
            weeks: Weeks::Both,
        },
        Pair {
            num: 4,
            start: "14:40",
            end: "16:15",
            subj: "Основы алгоритмизации и программирования",
            rooms: Some("1-14"),
            teachers: &["пр. Сыч Д.С."],
            weeks: Weeks::Both,
        },
        Pair {
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
        Pair {
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
        Pair {
            num: 2,
            start: "10:50",
            end: "12:25",
            subj: "Иностранный язык",
            rooms: Some("2-3"),
            teachers: &["ст.пр. Селицкая Е.Ю."],
            weeks: Weeks::Both,
        },
        Pair {
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
        Pair {
            num: 1,
            start: "09:00",
            end: "10:35",
            subj: "Операционные системы",
            rooms: Some("3-36,3-24"),
            teachers: &["ст.пр. Воруева В.И.", "ст.пр. Сон С.Б."],
            weeks: Weeks::Over,
        },
        Pair {
            num: 2,
            start: "10:50",
            end: "12:25",
            subj: "Линейная алгебра и аналитическая геометрия",
            rooms: Some("1-25"),
            teachers: &["доц. Кузьменкова И.А."],
            weeks: Weeks::Over,
        },
        Pair {
            num: 2,
            start: "10:50",
            end: "12:25",
            subj:
                "Великая Отечественная война советского народа (в контексте Второй мировой войны)",
            rooms: Some("1-2"),
            teachers: &["доц. Котов И.С."],
            weeks: Weeks::Under,
        },
        Pair {
            num: 3,
            start: "12:55",
            end: "14:30",
            subj: "Компьютерные информационные технологии",
            rooms: Some("2-22,3-16"),
            teachers: &["ст.пр. Конша И.Г.", "пр.-ст. Днепровский А.Р."],
            weeks: Weeks::Over,
        },
        Pair {
            num: 3,
            start: "12:55",
            end: "14:30",
            subj: "История и теория кооперативного движения",
            rooms: Some("1-2"),
            teachers: &["доц. Котов И.С."],
            weeks: Weeks::Under,
        },
        Pair {
            num: 4,
            start: "14:40",
            end: "16:15",
            subj: "История и теория кооперативного движения",
            rooms: Some("1-10"),
            teachers: &["доц. Котов И.С."],
            weeks: Weeks::Over,
        },
        Pair {
            num: 4,
            start: "14:40",
            end: "16:15",
            subj: "Компьютерные информационные технологии",
            rooms: Some("2-22,3-16"),
            teachers: &["ст.пр. Конша И.Г.", "пр.-ст. Днепровский А.Р."],
            weeks: Weeks::Under,
        },
        Pair {
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
        Pair {
            num: 1,
            start: "09:00",
            end: "10:35",
            subj: "Экономическая теория",
            rooms: Some("2-11"),
            teachers: &["ст.пр. Барабанова И.В."],
            weeks: Weeks::Both,
        },
        Pair {
            num: 2,
            start: "10:50",
            end: "12:25",
            subj: "Современная политэкономия",
            rooms: Some("1-22"),
            teachers: &["ст.пр. Чернявский М.Р."],
            weeks: Weeks::Both,
        },
        Pair {
            num: 3,
            start: "12:55",
            end: "14:30",
            subj: "Линейная алгебра и аналитическая геометрия",
            rooms: Some("1-21"),
            teachers: &["доц. Кузьменкова И.А."],
            weeks: Weeks::Over,
        },
        Pair {
            num: 3,
            start: "12:55",
            end: "14:30",
            subj: "Операционные системы",
            rooms: Some("3-36,3-24"),
            teachers: &["ст.пр. Воруева В.И.", "ст.пр. Сон С.Б."],
            weeks: Weeks::Under,
        },
        Pair {
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
        Pair {
            num: 1,
            start: "09:00",
            end: "10:35",
            subj: "Линейная алгебра и аналитическая геометрия",
            rooms: Some("1-9"),
            teachers: &["доц. Кузьменкова И.А."],
            weeks: Weeks::Under,
        },
        Pair {
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
}
