# -*- coding: utf-8 -*-
"""Личный бот расписания группы А-11 (БТЭУ).

Транспорт — чистый aiohttp + long polling: бесплатный хостинг даёт 128 МБ RAM,
импорт aiogram (с pydantic) в этот лимит не помещается. Логика и форматы сообщений
— строго по SPEC.md.
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
    KIND,
    SCHEDULE,
    SEMESTER_END,
    SEMESTER_START,
    week_mark,
)

load_dotenv()
BOT_TOKEN = os.environ["BOT_TOKEN"]
OWNER_ID = int(os.environ["MY_TELEGRAM_ID"])
# параметры watchdog'а продления fps.ms (необязательные)
FPSMS_API_KEY = os.environ.get("FPSMS_API_KEY", "")
FPSMS_SERVER = os.environ.get("FPSMS_SERVER_UUID", "")
FPSMS_PANEL_URL = os.environ.get("FPSMS_PANEL_URL", "https://panel.fps.ms")
# время утренней сводки «HH:MM» (Минск); пустая строка — выключить
MORNING_SUMMARY_TIME = os.environ.get("MORNING_SUMMARY_TIME", "07:30")

TZ = timezone(timedelta(hours=3))  # Минск, фиксированный UTC+3 — без pytz/zoneinfo

# Самопроверка чередования по утверждённым датам: 22.10.2026 — под чертой, 15.10.2026 — над чертой
assert week_mark(date(2026, 10, 22)) == "под" and week_mark(date(2026, 10, 15)) == "над"

WD_FULL = ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"]
WD_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]
MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
          "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"]

BTN_TODAY = "Сегодня"
BTN_TOMORROW = "Завтра"
BTN_NOW = "Сейчас"
BTN_WEEK = "Неделя"
BTN_BELLS = "Звонки"
BTN_PICK = "Выбрать день"
BUTTONS = {BTN_TODAY, BTN_TOMORROW, BTN_NOW, BTN_WEEK, BTN_BELLS, BTN_PICK}

GREETING = "Расписание группы А-11. Выбирай кнопками ниже."
PICK_PROMPT = "<b>Выбери день</b>"


def main_kb():
    return {"keyboard": [
        [{"text": BTN_TODAY}, {"text": BTN_TOMORROW}, {"text": BTN_NOW}, {"text": BTN_WEEK}],
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


def fmt_minutes(m):
    """Интервал по-человечески: 45 -> «45 мин», 60 -> «1 ч», 95 -> «1 ч 35 мин»."""
    if m < 60:
        return f"{m} мин"
    h, rem = divmod(m, 60)
    return f"{h} ч {rem} мин" if rem else f"{h} ч"


def status_line(pairs, now):
    """Статус сегодняшнего дня; now — минуты от полуночи.
    Времена берутся из записей SCHEDULE в schedule_data.py (начало/конец пары — это
    расписание звонков), собственных констант времени в bot.py нет.
    Границы: момент начала пары — уже пара, момент конца — уже перемена/окончание."""
    for i, (num, st, en, *_rest) in enumerate(pairs):
        s, e = hm(st), hm(en)
        if now < s:
            if i == 0:
                return f"до первой пары {fmt_minutes(s - now)}"
            return f"перемена, до {num}-й пары {fmt_minutes(s - now)}"
        if now < e:
            return f"идёт {num}-я пара, до конца {fmt_minutes(e - now)}"
    return "занятия окончены"


def fmt_rooms(rooms):
    """Аудитории для вывода: экранирование + пробел после запятой в перечнях."""
    return html.escape(rooms).replace(",", ", ") if rooms else ""

def pair_block(entry, note=None):
    """HTML-блок пары: жирная строка времени, предмет с аудиторией, преподаватели;
    note — курсивная приписка (для идущей пары)."""
    num, st, en, subj, rooms, teachers, _w = entry
    title = (f"{KIND.get(subj, '')} · {html.escape(subj)}" if KIND.get(subj)
             else html.escape(subj))
    second = f"{title}, ауд. {fmt_rooms(rooms)}" if rooms else title
    text = f"<b>{num}-я пара {st}–{en}</b>\n{second}\n{html.escape(', '.join(teachers))}"
    return text + (f"\n<i>{note}</i>" if note else "")


def day_span(pairs):
    """(начало, конец) учебного дня в минутах — от первой до последней пары."""
    return hm(pairs[0][1]), hm(pairs[-1][2])


def progress_bar(pairs, minutes):
    """10-клеточный прогресс учебного дня: ▰ пройдено, ▱ осталось."""
    s, e = day_span(pairs)
    filled = max(0, min(10, round((minutes - s) / (e - s) * 10)))
    return "▰" * filled + "▱" * (10 - filled)


def day_span_block(pairs, minutes_now=None):
    """Диапазон дня «пары HH:MM–HH:MM»; для сегодня — с прогресс-баром в code-блоке."""
    rng = f"пары {pairs[0][1]}–{pairs[-1][2]}"
    if minutes_now is not None:
        return f"<code>{progress_bar(pairs, minutes_now)}\n{rng}</code>"
    return rng


def day_text(d, suffix=""):
    """Сообщение одного дня в HTML: шапка и номера пар жирным, статус курсивом,
    для сегодняшнего дня — прогресс-бар и диапазон дня.
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
    minutes = now.hour * 60 + now.minute
    if d == now.date():
        head += "\n" + day_span_block(pairs, minutes)
        status = status_line(pairs, minutes)
    else:
        head += "\n" + day_span_block(pairs)
        status = None
    if status is None:  # не сегодня: без бара-статусов и заметок
        text = head
        blocks = [pair_block(e) for e in pairs]
    elif status == "занятия окончены" or status.startswith(("перемена", "до первой")):
        text = head + "\n\n<i>" + status + "</i>"
        blocks = [pair_block(e) for e in pairs]
    else:
        running = next((e for e in pairs if hm(e[1]) <= minutes < hm(e[2])), None)
        blocks = [pair_block(e, f"до конца {fmt_minutes(hm(e[2]) - minutes)}") if e is running else pair_block(e)
                  for e in pairs]
        text = head
    return text + "\n\n" + "\n\n".join(blocks)


