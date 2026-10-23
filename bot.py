# -*- coding: utf-8 -*-
"""Личный бот расписания группы А-11 (БТЭУ). aiogram 3.x, только long polling."""

import asyncio
import logging
import os
from datetime import date, datetime, timedelta, timezone

from aiogram import Bot, Dispatcher, F
from aiogram.filters import CommandStart
from aiogram.types import (
    CallbackQuery,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    KeyboardButton,
    Message,
    ReplyKeyboardMarkup,
)
from dotenv import load_dotenv

from schedule_data import (
    BELLS_TEXT,
    SCHEDULE,
    SEMESTER_END,
    SEMESTER_START,
    week_mark,
)

load_dotenv()
BOT_TOKEN = os.environ["BOT_TOKEN"]
OWNER_ID = int(os.environ["MY_TELEGRAM_ID"])

TZ = timezone(timedelta(hours=3))  # Минск, фиксированный UTC+3 — без pytz/zoneinfo

# Самопроверка чередования по утверждённым датам: 22.10.2026 — под чертой, 15.10.2026 — над чертой
assert week_mark(date(2026, 10, 22)) == "под" and week_mark(date(2026, 10, 15)) == "над"

WD_FULL = ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"]
WD_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]
MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
          "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"]

BTN_TODAY = "Сегодня"
BTN_TOMORROW = "Завтра"
BTN_WEEK = "Неделя"
BTN_BELLS = "Звонки"
BTN_PICK = "Выбрать день"
BUTTONS = {BTN_TODAY, BTN_TOMORROW, BTN_WEEK, BTN_BELLS, BTN_PICK}

GREETING = "Расписание группы А-11. Кнопки ниже."


def main_kb():
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text=BTN_TODAY), KeyboardButton(text=BTN_TOMORROW), KeyboardButton(text=BTN_WEEK)],
            [KeyboardButton(text=BTN_BELLS), KeyboardButton(text=BTN_PICK)],
        ],
        resize_keyboard=True,
    )


def hm(s):
    """«09:50» -> минуты от полуночи."""
    h, m = s.split(":")
    return int(h) * 60 + int(m)


def day_pairs(d):
    """Пары дня d с учётом черты; вне семестра — каникулы, пар нет."""
    if not (SEMESTER_START <= d <= SEMESTER_END):
        return []
    mark = week_mark(d)
    return [e for e in SCHEDULE[d.weekday()] if e[6] in ("both", mark)]


def status_line(pairs, now):
    """Статус сегодняшнего дня; now — минуты от полуночи.
    Времена берутся из записей SCHEDULE в schedule_data.py (начало/конец пары — это
    расписание звонков), собственных констант времени в bot.py нет.
    Границы: момент начала пары — уже пара, момент конца — уже перемена/окончание."""
    for i, (num, st, en, *_rest) in enumerate(pairs):
        s, e = hm(st), hm(en)
        if now < s:
            if i == 0:
                return f"до первой пары {s - now} мин"
            return f"перемена, до {num}-й пары {s - now} мин"
        if now < e:
            return f"идёт {num}-я пара, до конца {e - now} мин"
    return "занятия окончены"


def day_text(d, suffix=""):
    """Сообщение одного дня. Суффикс « · сегодня»/« · завтра» — только для кнопок
    «Сегодня»/«Завтра». Статус же (и строка «сегодня пар нет») привязан к самой
    дате: выводится для сегодняшнего дня любым способом, включая тап в календаре."""
    now = datetime.now(TZ)
    head = f"{WD_FULL[d.weekday()]}, {d:%d.%m.%Y}{suffix}\nНеделя {week_mark(d)} чертой"
    pairs = day_pairs(d)
    if not pairs:
        line = "сегодня пар нет" if d == now.date() else "пар нет"
        return f"{head}\n\n{line}"
    blocks = []
    for num, st, en, subj, rooms, teachers, _w in pairs:
        second = f"{subj}, ауд. {rooms}" if rooms else subj
        blocks.append(f"{num}-я пара {st}–{en}\n{second}\n{', '.join(teachers)}")
    text = head + "\n\n" + "\n\n".join(blocks)
    if d == now.date():
        text += "\n\n" + status_line(pairs, now.hour * 60 + now.minute)
    return text


def pairs_word(n):
    if n % 10 == 1 and n % 100 != 11:
        return "пара"
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return "пары"
    return "пар"


