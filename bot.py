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

GREETING = "Расписание группы А-11. Кнопки ниже."


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


def pair_block(entry):
    """HTML-блок пары: жирная строка времени, предмет с аудиторией, преподаватели."""
    num, st, en, subj, rooms, teachers, _w = entry
    second = f"{html.escape(subj)}, ауд. {rooms}" if rooms else html.escape(subj)
    return (f"<b>{num}-я пара {st}–{en}</b>\n{second}\n{html.escape(', '.join(teachers))}")


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
    text = head + "\n\n" + "\n\n".join(pair_block(e) for e in pairs)
    if d == now.date():
        text += "\n\n<i>" + status_line(pairs, now.hour * 60 + now.minute) + "</i>"
    return text


def now_text():
    """Кнопка «Сейчас»: что происходит прямо сейчас и что дальше."""
    now = datetime.now(TZ)
    d = now.date()
    minutes = now.hour * 60 + now.minute
    head = f"<b>Сейчас {now:%H:%M}, {WD_FULL[d.weekday()]} {d:%d.%m}</b>\nНеделя {week_mark(d)} чертой"
    pairs = day_pairs(d)
    if not pairs:
        text = f"{head}\n\n<i>сегодня пар нет</i>"
        nxt = next_day_first_pair(d)
        if nxt:
            nd, first = nxt
            text += (f"\n\nзавтра: {first[0]}-я пара {first[1]}, {html.escape(first[3])}"
                     if (nd - d).days == 1 else
                     f"\n\nближайшие пары: {WD_FULL[nd.weekday()].lower()} {nd:%d.%m}, "
                     f"{first[0]}-я пара {first[1]}, {html.escape(first[3])}")
    else:
        running = next((e for e in pairs if hm(e[1]) <= minutes < hm(e[2])), None)
        upcoming = next((e for e in pairs if minutes < hm(e[1])), None)
        if running is not None:
            i = pairs.index(running)
            text = head + "\n\n" + pair_block(running) + f"\n<i>до конца {hm(running[2]) - minutes} мин</i>"
            if i + 1 < len(pairs):
                nxt = pairs[i + 1]
                text += (f"\n\nдалее: {nxt[0]}-я пара {nxt[1]}, "
                         f"{html.escape(nxt[3])}" + (f", ауд. {nxt[4]}" if nxt[4] else ""))
        elif upcoming is not None:
            gap = hm(upcoming[1]) - minutes
            label = "до первой пары" if upcoming is pairs[0] else "перемена"
            text = head + f"\n\n<i>{label}, {gap} мин</i>\n\n" + pair_block(upcoming)
        else:
            text = head + "\n\n<i>занятия окончены</i>"
            nxt = next_day_first_pair(d)
            if nxt:
                nd, first = nxt
                text += (f"\n\nзавтра: {first[0]}-я пара {first[1]}, {html.escape(first[3])}"
                         if (nd - d).days == 1 else
                         f"\n\nближайшие пары: {WD_FULL[nd.weekday()].lower()} {nd:%d.%m}, "
                         f"{first[0]}-я пара {first[1]}, {html.escape(first[3])}")
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
    """Компактная неделя от заданного понедельника (HTML: шапка жирным)."""
    lines = [f"<b>Неделя {monday:%d.%m}–{monday + timedelta(days=6):%d.%m} · {week_mark(monday)} чертой</b>"]
    for i in range(7):
        day = monday + timedelta(days=i)
        pairs = day_pairs(day)
        lines.append("")
        lines.append(f"{WD_SHORT[i]} {day:%d.%m}")
        if not pairs:
            lines.append("пар нет")
            continue
        for num, st, _en, subj, rooms, _t, _w in pairs:
            lines.append(f"{num} ({st}) {html.escape(subj)}, ауд. {rooms}" if rooms else f"{num} ({st}) {html.escape(subj)}")
        lines.append(f"{len(pairs)} {pairs_word(len(pairs))}")
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
    """«Звонки» в HTML: моношрифт-таблица; у каждой пары — обе половины и перемена между ними."""
    lines = []
    width = max(len(en) for _n, _s, en, _a, _b, _br in BELLS)
    for num, st, en, first, second, br in BELLS:
        tail = f"   перерыв {br}" if br else ""
        lines.append(f"{num}-я  {st}–{en}{' ' * (width - len(en) + 1)}{tail}".rstrip())
        lines.append(f"     {first} · перемена 5 мин · {second}")
    body = "\n".join(lines)
    return "<b>Расписание звонков</b>\n" + f"<code>{body}</code>"


def ics_for_week(monday):
    """ICS-файл недели: событие на каждую пару, время локальное плавающее."""
    out = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//a11-schedule-bot//RU",
           "CALSCALE:GREGORIAN"]
    stamp = datetime.now(TZ).strftime("%Y%m%dT%H%M%S")
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
                    "SUMMARY:" + subj.replace(",", "\\,"),
                    "LOCATION:" + (rooms or "").replace(",", "\\,"),
                    "DESCRIPTION:" + ", ".join(teachers).replace(",", "\\,"),
                    "END:VEVENT"]
    out.append("END:VCALENDAR")
    return "\r\n".join(out).encode("utf-8")


def morning_text(d):
    """Утренняя сводка: компактная раскладка дня в одну строку на пару."""
    head = f"<b>Доброе утро. {WD_FULL[d.weekday()]}, {d:%d.%m.%Y}</b>\nНеделя {week_mark(d)} чертой"
    pairs = day_pairs(d)
    if not pairs:
        return f"{head}\n\n<i>сегодня пар нет</i>"
    lines = []
    for num, st, _en, subj, rooms, _t, _w in pairs:
        lines.append(f"{num} ({st}) {html.escape(subj)}, ауд. {rooms}" if rooms else f"{num} ({st}) {html.escape(subj)}")
    return head + "\n\n" + "\n".join(lines) + f"\n{len(pairs)} {pairs_word(len(pairs))}"


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
            form.add_field("caption", caption, content_type="text/plain; charset=utf-8",
                           **{"Content-Type": None})
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
    parts = cb["data"].split(":")
    await tg.call("answerCallbackQuery", callback_query_id=cb["id"])
    if parts[1] == "x":
        return
    chat_id = cb["message"]["chat"]["id"]
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
                               caption=f"Неделя {monday:%d.%m}–{monday + timedelta(days=6):%d.%m} · {week_mark(monday)} чертой")


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
        await send(tg, chat_id, "Выберите дату:", calendar_kb(today.year, today.month))


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
                word = "осталось меньше суток" if bucket == "soon" else f"осталось {int(hours_left)} ч"
                await send(tg, OWNER_ID,
                           f"fps.ms: до остановки сервера {word}. "
                           f"Продли кнопкой Add 24 hours: {FPSMS_PANEL_URL}/server/{FPSMS_SERVER.split('-')[0]}")
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


async def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    timeout = aiohttp.ClientTimeout(total=40)  # long poll 25 с + запас на запрос
    # keep-alive соединение + кеш DNS на 5 минут: два главных источника экономии миллисекунд
    conn = aiohttp.TCPConnector(ttl_dns_cache=300)
    async with aiohttp.ClientSession(timeout=timeout, connector=conn) as http:
        tg = Telegram(BOT_TOKEN, http)
        try:  # на случай забытого webhook от прошлых экспериментов
            await tg.call("deleteWebhook")
        except RuntimeError:
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