def now_text():
    """Кнопка «Сейчас»: что происходит прямо сейчас и что дальше."""
    now = datetime.now(TZ)
    d = now.date()
    minutes = now.hour * 60 + now.minute
    head = f"<b>Сейчас {now:%H:%M} · {WD_FULL[d.weekday()]}, {d:%d.%m}</b>\nНеделя {week_mark(d)} чертой"
    pairs = day_pairs(d)
    if not pairs:
        text = f"{head}\n\n<i>сегодня пар нет</i>"
        nxt = next_day_first_pair(d)
        if nxt:
            nd, first = nxt
            hint = (f"завтра: {first[0]}-я пара в {first[1]} — {html.escape(first[3])}"
                    + (f", ауд. {fmt_rooms(first[4])}" if first[4] else "")
                    if (nd - d).days == 1 else
                    f"ближайшая пара: {WD_FULL[nd.weekday()].lower()}, {nd:%d.%m}, "
                    f"{first[0]}-я пара в {first[1]} — {html.escape(first[3])}"
                    + (f", ауд. {fmt_rooms(first[4])}" if first[4] else ""))
            text += f"\n\n<blockquote>{hint}</blockquote>"
    else:
        running = next((e for e in pairs if hm(e[1]) <= minutes < hm(e[2])), None)
        upcoming = next((e for e in pairs if minutes < hm(e[1])), None)
        if running is not None or upcoming is not None:
            head += "\n" + day_span_block(pairs, minutes)
        if running is not None:
            i = pairs.index(running)
            text = head + "\n\n" + pair_block(running) + f"\n<i>до конца {fmt_minutes(hm(running[2]) - minutes)}</i>"
            if i + 1 < len(pairs):
                nxt = pairs[i + 1]
                hint = (f"дальше: {nxt[0]}-я пара в {nxt[1]} — "
                        f"{html.escape(nxt[3])}" + (f", ауд. {fmt_rooms(nxt[4])}" if nxt[4] else ""))
                text += f"\n\n<blockquote>{hint}</blockquote>"
        elif upcoming is not None:
            gap = hm(upcoming[1]) - minutes
            label = "до первой пары" if upcoming is pairs[0] else "перемена"
            text = head + f"\n\n<i>{label} {fmt_minutes(gap)}</i>\n\n" + pair_block(upcoming)
        else:
            text = head + "\n\n<i>занятия окончены</i>"
            nxt = next_day_first_pair(d)
            if nxt:
                nd, first = nxt
                hint = (f"завтра: {first[0]}-я пара в {first[1]} — {html.escape(first[3])}"
                        + (f", ауд. {fmt_rooms(first[4])}" if first[4] else "")
                        if (nd - d).days == 1 else
                        f"ближайшая пара: {WD_FULL[nd.weekday()].lower()}, {nd:%d.%m}, "
                        f"{first[0]}-я пара в {first[1]} — {html.escape(first[3])}"
                        + (f", ауд. {fmt_rooms(first[4])}" if first[4] else ""))
                text += f"\n\n<blockquote>{hint}</blockquote>"
    return text