def week_text(d):
    """Компактная неделя, содержащая d: по строке на пару, без преподавателей."""
    monday = d - timedelta(days=d.weekday())
    lines = [f"Неделя {monday:%d.%m}–{monday + timedelta(days=6):%d.%m} · {week_mark(d)} чертой"]
    for i in range(7):
        day = monday + timedelta(days=i)
        pairs = day_pairs(day)
        lines.append("")
        lines.append(f"{WD_SHORT[i]} {day:%d.%m}")
        if not pairs:
            lines.append("пар нет")
            continue
        for num, st, _en, subj, rooms, _t, _w in pairs:
            lines.append(f"{num} ({st}) {subj}, ауд. {rooms}" if rooms else f"{num} ({st}) {subj}")
        lines.append(f"{len(pairs)} {pairs_word(len(pairs))}")
    return "\n".join(lines)


def next_month_first(y, m):
    return date(y + 1, 1, 1) if m == 12 else date(y, m + 1, 1)


def month_intersects(y, m):
    """Пересекается ли месяц с семестром — по этому признаку показываются стрелки."""
    return date(y, m, 1) <= SEMESTER_END and next_month_first(y, m) - timedelta(days=1) >= SEMESTER_START


def calendar_kb(y, m):
    first = date(y, m, 1)
    after = next_month_first(y, m)
    head = []
    prev = first - timedelta(days=1)
    if month_intersects(prev.year, prev.month):
        head.append(InlineKeyboardButton(text="‹", callback_data=f"cal:{prev:%Y-%m}"))
    head.append(InlineKeyboardButton(text=f"{MONTHS[m - 1]} {y}", callback_data="cal:x"))
    if month_intersects(after.year, after.month):
        head.append(InlineKeyboardButton(text="›", callback_data=f"cal:{after:%Y-%m}"))

    rows = [head]
    cell = first - timedelta(days=first.weekday())  # сетка с понедельника
    while cell < after:
        row = []
        for _ in range(7):
            # дни вне месяца или вне семестра — пустые неактивные клетки
            if cell.month == m and SEMESTER_START <= cell <= SEMESTER_END:
                row.append(InlineKeyboardButton(
                    text=str(cell.day), callback_data=f"cal:{cell:%Y-%m}:{cell.day:02d}"))
            else:
                row.append(InlineKeyboardButton(text=" ", callback_data="cal:x"))
            cell += timedelta(days=1)
        rows.append(row)
    return InlineKeyboardMarkup(inline_keyboard=rows)


async def cmd_start(msg: Message):
    await msg.answer(GREETING, reply_markup=main_kb())


async def on_reply(msg: Message):
    today = datetime.now(TZ).date()
    if msg.text == BTN_TODAY:
        await msg.answer(day_text(today, " · сегодня"))
    elif msg.text == BTN_TOMORROW:
        await msg.answer(day_text(today + timedelta(days=1), " · завтра"))
    elif msg.text == BTN_WEEK:
        await msg.answer(week_text(today))
    elif msg.text == BTN_BELLS:
        await msg.answer(BELLS_TEXT)
    else:  # BTN_PICK — сетка текущего месяца
        await msg.answer("Выберите дату:", reply_markup=calendar_kb(today.year, today.month))


async def on_calendar(call: CallbackQuery):
    # cal:2026-10:23 — дата; cal:2026-10 — листание месяца; cal:x — неактивная клетка
    parts = call.data.split(":")
    if parts[1] == "x":
        await call.answer()
        return
    y, m = (int(v) for v in parts[1].split("-"))
    if len(parts) == 3:
        # новое сообщение, календарь в чате остаётся
        await call.message.answer(day_text(date(y, m, int(parts[2]))))
    else:
        await call.message.edit_reply_markup(reply_markup=calendar_kb(y, m))
    await call.answer()


async def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    bot = Bot(BOT_TOKEN)
    dp = Dispatcher()
    only_owner = F.from_user.id == OWNER_ID
    dp.message.register(cmd_start, only_owner, CommandStart())
    dp.message.register(on_reply, only_owner, F.text.in_(BUTTONS))
    dp.callback_query.register(on_calendar, only_owner, F.data.startswith("cal:"))
    # у сообщений от остальных и от прочих текстов нет обработчиков — бот молчит
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
