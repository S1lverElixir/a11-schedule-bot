//! Данные расписания группы А-11 — единственный источник правды.
//!
//! Имена предметов, аудитории, преподаватели и границы копируются как есть,
//! без «улучшений» и переименований.
//!
//! Запись пары: номер, начало, конец, предмет, аудитории, преподаватели, недели, тип.
//! - аудитории — строка как в таблице («2-11», «3-36,3-24») или null без аудитории;
//! - недели: Both — в обе, Over — только над чертой, Under — только под чертой;
//! - тип: «Лекция»/«Практика»/«» — без типа идут инф. час и замены;
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
//! Тип пары взят из регистра предмета в a-1.xls: набрано заглавными — лекция,
//! строчными — практика; исключение — инф. час, он набран заглавными, но типа
//! не имеет. Остальные пары сверены механически и подтверждены другим ботом
//! расписания А-11 (четверг под-недели) и занятиями группы: матан в понедельник —
//! практика, во вторник — лекция. Сайт типов не публикует, старое правило
//! «одна аудитория + один преподаватель = лекция» ошибалось на 8 парах.
//!
//! Фамилия преподавателя матана/линала — Кузменкова, без мягкого знака: так
//! в файлах деканата, на кадровой странице её кафедры и в записи диссертации
//! в каталоге НЛБ; «Кузьменкова» на странице НИО — описка (смешали с
//! однофамилицей Н.В. из товароведения, у которой с ь везде).

import { Date, pad2, pad4 } from "./date.ts";

/// Границы семестра: пределы календаря «Выбрать день»; вне их — каникулы, «пар нет».
export const SEMESTER_START: Date = Date.newConst(2026, 9, 1);
export const SEMESTER_END: Date = Date.newConst(2026, 12, 31);

/// Якорь чередования недель: неделя с этого понедельника — ПОД чертой.
/// Подтверждено таблицей «Формирование учебных недель на 1 семестр 2026/2027» на bteu.by.
export const ANCHOR_MONDAY: Date = Date.newConst(2026, 9, 21);

export type Weeks = "Both" | "Over" | "Under";

export function weeksLabel(w: Weeks): string {
  if (w === "Under") return "под";
  if (w === "Over") return "над";
  return "both";
}

/// Черта недели, содержащей день: чередование от якоря в обе стороны.
export function weekMark(day: Date): Weeks {
  const monday = day.addDays(-day.weekday());
  const weeks = Math.floor(monday.daysSince(ANCHOR_MONDAY) / 7);
  return weeks % 2 === 0 ? "Under" : "Over";
}

/// Метка недели строкой: «над», «под» или «both».
export function weekLabel(day: Date): string {
  return weeksLabel(weekMark(day));
}

/// Строка стабильного расписания: номер, начало, конец, предмет, аудитории,
/// преподаватели, недели.
interface Row {
  num: number;
  start: string;
  end: string;
  subj: string;
  rooms: string | null;
  teachers: string[];
  weeks: Weeks;
  kind: string;
}

/// То, что бот показывает на слоте дня: строка таблицы (sub=false) либо замена
/// этого дня (sub=true). У отменённой пары начало, конец и предмет пустые.
export interface Pair {
  num: number;
  start: string;
  end: string;
  subj: string;
  rooms: string | null;
  teachers: string[];
  weeks: Weeks;
  kind: string;
  sub: boolean;
}

/// Датная замена: в этот день слот num занимает другое занятие. Пустые start и
/// subj — занятие в этом слоте в этот день отменено, и в расписании его нет.
export interface Sub {
  day: readonly [number, number, number];
  num: number;
  start: string;
  end: string;
  subj: string;
  rooms: string | null;
  teachers: string[];
}

/// Замены на текущий семестр: их выкладывает деканат на странице «Начитка» и в
/// графике кураторского часа. Сверяет tools/check_site.py; пусто — значит по
/// сайту замен нет, и бот показывает только стабильное расписание.
export const SUBSTITUTIONS: readonly Sub[] = [
  // график «ЧАС КУРАТОРА ФЭУ» на bteu.by: 16.12 в 12:55 ауд. 3-16 вместо 3-й пары
  {
    day: [2026, 12, 16],
    num: 3,
    start: "12:55",
    end: "14:30",
    subj: "Час куратора",
    rooms: "3-16",
    teachers: ["ст.пр. Игнатьев А.М."],
  },
];