def next_day_first_pair(after):
    """Дата (в пределах недели вперёд) и первая пара ближайшего дня с парами."""
    for i in range(1, 8):
        d = after + timedelta(days=i)
        pairs = day_pairs(d)
        if pairs:
            return d, pairs[0]
    return None


def pairs_word(n):
    if n % 10 == 1 and n % 100 != 11:
        return "пара"
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return "пары"
    return "пар"


def render_week(monday):
    """Компактная неделя (HTML: шапка и дни жирным, счётчики курсивом,
    пустые выходные — одним блоком, сегодняшний день помечен)."""
    today = datetime.now(TZ).date()
    days = [monday + timedelta(days=i) for i in range(7)]
    counts = [len(day_pairs(d)) for d in days]
    lines = [f"<b>Неделя {monday:%d.%m}–{days[6]:%d.%m} · {week_mark(monday)} чертой</b>"]
    if not any(counts):
        # неделя целиком вне семестра: семь «пар нет» — шум
        return lines[0] + "\n\n<i>пар нет</i>"
    merged = []
    i = 0
    while i < 7:
        if i == 5 and counts[5] == 0 and counts[6] == 0:
            merged.append(("Сб–Вс", [days[5], days[6]]))
            i += 2
        else:
            merged.append((WD_SHORT[i], [days[i]]))
            i += 1
    for wd, ds in merged:
        lines.append("")
        mark = " · сегодня" if today in ds else ""
        if len(ds) == 1:
            lines.append(f"<b>{wd} {ds[0]:%d.%m}{mark}</b>")
        else:
            lines.append(f"<b>{wd} {ds[0]:%d.%m} · {ds[1]:%d.%m}{mark}</b>")
        count = len(day_pairs(ds[0]))
        if count == 0:
            lines.append("<i>пар нет</i>")
            continue
        for num, st, _en, subj, rooms, _t, _w in day_pairs(ds[0]):
            title = (f"{KIND.get(subj, '')} · {html.escape(subj)}" if KIND.get(subj)
                     else html.escape(subj))
            lines.append(f"{num} ({st}) {title}, ауд. {fmt_rooms(rooms)}" if rooms else f"{num} ({st}) {title}")
        lines.append(f"<i>{count} {pairs_word(count)}</i>")
    return "\n".join(lines)


def week_text(d):
    """Компактная неделя, содержащая d: по строке на пару, без преподавателей."""
    return render_week(d - timedelta(days=d.weekday()))


def week_kb(monday):
    prev = monday - timedelta(days=7)
    nxt = monday + timedelta(days=7)
    return {"inline_keyboard": [[
        {"text": "‹", "callback_data": f"wk:{prev:%Y-%m-%d}"},
        {"text": "экспорт в календарь", "callback_data": f"ics:{monday:%Y-%m-%d}"},
        {"text": "›", "callback_data": f"wk:{nxt:%Y-%m-%d}"},
    ]]}


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


