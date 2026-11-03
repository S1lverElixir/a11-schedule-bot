# -*- coding: utf-8 -*-
"""Снимки обработчиков Python-бота: какие вызовы Bot API делает бот на каждое
сообщение и нажатие. Нужны, чтобы Rust повторил не только тексты, но и поведение.

Пишет rust/tests/fixtures/handlers.json. Запуск из корня:
python -X utf8 rust/tools/gen_handlers.py
"""

import asyncio
import hashlib
import json
import os
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

os.environ["BOT_TOKEN"] = "0:snapshot"
os.environ["MY_TELEGRAM_ID"] = "1"
import dotenv  # noqa: E402

dotenv.load_dotenv = lambda *a, **k: None  # noqa: E731

import bot  # noqa: E402

TZ = timezone(timedelta(hours=3))
OWNER = 1


class FrozenDatetime(datetime):
    frozen = datetime(2026, 10, 23, 12, 56, tzinfo=TZ)

    @classmethod
    def now(cls, tz=None):
        return cls.frozen.astimezone(tz) if tz is not None else cls.frozen


bot.datetime = FrozenDatetime


class Recorder:
    """Подмена Telegram: запоминает вызовы вместо отправки."""

    def __init__(self):
        self.calls = []

    async def call(self, method, **params):
        self.calls.append({"method": method, "params": params})
        return {}

    async def send_document(self, chat_id, filename, content, caption=None):
        if isinstance(content, bytes):
            content = content.decode("utf-8")  # .ics всегда текст
        self.calls.append({
            "method": "sendDocument",
            "params": {
                "chat_id": chat_id,
                "filename": filename,
                "caption": caption,
                "content": content,
            },
        })


CASES = []


def msg(text=None, sender=OWNER, chat=OWNER, mid=100):
    m = {"message_id": mid, "date": 0, "chat": {"id": chat, "type": "private"},
         "from": {"id": sender, "is_bot": False}}
    if text is not None:
        m["text"] = text
    return m


def cb(data, sender=OWNER, message=True, cid="cb1"):
    c = {"id": cid, "from": {"id": sender, "is_bot": False}, "chat_instance": "x"}
    if data is not None:
        c["data"] = data
    if message:
        c["message"] = {"message_id": 10, "chat": {"id": OWNER, "type": "private"},
                        "date": 0}
    return c


def add(name, kind, payload, when):
    FrozenDatetime.frozen = when
    tg = Recorder()
    if kind == "message":
        asyncio.run(bot.on_message(tg, payload))
        add_case(name, when, {"message": payload}, tg.calls)
    elif kind == "callback":
        asyncio.run(bot.on_callback(tg, payload))
        add_case(name, when, {"callback_query": payload}, tg.calls)
    else:
        raise SystemExit(kind)


def add_case(name, when, update, calls):
    CASES.append({
        "name": name,
        "now": when.isoformat(),
        "update": update,
        "calls": calls,
    })


def main():
    times = {
        "pair": datetime(2026, 10, 23, 12, 56, tzinfo=TZ),      # идёт 3-я пара
        "morning": datetime(2026, 10, 23, 8, 0, tzinfo=TZ),     # до первой пары
        "saturday": datetime(2026, 10, 24, 10, 0, tzinfo=TZ),   # суббота под чертой
        "vacation": datetime(2027, 1, 5, 10, 0, tzinfo=TZ),     # вне семестра
        "late": datetime(2026, 12, 31, 22, 0, tzinfo=TZ),       # последний день
    }
    for tag, when in times.items():
        for text in (bot.BTN_TODAY, bot.BTN_TOMORROW, bot.BTN_NOW, bot.BTN_WEEK,
                     bot.BTN_BELLS, bot.BTN_PICK):
            add(f"msg|{tag}|{text}", "message", msg(text), when)
        add(f"msg|{tag}|/start", "message", msg("/start"), when)
        add(f"msg|{tag}|unknown", "message", msg("привет"), when)
        add(f"msg|{tag}|stranger", "message", msg(bot.BTN_TODAY, sender=2, chat=2), when)
        add(f"msg|{tag}|no_text", "message", msg(None), when)

    when = times["pair"]
    for data in ("cal:x", "cal:2026-10", "cal:2026-10:23", "cal:2026-09", "cal:2026-13",
                 "cal:2026-13:01", "cal:2026-02:30", "wk:2026-11-02", "wk:2026-10-19",
                 "ics:2026-10-26", "ics:2026-11-02", "junk", "", "cal:", "cal:2026-10:23:5"):
        add(f"cb|{when.date()}|{data}", "callback", cb(data), when)
    add("cb|stranger", "callback", cb("cal:2026-10", sender=2), when)
    add("cb|no_message|edit", "callback", cb("cal:2026-10", message=False), when)
    add("cb|no_message|day", "callback", cb("cal:2026-10:23", message=False), when)
    add("cb|no_data", "callback", cb(None), when)

    out = Path(
        os.environ.get("HANDLERS_OUT")
        or (Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "handlers.json")
    )
    payload = {"generator": "rust/tools/gen_handlers.py", "cases": CASES}
    # Переводы строк только LF: хеш снимков не должен зависеть от ОС
    out.write_text(
        json.dumps(payload, ensure_ascii=False, indent=0), encoding="utf-8", newline="\n"
    )
    print(f"случаев: {len(CASES)}, файл: {out} ({out.stat().st_size / 1024:.0f} КиБ)")


if __name__ == "__main__":
    main()