function fromRow(r: Row): Pair {
  return {
    num: r.num,
    start: r.start,
    end: r.end,
    subj: r.subj,
    rooms: r.rooms,
    teachers: r.teachers,
    weeks: r.weeks,
    kind: r.kind,
    sub: false,
  };
}

function fromSub(s: Sub): Pair {
  return {
    num: s.num,
    start: s.start,
    end: s.end,
    subj: s.subj,
    rooms: s.rooms,
    teachers: s.teachers,
    // дата задана прямо, черта недели к замене не применяется
    weeks: "Both",
    kind: "",
    sub: true,
  };
}

export function subsOn(d: Date, all: readonly Sub[]): Sub[] {
  return all.filter((s) => {
    const sd = Date.new(s.day[0], s.day[1], s.day[2]);
    return sd !== null && sd.equals(d);
  });
}

/// Пары дня: стабильная таблица с учётом черты, поверх — датные замены этого дня.
/// Вне семестра — каникулы, пар нет.
export function dayPairs(d: Date): Pair[] {
  return dayPairsWith(d, subsOn(d, SUBSTITUTIONS));
}

/// Номера отменённых слотов дня: замены с пустым временем, по порядку номеров.
/// Отмена убирает пару из dayPairs — эта функция возвращает её номер, чтобы вид
/// дня мог пометить «N-я пара отменена».
export function cancelledNums(d: Date): number[] {
  return subsOn(d, SUBSTITUTIONS)
    .filter((s) => s.start === "" && s.end === "")
    .map((s) => s.num)
    .sort((a, b) => a - b);
}

/// Тот же расчёт с готовым списком замен этого дня — чтобы логику можно было
/// проверить без правки константы.
export function dayPairsWith(d: Date, subs: readonly Sub[]): Pair[] {
  if (!(SEMESTER_START.days() <= d.days() && d.days() <= SEMESTER_END.days())) {
    return [];
  }
  const mark = weekMark(d);
  const out: Pair[] = SCHEDULE[d.weekday()]!
    .filter((p) => p.weeks === "Both" || p.weeks === mark)
    .filter((p) => !subs.some((s) => s.num === p.num))
    .map(fromRow);
  out.push(...subs.filter((s) => s.start !== "").map(fromSub));
  out.sort((a, b) => a.num - b.num);
  return out;
}