def bells_text():
    """«Звонки» в HTML: дерево — пара целиком, внутри 1-й час, перемена, 2-й час."""
    lines = []
    width = max(len(en) for _n, _s, en, _a, _b, _br in BELLS)
    for num, st, en, first, second, br in BELLS:
        tail = f"   перерыв {br}" if br else ""
        lines.append(f"{num}-я  {st}–{en}{' ' * (width - len(en))}{tail}".rstrip())
        gap = hm(second.split("–")[0]) - hm(first.split("–")[1])
        lines.append(f"├ 1-й час  {first}")
        lines.append(f"├ перемена {gap} мин")
        lines.append(f"└ 2-й час  {second}")
    body = "\n".join(lines)
    return "<b>Расписание звонков</b>\n" + f"<code>{body}</code>"


def ics_escape(s):
    """RFC 5545: экранирование бэкслэша, точки с запятой, запятой и перевода строки."""
    return (s.replace("\\", "\\\\").replace(";", "\\;")
            .replace(",", "\\,").replace("\n", "\\n"))


def ics_fold(line):
    """Фолдинг по RFC 5545 §3.1: строки длиннее 75 октетов режутся на части,
    продолжение — с CRLF и пробелом; многобайтовые символы UTF-8 не рвутся."""
    data = line.encode("utf-8")
    if len(data) <= 75:
        return line
    parts = []
    limit = 75
    while data:
        cut = min(limit, len(data))
        while cut < len(data) and 0x80 <= data[cut] <= 0xBF:
            cut -= 1
        parts.append(data[:cut].decode("utf-8"))
        data = data[cut:]
        limit = 74  # продолжение начинается с пробела, на него отводится 1 октет
    return "\r\n ".join(parts)


def ics_for_week(monday):
    """ICS-файл недели: событие на каждую пару, время локальное плавающее.
    DTSTAMP — по RFC обязательный UTC."""
    out = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//a11-schedule-bot//RU",
           "CALSCALE:GREGORIAN"]
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    for i in range(7):
        day = monday + timedelta(days=i)
        for num, st, en, subj, rooms, teachers, _w in day_pairs(day):
            def t(s):
                return s.replace(":", "") + "00"
            out += ["BEGIN:VEVENT",
                    f"UID:{day:%Y%m%d}-{num}@a11-bot",
                    f"DTSTAMP:{stamp}",
                    f"DTSTART:{day:%Y%m%d}T{t(st)}",
                    f"DTEND:{day:%Y%m%d}T{t(en)}",
                    "SUMMARY:" + ics_escape(subj),
                    "LOCATION:" + ics_escape(rooms or ""),
                    "DESCRIPTION:" + ics_escape(", ".join(teachers)),
                    "END:VEVENT"]
    out.append("END:VCALENDAR")
    return ("\r\n".join(ics_fold(line) for line in out) + "\r\n").encode("utf-8")


def morning_text(d):
    """Утренняя сводка: компактная раскладка дня в одну строку на пару."""
    head = f"<b>Доброе утро · {WD_FULL[d.weekday()]}, {d:%d.%m.%Y}</b>\nНеделя {week_mark(d)} чертой"
    pairs = day_pairs(d)
    if not pairs:
        return f"{head}\n\n<i>сегодня пар нет</i>"
    now = datetime.now(TZ)
    mins = now.hour * 60 + now.minute
    gap = hm(pairs[0][1]) - mins
    info = day_span_block(pairs, mins)
    if gap > 0:  # до первой пары; если сводка пришла позже старта — строка отсчёта не нужна
        info += f"\n\n<i>до первой пары {fmt_minutes(gap)}</i>"
    lines = []
    for num, st, _en, subj, rooms, _t, _w in pairs:
        title = (f"{KIND.get(subj, '')} · {html.escape(subj)}" if KIND.get(subj)
                 else html.escape(subj))
        lines.append(f"{num} ({st}) {title}, ауд. {fmt_rooms(rooms)}" if rooms else f"{num} ({st}) {title}")
    return head + "\n" + info + "\n\n" + "\n".join(lines) + f"\n<i>{len(pairs)} {pairs_word(len(pairs))}</i>"


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

    async def send_document(self, chat_id, filename, content, caption=None):
        form = aiohttp.FormData()
        form.add_field("chat_id", str(chat_id))
        if caption:
            form.add_field("caption", caption)
            form.add_field("parse_mode", "HTML")
        form.add_field("document", content, filename=filename,
                       content_type="text/calendar")
        async with self._http.post(f"{self._base}/sendDocument", data=form) as resp:
            data = await resp.json()
        if not data.get("ok"):
            raise RuntimeError(f"sendDocument: {data.get('description')}")


