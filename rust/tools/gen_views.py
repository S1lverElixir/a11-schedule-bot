# -*- coding: utf-8 -*-
"""Снимки поведения нынешнего Python-бота — эталон для Rust-переписки.

Пишет rust/tests/fixtures/views.json: все текстовые экраны, клавиатуры и .ics
за длинный диапазон дат при замороженных часах. Rust обязан повторить каждый
случай байт-в-байт; сравнение — rust/tests/parity.rs.

Запуск из корня проекта: python -X utf8 rust/tools/gen_views.py
"""

import json
import os
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

# Секреты не читаем: подставные значения, а .env не загружаем
os.environ["BOT_TOKEN"] = "0:snapshot"
os.environ["MY_TELEGRAM_ID"] = "1"
import dotenv  # noqa: E402

dotenv.load_dotenv = lambda *a, **k: None  # noqa: E731

import bot  # noqa: E402
import schedule_data as sd  # noqa: E402

TZ = timezone(timedelta(hours=3))

START = date(2026, 5, 1)
END = date(2027, 4, 30)


class FrozenDatetime(datetime):
    """Подмена bot.datetime: часы стоят там, куда их поставили."""

    frozen = datetime(2026, 10, 23, 8, 0, tzinfo=TZ)

    @classmethod
    def now(cls, tz=None):
        return cls.frozen.astimezone(tz) if tz is not None else cls.frozen


bot.datetime = FrozenDatetime

CASES = []


def freeze(d, hh=0, mm=0, ss=0):
    FrozenDatetime.frozen = datetime(d.year, d.month, d.day, hh, mm, ss, tzinfo=TZ)


def add(name, kind, value):
    CASES.append({"name": name, "kind": kind, "value": value})


def kb_rows(markup):
    """Inline/reply-клавиатура в каноничном виде: строки, клетки, порядок сохранён."""
    rows = markup.get("keyboard") or markup.get("inline_keyboard") or []
    return [[{"t": c["text"], "c": c.get("callback_data", "")} for c in row] for row in rows]


def dates():
    d = START
    while d <= END:
        yield d
        d += timedelta(days=1)


def mondays():
    d = START - timedelta(days=START.weekday())
    while d <= END:
        yield d
        d += timedelta(days=7)


def main():
    # приветствие и постоянная клавиатура
    freeze(date(2026, 10, 23), 8, 0)
    add("greeting", "text", bot.GREETING)
    add("main_kb", "reply_kb", kb_rows(bot.main_kb()))
    add("bells", "text", bot.bells_text())

    for n in range(0, 26):
        add(f"pairs_word|{n}", "text", bot.pairs_word(n))

    # данные: что бот считает парами дня (виды скрывают преподавателей)
    for d in dates():
        freeze(d, 8, 0)
        pairs = bot.day_pairs(d)
        add(f"pairs|{d.isoformat()}", "pairs",
            [[p[0], p[1], p[2], p[3], p[4] or "", list(p[5]), p[6]] for p in pairs])
        add(f"week_mark|{d.isoformat()}", "text", sd.week_mark(d))

    # дневной экран: утро, разгар пар, вечер — в сам день
    for d in dates():
        for hh, mm in ((8, 0), (12, 56), (23, 0)):
            freeze(d, hh, mm)
            add(f"day_text|{d.isoformat()}|{hh:02d}:{mm:02d}|", "text", bot.day_text(d, ""))

    # границы пар: моменты начала и конца, перемены
    edges = []
    for base in (START, sd.SEMESTER_START, sd.ANCHOR_MONDAY,
                 sd.SEMESTER_END - timedelta(days=6), END):
        for shift in (-2, -1, 0, 1, 2):
            edges.append(base + timedelta(days=shift))
    edges += [sd.ANCHOR_MONDAY + timedelta(days=5), sd.ANCHOR_MONDAY - timedelta(days=2)]
    for d in dict.fromkeys(edges):
        for hh, mm in ((7, 0), (8, 59), (9, 0), (9, 45), (9, 49), (9, 50), (10, 35),
                       (10, 36), (10, 49), (10, 50), (12, 54), (12, 55), (14, 30),
                       (14, 40), (16, 15), (16, 16), (16, 25), (18, 0), (20, 30)):
            freeze(d, hh, mm)
            add(f"day_text|{d.isoformat()}|{hh:02d}:{mm:02d}|", "text", bot.day_text(d, ""))
            add(f"now_text|{d.isoformat()}|{hh:02d}:{mm:02d}", "text", bot.now_text())
        for suffix in (" · сегодня", " · завтра", " · <b>x"):
            freeze(d, 12, 0)
            add(f"day_text|{d.isoformat()}|12:00|{suffix}", "text", bot.day_text(d, suffix))

    # «Сейчас» по всему диапазону
    for d in dates():
        for hh, mm in ((7, 0), (8, 30), (9, 20), (10, 40), (12, 56), (14, 0),
                       (16, 16), (18, 5), (19, 30), (23, 30)):
            freeze(d, hh, mm)
            add(f"now_text|{d.isoformat()}|{hh:02d}:{mm:02d}", "text", bot.now_text())

    # неделя: снимок в разные «сегодня» — от этого зависит пометка дня
    for mon in mondays():
        for now_day in (mon, mon + timedelta(days=2), mon + timedelta(days=6),
                        mon - timedelta(days=30), mon + timedelta(days=400)):
            freeze(now_day, 12, 0)
            add(f"week|{mon.isoformat()}|{now_day.isoformat()}", "text", bot.render_week(mon))
            add(f"week_text|{now_day.isoformat()}", "text", bot.week_text(now_day))
        add(f"week_kb|{mon.isoformat()}", "inline_kb", kb_rows(bot.week_kb(mon)))

    # календарь: все месяцы вокруг семестра, точка «сегодня» в разных месяцах
    months = [(2026, m) for m in range(5, 13)] + [(2027, m) for m in range(1, 5)]
    for y, m in months:
        for now_day in (date(2026, 5, 15), date(2026, 10, 23), date(2026, 10, 1),
                        date(2026, 12, 31), date(2027, 3, 15), date(2027, 4, 30)):
            freeze(now_day, 12, 0)
            add(f"calendar_kb|{y:04d}-{m:02d}|{now_day.isoformat()}", "inline_kb",
                kb_rows(bot.calendar_kb(y, m)))

    # .ics: DTSTAMP от замороженных часов, поэтому время в имени случая
    for mon in mondays():
        freeze(mon, 12, 34, 56)
        add(f"ics|{mon.isoformat()}|123456", "bytes",
            bot.ics_for_week(mon).decode("utf-8"))

    # утренняя сводка
    for d in dates():
        freeze(d, 7, 30)
        add(f"morning|{d.isoformat()}|07:30", "text", bot.morning_text(d))

    out = Path(
        os.environ.get("VIEWS_OUT")
        or (Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "views.json")
    )
    out.parent.mkdir(parents=True, exist_ok=True)
    # повторы имён (одна дата попадает в два цикла) — оставляем первый
    unique = {}
    for c in CASES:
        unique.setdefault(c["name"], c)
    cases = list(unique.values())
    payload = {
        "generator": "rust/tools/gen_views.py",
        "freeze_default": "2026-10-23T08:00:00+03:00",
        "cases": cases,
    }
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=0), encoding="utf-8")
    kinds = {}
    for c in cases:
        kinds[c["kind"]] = kinds.get(c["kind"], 0) + 1
    print(f"случаев: {len(cases)} {kinds}")
    print(f"файл: {out} ({out.stat().st_size / 1024:.0f} КиБ)")


if __name__ == "__main__":
    main()