const SCHEDULE: readonly (readonly Row[])[] = [
  // понедельник
  [
    {
      num: 1,
      start: "09:00",
      end: "10:35",
      subj: "Физическая культура",
      rooms: null,
      teachers: [
        "ст.пр. Маркевич О.П.",
        "пр. Руденко Т.Н.",
        "ст.пр. Степанцов В.М.",
      ],
      weeks: "Both",
      kind: "Практика",
    },
    {
      num: 2,
      start: "10:50",
      end: "12:25",
      subj: "Математический анализ",
      rooms: "1-13",
      teachers: ["доц. Кузменкова И.А."],
      weeks: "Both",
      kind: "Практика",
    },
    {
      num: 3,
      start: "12:55",
      end: "14:30",
      subj: "История и теория кооперативного движения",
      rooms: "1-9",
      teachers: ["доц. Котов И.С."],
      weeks: "Over",
      kind: "Практика",
    },
    {
      num: 3,
      start: "12:55",
      end: "14:30",
      subj: "Компьютерные информационные технологии",
      rooms: "1-2",
      teachers: ["доц. Лебедева Е.В."],
      weeks: "Under",
      kind: "Лекция",
    },
    {
      num: 4,
      start: "14:40",
      end: "16:15",
      subj: "Информационный час",
      rooms: "3-27",
      teachers: ["ст.пр. Игнатьев А.М."],
      weeks: "Over",
      kind: "",
    },
  ],
  // вторник
  [
    {
      num: 2,
      start: "10:50",
      end: "12:25",
      subj: "Экономическая теория",
      rooms: "1-13",
      teachers: ["ст.пр. Барабанова И.В."],
      weeks: "Both",
      kind: "Практика",
    },
    {
      num: 3,
      start: "12:55",
      end: "14:30",
      subj: "Математический анализ",
      rooms: "1-13",
      teachers: ["доц. Кузменкова И.А."],
      weeks: "Both",
      kind: "Лекция",
    },
    {
      num: 4,
      start: "14:40",
      end: "16:15",
      subj: "Основы алгоритмизации и программирования",
      rooms: "1-14",
      teachers: ["пр. Сыч Д.С."],
      weeks: "Both",
      kind: "Лекция",
    },
    {
      num: 5,
      start: "16:25",
      end: "18:00",
      subj: "Основы алгоритмизации и программирования",
      rooms: "3-27,3-30",
      teachers: ["пр. Сыч Д.С.", "пр. Шкрабков Я.Н."],
      weeks: "Both",
      kind: "Практика",
    },
  ],
  // среда
  [
    {
      num: 1,
      start: "09:00",
      end: "10:35",
      subj: "Физическая культура",
      rooms: null,
      teachers: [
        "ст.пр. Маркевич О.П.",
        "пр. Руденко Т.Н.",
        "ст.пр. Степанцов В.М.",
      ],
      weeks: "Both",
      kind: "Практика",
    },
    {
      num: 2,
      start: "10:50",
      end: "12:25",
      subj: "Иностранный язык",
      rooms: "2-3",
      teachers: ["ст.пр. Селицкая Е.Ю."],
      weeks: "Both",
      kind: "Практика",
    },
    {
      num: 3,
      start: "12:55",
      end: "14:30",
      subj: "Иностранный язык",
      rooms: "2-3",
      teachers: ["ст.пр. Селицкая Е.Ю."],
      weeks: "Both",
      kind: "Практика",
    },
  ],
  // четверг
  [
    {
      num: 1,
      start: "09:00",
      end: "10:35",
      subj: "Операционные системы",
      rooms: "3-36,3-24",
      teachers: ["ст.пр. Воруева В.И.", "ст.пр. Сон С.Б."],
      weeks: "Over",
      kind: "Практика",
    },
    {
      num: 2,
      start: "10:50",
      end: "12:25",
      subj: "Линейная алгебра и аналитическая геометрия",
      rooms: "1-25",
      teachers: ["доц. Кузменкова И.А."],
      weeks: "Over",
      kind: "Лекция",
    },
    {
      num: 2,
      start: "10:50",
      end: "12:25",
      subj: "Великая Отечественная война советского народа (в контексте Второй мировой войны)",
      rooms: "1-2",
      teachers: ["доц. Котов И.С."],
      weeks: "Under",
      kind: "Лекция",
    },
    {
      num: 3,
      start: "12:55",
      end: "14:30",
      subj: "Компьютерные информационные технологии",
      rooms: "2-22,3-16",
      teachers: ["ст.пр. Конша И.Г.", "пр.-ст. Днепровский А.Р."],
      weeks: "Over",
      kind: "Практика",
    },
    {
      num: 3,
      start: "12:55",
      end: "14:30",
      subj: "История и теория кооперативного движения",
      rooms: "1-2",
      teachers: ["доц. Котов И.С."],
      weeks: "Under",
      kind: "Лекция",
    },
    {
      num: 4,
      start: "14:40",
      end: "16:15",
      subj: "История и теория кооперативного движения",
      rooms: "1-10",
      teachers: ["доц. Котов И.С."],
      weeks: "Over",
      kind: "Лекция",
    },
    {
      num: 4,
      start: "14:40",
      end: "16:15",
      subj: "Компьютерные информационные технологии",
      rooms: "2-22,3-16",
      teachers: ["ст.пр. Конша И.Г.", "пр.-ст. Днепровский А.Р."],
      weeks: "Under",
      kind: "Практика",
    },
    {
      num: 5,
      start: "16:25",
      end: "18:00",
      subj: "Информационный час",
      rooms: "1-21",
      teachers: ["ст.пр. Игнатьев А.М."],
      weeks: "Under",
      kind: "",
    },
  ],
  // пятница
  [
    {
      num: 1,
      start: "09:00",
      end: "10:35",
      subj: "Экономическая теория",
      rooms: "2-11",
      teachers: ["ст.пр. Барабанова И.В."],
      weeks: "Both",
      kind: "Лекция",
    },
    {
      num: 2,
      start: "10:50",
      end: "12:25",
      subj: "Современная политэкономия",
      rooms: "1-22",
      teachers: ["ст.пр. Чернявский М.Р."],
      weeks: "Both",
      kind: "Лекция",
    },
    {
      num: 3,
      start: "12:55",
      end: "14:30",
      subj: "Линейная алгебра и аналитическая геометрия",
      rooms: "1-21",
      teachers: ["доц. Кузменкова И.А."],
      weeks: "Over",
      kind: "Практика",
    },
    {
      num: 3,
      start: "12:55",
      end: "14:30",
      subj: "Операционные системы",
      rooms: "3-36,3-24",
      teachers: ["ст.пр. Воруева В.И.", "ст.пр. Сон С.Б."],
      weeks: "Under",
      kind: "Практика",
    },
    {
      num: 4,
      start: "14:40",
      end: "16:15",
      subj: "Современная политэкономия",
      rooms: "1-21",
      teachers: ["ст.пр. Чернявский М.Р."],
      weeks: "Over",
      kind: "Практика",
    },
  ],
  // суббота (пары только под чертой)
  [
    {
      num: 1,
      start: "09:00",
      end: "10:35",
      subj: "Линейная алгебра и аналитическая геометрия",
      rooms: "1-9",
      teachers: ["доц. Кузменкова И.А."],
      weeks: "Under",
      kind: "Лекция",
    },
    {
      num: 2,
      start: "10:50",
      end: "12:25",
      subj: "Линейная алгебра и аналитическая геометрия",
      rooms: "1-9",
      teachers: ["доц. Кузменкова И.А."],
      weeks: "Under",
      kind: "Практика",
    },
  ],
  // воскресенье
  [],
];