async def send(tg, chat_id, text, reply_markup=None, parse_mode=None):
    params = {"chat_id": chat_id, "text": text}
    if reply_markup:
        params["reply_markup"] = reply_markup
    if parse_mode:
        params["parse_mode"] = parse_mode
    await tg.call("sendMessage", **params)


async def on_callback(tg, cb):
    # cal:2026-10:23 — дата; cal:2026-10 — листание месяца; cal:x — неактивная клетка;
    # wk:2026-11-02 — неделя от понедельника; ics:2026-11-02 — экспорт недели
    if cb.get("from", {}).get("id") != OWNER_ID:
        return  # чужим — молчание; кнопки существуют только в личке владельца
    await tg.call("answerCallbackQuery", callback_query_id=cb["id"])
    try:
        parts = cb["data"].split(":")
        if parts[1] == "x":
            return
        # Telegram не присылает поле message у очень старых сообщений (календарь
        # живёт в чате вечно) — чат владельца в личке совпадает с его id
        chat_id = cb.get("message", {}).get("chat", {}).get("id") or OWNER_ID
        if parts[0] == "cal":
            y, m = (int(v) for v in parts[1].split("-"))
            if len(parts) == 3:
                # новое сообщение, календарь в чате остаётся
                await send(tg, chat_id, day_text(date(y, m, int(parts[2]))), parse_mode="HTML")
            else:
                await tg.call("editMessageReplyMarkup", chat_id=chat_id,
                              message_id=cb["message"]["message_id"], reply_markup=calendar_kb(y, m))
        elif parts[0] == "wk":
            y, m, d = (int(v) for v in parts[1].split("-"))
            monday = date(y, m, d)
            await send(tg, chat_id, render_week(monday), reply_markup=week_kb(monday), parse_mode="HTML")
        elif parts[0] == "ics":
            y, m, d = (int(v) for v in parts[1].split("-"))
            monday = date(y, m, d)
            name = f"raspisanie_{monday:%d.%m}-{monday + timedelta(days=6):%d.%m}.ics"
            await tg.send_document(chat_id, name, ics_for_week(monday),
                                   caption=f"<b>Неделя {monday:%d.%m}–{monday + timedelta(days=6):%d.%m} · {week_mark(monday)} чертой</b>")
    except (KeyError, IndexError, ValueError):
        logging.warning("bad callback data: %r", cb.get("data"))


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
    elif text == BTN_NOW:
        await send(tg, chat_id, now_text(), parse_mode="HTML")
    elif text == BTN_WEEK:
        monday = today - timedelta(days=today.weekday())
        await send(tg, chat_id, week_text(today), reply_markup=week_kb(monday), parse_mode="HTML")
    elif text == BTN_BELLS:
        await send(tg, chat_id, bells_text(), parse_mode="HTML")
    else:  # BTN_PICK — сетка текущего месяца
        await send(tg, chat_id, PICK_PROMPT, calendar_kb(today.year, today.month),
                   parse_mode="HTML")


async def handle_update(tg, update):
    if "message" in update:
        await on_message(tg, update["message"])
    elif "callback_query" in update:
        await on_callback(tg, update["callback_query"])


