# -*- coding: utf-8 -*-
"""Полная проверка бота расписания А-11: данные, рендеры, память, прод, деплой.

Запуск из корня проекта: python -X utf8 .agents/skills/verify-bot/scripts/verify_bot.py
Флаг --local пропускает сетевые проверки. Код выхода 0 = нет [FAIL].
"""

import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT))
sys.stdout.reconfigure(encoding="utf-8")

FAILS = []
WARNS = []


def ok(msg):
    print(f"  [OK]   {msg}")


def warn(msg):
    WARNS.append(msg)
    print(f"  [WARN] {msg}")


def fail(msg):
    FAILS.append(msg)
    print(f"  [FAIL] {msg}")


def section(title):
    print(f"\n=== {title} ===")


def load_env():
    env = {}
    p = ROOT / ".env"
    if p.exists():
        for line in p.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    return env


# ---------------------------------------------------------------- локально
def check_syntax():
    section("ЛОКАЛЬНО: синтаксис")
    for name in ("bot.py", "schedule_data.py", "run.py"):
        r = subprocess.run(
            [sys.executable, "-X", "utf8", "-m", "py_compile", str(ROOT / name)],
            capture_output=True, text=True, cwd=ROOT,
        )
        if r.returncode == 0:
            ok(f"{name} компилируется")
        else:
            fail(f"{name}: {r.stderr.strip()[:300]}")


def check_data():
    section("ЛОКАЛЬНО: данные schedule_data")
    import schedule_data as sd

    for d, want in ((date(2026, 9, 21), "под"), (date(2026, 10, 26), "над"),
                    (date(2026, 11, 2), "под"), (date(2026, 12, 21), "над"),
                    (date(2026, 12, 28), "под"), (date(2026, 10, 17), "над")):
        got = sd.week_mark(d)
        if got == want:
            ok(f"week_mark({d}) = {got} (официальная таблица: {want})")
        else:
            fail(f"week_mark({d}) = {got}, официальная таблица: {want} — "
                 "если сменился семестр, обнови даты здесь по таблице bteu.by "
                 "(«Формирование учебных недель») и в schedule_data.py")

    bells = {b[0]: (b[1], b[2]) for b in sd.BELLS}
    subjects = set()
    for day, pairs in sd.SCHEDULE.items():
        if day not in range(7):
            fail(f"SCHEDULE: лишний день {day}")
            continue
        nums = [p[0] for p in pairs]
        if nums != sorted(nums):
            fail(f"день {day}: пары не отсортированы")
        for num, start, end, subj, rooms, teachers, weeks in pairs:
            subjects.add(subj)
            tag = f"день {day} пара {num}"
            if not 1 <= num <= len(sd.BELLS):
                fail(f"{tag}: номер вне BELLS")
                continue
            if (start, end) != bells.get(num, (None, None)):
                fail(f"{tag}: {start}-{end} не совпадает со звонками {bells.get(num)}")
            if weeks not in ("both", "над", "под"):
                fail(f"{tag}: метка недели {weeks!r}")
            if not subj:
                fail(f"{tag}: пустой предмет")
            if not teachers:
                fail(f"{tag}: нет преподавателей")
        seen = {}
        for p in pairs:
            key = (p[0], p[6])  # номер пары + черта: две дисциплины на одном слоте одной недели — ошибка
            if key in seen:
                fail(f"день {day}: дубль пары {key[0]}-я, недели «{key[1]}»")
            seen[key] = True

    missing = subjects - set(sd.KIND)
    if missing:
        warn("KIND не покрывает предметы (тип не выведется): " + ", ".join(sorted(missing)))
    else:
        ok(f"KIND покрывает все {len(subjects)} предметов")
    bad_kind = {k: v for k, v in sd.KIND.items() if v not in ("Лекция", "Практика", "")}
    if bad_kind:
        fail(f"KIND: недопустимые значения {bad_kind}")

    if not sd.SEMESTER_START < sd.SEMESTER_END:
        fail("SEMESTER_START >= SEMESTER_END")
    if sd.ANCHOR_MONDAY.weekday() != 0:
        fail("ANCHOR_MONDAY не понедельник")
    ok(f"семестр {sd.SEMESTER_START}..{sd.SEMESTER_END}, якорь {sd.ANCHOR_MONDAY}")
    return sd