/// Расписание звонков: номер, начало, конец, 1-й час, 2-й час, перерыв после пары.
interface Bell {
  num: number;
  start: string;
  end: string;
  first: string;
  second: string;
  br: string | null;
}

export const BELLS: readonly Bell[] = [
  {
    num: 1,
    start: "09:00",
    end: "10:35",
    first: "09:00–09:45",
    second: "09:50–10:35",
    br: "15 мин",
  },
  {
    num: 2,
    start: "10:50",
    end: "12:25",
    first: "10:50–11:35",
    second: "11:40–12:25",
    br: "30 мин",
  },
  {
    num: 3,
    start: "12:55",
    end: "14:30",
    first: "12:55–13:40",
    second: "13:45–14:30",
    br: "10 мин",
  },
  {
    num: 4,
    start: "14:40",
    end: "16:15",
    first: "14:40–15:25",
    second: "15:30–16:15",
    br: "10 мин",
  },
  {
    num: 5,
    start: "16:25",
    end: "18:00",
    first: "16:25–17:10",
    second: "17:15–18:00",
    br: "30 мин",
  },
  {
    num: 6,
    start: "18:30",
    end: "20:05",
    first: "18:30–19:15",
    second: "19:20–20:05",
    br: "10 мин",
  },
  {
    num: 7,
    start: "20:15",
    end: "21:50",
    first: "20:15–21:00",
    second: "21:05–21:50",
    br: null,
  },
];

/// Машинный дамп данных для сверки с сайтом: его печатает workers/tools/dump_schedule.ts,
/// читает tools/check_site.py. Неделя строкой («над»/«под»/«both»), замены датой ISO,
/// отсутствующая аудитория — пустая строка вместо null.
export function dumpSchedule(): object {
  const days = SCHEDULE.map((rows) =>
    rows.map((r) => ({
      num: r.num,
      start: r.start,
      end: r.end,
      subj: r.subj,
      rooms: r.rooms ?? "",
      teachers: r.teachers,
      weeks: weeksLabel(r.weeks),
      kind: r.kind,
    })),
  );
  const subs = SUBSTITUTIONS.map((s) => ({
    date: `${pad4(s.day[0])}-${pad2(s.day[1])}-${pad2(s.day[2])}`,
    num: s.num,
    start: s.start,
    end: s.end,
    subj: s.subj,
    rooms: s.rooms ?? "",
    teachers: s.teachers,
  }));
  const bells = BELLS.map((b) => ({
    num: b.num,
    start: b.start,
    end: b.end,
    first: b.first,
    second: b.second,
    break: b.br ?? "",
  }));
  return {
    semester: [SEMESTER_START.fmtIso(), SEMESTER_END.fmtIso()],
    anchor_monday: ANCHOR_MONDAY.fmtIso(),
    days,
    substitutions: subs,
    bells,
  };
}
