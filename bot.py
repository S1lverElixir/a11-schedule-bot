# -*- coding: utf-8 -*-
"""Личный бот расписания группы А-11 (БТЭУ).

Транспорт — чистый aiohttp + long polling: бесплатный хостинг даёт 128 МБ RAM,
импорт aiogram (с pydantic) в этот лимит не помещается. Логика и форматы сообщений
— строго по SPEC.md; вся предметная логика здесь та же, что была на aiogram.
"""

import asyncio
import html
import logging
import os
from datetime import date, datetime, timedelta, timezone

import aiohttp
from dotenv import load_dotenv

from schedule_data import (
    BELLS,
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
    return {"keyboard": [
        [{"text": BTN_TODAY}, {"text": BTN_TOMORROW}, {"text": BTN_WEEK}],
        [{"text": BTN_BELLS}, {"text": BTN_PICK}],
    ], "resize_keyboard": True}


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
    """Сообщение одного дня в HTML: шапка и номера пар жирным, статус курсивом.
    Суффикс « · сегодня»/« · завтра» — только для кнопок «Сегодня»/«Завтра».
    Статус (и строка «сегодня пар нет») привязан к самой дате: выводится для
    сегодняшнего дня любым способом, включая тап в календаре."""
    now = datetime.now(TZ)
    head = (f"<b>{WD_FULL[d.weekday()]}, {d:%d.%m.%Y}{html.escape(suffix)}</b>\n"
            f"Неделя {week_mark(d)} чертой")
    pairs = day_pairs(d)
    if not pairs:
        line = "сегодня пар нет" if d == now.date() else "пар нет"
        return f"{head}\n\n<i>{line}</i>"
    blocks = []
    for num, st, en, subj, rooms, teachers, _w in pairs:
        second = f"{html.escape(subj)}, ауд. {rooms}" if rooms else html.escape(subj)
        blocks.append(f"<b>{num}-я пара {st}–{en}</b>\n{second}\n{html.escape(', '.join(teachers))}")
    text = head + "\n\n" + "\n\n".join(blocks)
    if d == now.date():
        text += "\n\n<i>" + status_line(pairs, now.hour * 60 + now.minute) + "</i>"
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


def bells_text():
    """«Звонки» в HTML: моношрифт-таблица с ровными колонками."""
    lines = []
    width = max(len(en) for _n, _s, en, _a, _b, _br in BELLS)
    for num, st, en, _a, _b, br in BELLS:
        tail = f"   перерыв {br}" if br else ""
        lines.append(f"{num}-я  {st}–{en}{' ' * (width - len(en) + 1)}{tail}".rstrip())
    body = "\n".join(lines)
    return ("<b>Расписание звонков</b>\n"
            f"<code>{body}</code>\n\n"
            "<i>внутри каждой пары: 45 мин, перемена 5 мин</i>")


def month_intersects(y, m):
    """Пересекается ли месяц с семестром — по этому признаку показываются стрелки."""
    return date(y, m, 1) <= SEMESTER_END and next_month_first(y, m) - timedelta(days=1) >= SEMESTER_START


def calendar_kb(y, m):
    first = date(y, m, 1)
    after = next_month_first(y, m)
    head = []
    prev = first - timedelta(days=1)
    if month_intersects(prev.year, prev.month):
        head.append({"text": "‹", "callback_data": f"cal:{prev:%Y-%m}"})
    head.append({"text": f"{MONTHS[m - 1]} {y}", "callback_data": "cal:x"})
    if month_intersects(after.year, after.month):
        head.append({"text": "›", "callback_data": f"cal:{after:%Y-%m}"})

    rows = [head, [{"text": wd, "callback_data": "cal:x"} for wd in WD_SHORT]]
    cell = first - timedelta(days=first.weekday())  # сетка с понедельника
    today = datetime.now(TZ).date()
    while cell < after:
        row = []
        for _ in range(7):
            # дни вне месяца или вне семестра — пустые неактивные клетки
            if cell.month == m and SEMESTER_START <= cell <= SEMESTER_END:
                mark = "·" if cell == today else ""
                row.append({"text": f"{cell.day}{mark}", "callback_data": f"cal:{cell:%Y-%m}:{cell.day:02d}"})
            else:
                row.append({"text": " ", "callback_data": "cal:x"})
            cell += timedelta(days=1)
        rows.append(row)
    return {"inline_keyboard": rows}


class Telegram:
    """Минимальный клиент Bot API поверх одной aiohttp-сессии."""

    def __init__(self, token, http):
        self._base = f"https://api.telegram.org/bot{token}"
        self._http = http

    async def call(self, method, **params):
        async with self._http.post(f"{self._base}/{method}", json=params) as resp:
            data = await resp.json()
        if not data.get("ok"):
            raise RuntimeError(f"{method}: {data.get('description')}")
        return data["result"]


async def send(tg, chat_id, text, reply_markup=None, parse_mode=None):
    params = {"chat_id": chat_id, "text": text}
    if reply_markup:
        params["reply_markup"] = reply_markup
    if parse_mode:
        params["parse_mode"] = parse_mode
    await tg.call("sendMessage", **params)


async def on_callback(tg, cb):
    # cal:2026-10:23 — дата; cal:2026-10 — листание месяца; cal:x — неактивная клетка
    parts = cb["data"].split(":")
    await tg.call("answerCallbackQuery", callback_query_id=cb["id"])
    if parts[1] == "x":
        return
    y, m = (int(v) for v in parts[1].split("-"))
    chat_id = cb["message"]["chat"]["id"]
    if len(parts) == 3:
        # новое сообщение, календарь в чате остаётся
        await send(tg, chat_id, day_text(date(y, m, int(parts[2]))), parse_mode="HTML")
    else:
        await tg.call("editMessageReplyMarkup", chat_id=chat_id,
                      message_id=cb["message"]["message_id"], reply_markup=calendar_kb(y, m))


async def on_message(tg, msg):
    if msg.get("from", {}).get("id") != OWNER_ID:
        return  # чужим — молчание
    text = msg.get("text")
    chat_id = msg["chat"]["id"]
    if text == "/start":
        await send(tg, chat_id, GREETING, main_kb())
        return
    if text not in BUTTONS:
        return  # незнакомые тексты игнорируются молча
    today = datetime.now(TZ).date()
    if text == BTN_TODAY:
        await send(tg, chat_id, day_text(today, " · сегодня"), parse_mode="HTML")
    elif text == BTN_TOMORROW:
        await send(tg, chat_id, day_text(today + timedelta(days=1), " · завтра"), parse_mode="HTML")
    elif text == BTN_WEEK:
        await send(tg, chat_id, week_text(today))
    elif text == BTN_BELLS:
        await send(tg, chat_id, bells_text(), parse_mode="HTML")
    else:  # BTN_PICK — сетка текущего месяца
        await send(tg, chat_id, "Выберите дату:", calendar_kb(today.year, today.month))


async def handle_update(tg, update):
    if "message" in update:
        await on_message(tg, update["message"])
    elif "callback_query" in update:
        await on_callback(tg, update["callback_query"])


async def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    timeout = aiohttp.ClientTimeout(total=40)  # long poll 25 c + запас на запрос
    async with aiohttp.ClientSession(timeout=timeout) as http:
        tg = Telegram(BOT_TOKEN, http)
        try:  # на случай забытого webhook от прошлых экспериментов
            await tg.call("deleteWebhook")
        except RuntimeError:
            pass
        logging.info("Start polling")
        offset = 0
        while True:
            try:
                updates = await tg.call("getUpdates", timeout=25, offset=offset)
            except (aiohttp.ClientError, asyncio.TimeoutError, RuntimeError) as e:
                logging.warning("poll error: %s", e)
                await asyncio.sleep(3)
                continue
            for u in updates:
                offset = u["update_id"] + 1
                try:
                    await handle_update(tg, u)
                except Exception:
                    logging.exception("update handling failed")


if __name__ == "__main__":
    asyncio.run(main())