def check_renders(sd):
    section("ЛОКАЛЬНО: рендеры bot.py")
    try:
        import bot
    except Exception as e:
        warn(f"bot.py не импортируется ({e.__class__.__name__}: {e}); нужен .env в корне? "
             "рендеры и память пропущены")
        return None

    today = date.today()
    emoji = re.compile("[\U0001F000-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF\uFE0F\u2049\u203C]")
    # суббота якорной недели = «под», суббота предыдущей = «над» — живёт при смене семестра,
    # пока обновлён ANCHOR_MONDAY в schedule_data.py
    under_sat = sd.ANCHOR_MONDAY + timedelta(days=5)
    over_sat = sd.ANCHOR_MONDAY - timedelta(days=2)
    dates = [today, today + timedelta(days=1), sd.SEMESTER_START, sd.SEMESTER_END,
             over_sat, under_sat, sd.SEMESTER_START - timedelta(days=2)]
    texts = []
    for d in dates:
        texts.append((f"day_text({d})", bot.day_text(d, " · тест")))
    texts += [
        ("now_text", bot.now_text()),
        ("week_text", bot.week_text(today)),
        ("render_week", bot.render_week(today - timedelta(days=today.weekday()))),
        ("bells_text", bot.bells_text()),
        ("morning_text", bot.morning_text(today)),
        ("ics_for_week", bot.ics_for_week(today - timedelta(days=today.weekday()))),
    ]
    for name, t in texts:
        if isinstance(t, bytes):
            t = t.decode("utf-8")
        for a, b in (("<b>", "</b>"), ("<i>", "</i>"), ("<code>", "</code>"),
                     ("<blockquote>", "</blockquote>")):
            if t.count(a) != t.count(b):
                fail(f"{name}: HTML-теги {a} не сбалансированы ({t.count(a)}/{t.count(b)})")
        m = emoji.search(t)
        if m:
            fail(f"{name}: эмодзи {m.group(0)!r} в тексте")
    if not any(f.startswith(("day_text", "now_text")) for f, _ in texts):
        fail("дневные рендеры не вызывались")
    ok(f"рендеры: {len(texts)} видов, HTML сбалансирован, эмодзи нет")

    mon = today - timedelta(days=today.weekday())
    ics = bot.ics_for_week(mon)
    if isinstance(ics, bytes):
        ics = ics.decode("utf-8")
    week_pairs = sum(len(bot.day_pairs(mon + timedelta(days=i))) for i in range(7))
    vevents = ics.count("BEGIN:VEVENT")
    if vevents != week_pairs:
        fail(f"ics: VEVENT {vevents} != пар в неделе {week_pairs}")
    else:
        ok(f"ics: {vevents} событий = {week_pairs} пар недели")

    kb = bot.calendar_kb(today.year, today.month)
    flat = [b for row in kb.get("inline_keyboard", []) for b in row]
    if not flat or not any("cal:" in str(b.get("callback_data", "")) for b in flat):
        fail("calendar_kb: нет кнопок с cal:callback")
    else:
        ok(f"calendar_kb: {len(flat)} кнопок")
    return bot


def check_static(bot_src):
    section("ЛОКАЛЬНО: статические правила bot.py")
    src = bot_src
    if re.search(r"^\s*(import aiogram|from aiogram)", src, re.M):
        fail("импорт aiogram — фреймворк не влезает в 128 МБ")
    else:
        ok("aiogram не используется (упоминания в докстринге не в счёт)")
    if "timezone(timedelta(hours=3))" in src:
        ok("фиксированный UTC+3")
    else:
        fail("нет timezone(timedelta(hours=3))")
    if "html.escape" in src:
        ok("html.escape используется")
    else:
        fail("нет html.escape")
    if "OWNER_ID" in src and "on_message" in src:
        ok("фильтр владельца на месте")
    else:
        fail("нет фильтра OWNER_ID / on_message")


def check_memory(bot):
    section("ЛОКАЛЬНО: память import bot")
    probe = (
        "import ctypes, sys\n"
        "def peak():\n"
        "    if sys.platform == 'win32':\n"
        "        class PMC(ctypes.Structure):\n"
        "            _fields_=[('cb',ctypes.c_ulong),('pf',ctypes.c_ulong),"
        "('pk',ctypes.c_size_t),('ws',ctypes.c_size_t),('q1',ctypes.c_size_t),"
        "('q2',ctypes.c_size_t),('q3',ctypes.c_size_t),('q4',ctypes.c_size_t),"
        "('pg',ctypes.c_size_t),('pp',ctypes.c_size_t)]\n"
        "        k=ctypes.windll.kernel32\n"
        "        k.GetCurrentProcess.restype=ctypes.c_void_p\n"  # иначе -1 обрежется до 32 бит
        "        p=PMC(); p.cb=ctypes.sizeof(PMC)\n"
        "        if not ctypes.windll.psapi.GetProcessMemoryInfo("
        "ctypes.c_void_p(k.GetCurrentProcess()), ctypes.byref(p), p.cb):\n"
        "            return 0.0\n"
        "        return p.pk / 1048576\n"
        "    import resource\n"
        "    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024\n"
        "import bot\n"
        "print(f'{peak():.1f}')\n"
    )
    r = subprocess.run([sys.executable, "-X", "utf8", "-c", probe],
                       capture_output=True, text=True, cwd=ROOT)
    if r.returncode != 0:
        warn(f"зонд памяти упал: {r.stderr.strip().splitlines()[-1][:200] if r.stderr else r.returncode}")
        return
    try:
        mb = float(r.stdout.strip().splitlines()[-1])
    except ValueError:
        warn(f"зонд памяти: непонятный вывод {r.stdout[:100]!r}")
        return
    if mb >= 100:
        fail(f"пик памяти import bot = {mb:.1f} МБ — близко к лимиту хостинга 128 МБ")
    else:
        ok(f"пик памяти import bot = {mb:.1f} МБ (лимит 128)")