async def renewal_watchdog(http, tg):
    """Следит за сроком сервера fps.ms и напоминает владельцу продлить.
    Продление защищено reCAPTCHA, поэтому автоматом — только напоминание."""
    if not (FPSMS_API_KEY and FPSMS_SERVER):
        return
    url = f"{FPSMS_PANEL_URL}/api/client/servers/{FPSMS_SERVER}"
    headers = {"Authorization": f"Bearer {FPSMS_API_KEY}"}
    last_bucket = None
    while True:
        bucket = None
        try:
            async with http.get(url, headers=headers) as resp:
                data = await resp.json()
            expires = datetime.fromisoformat(data["attributes"]["expires_at"].replace("Z", "+00:00"))
            hours_left = (expires - datetime.now(timezone.utc)).total_seconds() / 3600
            bucket = "ok" if hours_left > 30 else ("soon" if hours_left > 6 else "urgent")
            if bucket != "ok" and bucket != last_bucket:
                await send(tg, OWNER_ID,
                           f"Напоминание: сервер fps.ms остановится примерно через "
                           f"{max(1, int(hours_left))} ч. Продли сервер в панели "
                           f"(кнопка Add 24 hours): {FPSMS_PANEL_URL}/server/{FPSMS_SERVER.split('-')[0]}")
        except Exception:
            logging.exception("watchdog check failed")
        last_bucket = bucket
        await asyncio.sleep(3600)


async def morning_summary(http, tg):
    """Утренняя сводка: ежедневно в MORNING_SUMMARY_TIME (±полтора часа окна на
    случай простоя) присылает раскладку дня; если бот был выключен в окно —
    сводка пропускается, догоняющих сообщений нет."""
    if not MORNING_SUMMARY_TIME:
        return
    hh, mm = (int(v) for v in MORNING_SUMMARY_TIME.split(":"))
    target = (hh * 60 + mm) * 60  # секунды от полуночи
    last_sent = None
    while True:
        try:
            now = datetime.now(TZ)
            secs = now.hour * 3600 + now.minute * 60 + now.second
            if (SEMESTER_START <= now.date() <= SEMESTER_END
                    and target <= secs < target + 90 * 60
                    and last_sent != now.date()):
                await send(tg, OWNER_ID, morning_text(now.date()), parse_mode="HTML")
                last_sent = now.date()
                logging.info("morning summary sent")
        except Exception:
            logging.exception("morning summary failed")
        await asyncio.sleep(60)


class _ScrubFormatter(logging.Formatter):
    """Прячет BOT_TOKEN в логах: сетевые исключения aiohttp печатают URL,
    в котором живёт токен, а консоль контейнера видна в панели."""

    def format(self, record):
        out = super().format(record)
        return out.replace(BOT_TOKEN, "***") if BOT_TOKEN else out


async def main():
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    handler = logging.StreamHandler()
    handler.setFormatter(_ScrubFormatter("%(asctime)s %(levelname)s %(message)s"))
    root.addHandler(handler)
    timeout = aiohttp.ClientTimeout(total=40)  # long poll 25 с + запас на запрос
    # keep-alive соединение + кеш DNS на 5 минут: два главных источника экономии миллисекунд
    conn = aiohttp.TCPConnector(ttl_dns_cache=300)
    async with aiohttp.ClientSession(timeout=timeout, connector=conn) as http:
        tg = Telegram(BOT_TOKEN, http)
        try:  # на случай забытого webhook от прошлых экспериментов; сеть могла ещё не подняться
            await tg.call("deleteWebhook")
        except (aiohttp.ClientError, asyncio.TimeoutError, RuntimeError):
            pass
        logging.info("Start polling")
        asyncio.create_task(renewal_watchdog(http, tg))
        asyncio.create_task(morning_summary(http, tg))
        offset = 0
        while True:
            try:
                # только нужные типы апдейтов — меньше полезная нагрузка на каждый poll
                updates = await tg.call("getUpdates", timeout=25, offset=offset,
                                        allowed_updates=["message", "callback_query"])
            except (aiohttp.ClientError, asyncio.TimeoutError, RuntimeError, ValueError) as e:
                # ValueError ловит и JSONDecodeError: кривой ответ не должен убивать цикл
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