# ---------------------------------------------------------------- сеть
def check_prod(env):
    section("ПРОД: живость бота (409-тест, timeout>=5 обязателен)")
    token = env.get("BOT_TOKEN")
    if not token:
        warn("нет BOT_TOKEN в .env — прод-проверки пропущены")
        return
    alive = False
    for _ in range(3):
        try:
            urllib.request.urlopen(
                f"https://api.telegram.org/bot{token}/getUpdates?timeout=25", timeout=33)
        except urllib.error.HTTPError as e:
            if e.code == 409:
                alive = True
                break
            if e.code == 401:
                fail("Telegram вернул 401: токен в .env невалиден (проверь BOT_TOKEN)")
                return
        except Exception:
            pass
    if alive:
        ok("409 получен — long polling жив")
    else:
        fail("409 не получен — прод-бот не держит polling (панель fps.ms, логи)")


def check_deploy():
    section("ПРОД: автодеплой GitHub Actions")
    try:
        r = subprocess.run(
            ["gh", "run", "list", "--workflow=deploy.yml", "--limit", "1",
             "--json", "displayTitle,conclusion,createdAt"],
            capture_output=True, text=True, timeout=30, cwd=ROOT)
        runs = json.loads(r.stdout or "[]")
        if runs:
            run = runs[0]
            concl = run.get("conclusion") or "in_progress"
            (ok if concl == "success" else warn)(
                f"последний деплой: {concl} — {run.get('displayTitle', '')[:60]} "
                f"({run.get('createdAt', '')[:16]} UTC)")
        else:
            warn("gh: нет запусков деплоя")
    except FileNotFoundError:
        warn("gh CLI не найден — статус деплоя пропущен")
    except Exception as e:
        warn(f"gh: {e}")


def check_panel(env):
    section("ПРОД: контейнер fps.ms")
    key, uuid = env.get("FPSMS_API_KEY"), env.get("FPSMS_SERVER_UUID")
    if not (key and uuid):
        warn("нет FPSMS_API_KEY/FPSMS_SERVER_UUID в .env — панель пропущена")
        return
    try:
        r = subprocess.run(
            ["curl", "-s", "--max-time", "20",
             f"https://panel.fps.ms/api/client/servers/{uuid}/resources",
             "-H", f"Authorization: Bearer {key}", "-H", "Accept: application/json",
             "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36"],
            capture_output=True, text=True, timeout=30)
        data = json.loads(r.stdout)
        a = data.get("attributes", {})
        res = a.get("resources", {})
        mem = res.get("memory_bytes", 0) / 1048576
        up = res.get("uptime")
        state = a.get("current_state")
        suspended = a.get("is_suspended")
        # панель отдаёт uptime в миллисекундах: 10 часов — это ~36 000 000, а не 36 000
        up_txt = f", uptime {up / 3_600_000:.1f} ч" if up is not None else ""
        if state == "running" and not suspended:
            ok(f"контейнер running, память {mem:.0f} МБ{up_txt}")
        else:
            fail(f"контейнер {state}, suspended={suspended}")
        if mem >= 120:
            fail(f"память контейнера {mem:.0f} МБ — у лимита 128 МБ")
    except Exception as e:
        warn(f"панель: {e.__class__.__name__}: {str(e)[:150]}")


def main():
    local_only = "--local" in sys.argv
    env = load_env()

    check_syntax()
    sd = check_data()
    bot = check_renders(sd)
    check_static((ROOT / "bot.py").read_text(encoding="utf-8"))
    if bot is not None:
        check_memory(bot)

    if not local_only:
        check_prod(env)
        check_deploy()
        check_panel(env)

    print(f"\n=== ИТОГ: FAIL={len(FAILS)}, WARN={len(WARNS)} ===")
    for f in FAILS:
        print(f"  FAIL: {f}")
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main()
