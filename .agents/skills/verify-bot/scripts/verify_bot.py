# -*- coding: utf-8 -*-
"""Полная проверка бота расписания А-11: Rust-сборка, паритет, статика, прод, деплой.

Запуск из корня проекта: python -X utf8 .agents/skills/verify-bot/scripts/verify_bot.py
Флаг --local пропускает сетевые проверки. Код выхода 0 = нет [FAIL].

Бот живёт в rust/; прежний Python-бот удалён вместе с колёсами и генераторами
снимков. Локальная часть = `rust/tools/check.py` (сборка, cargo test, паритет
против замороженных снимков, память) плюс статические правила по исходникам Rust.
Сеть проверяется как раньше: 409, статус деплоя, панель.
"""

import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
RUST_SRC = ROOT / "rust" / "src"
FIXTURES = ROOT / "rust" / "tests" / "fixtures"
EMOJI = re.compile("[\U0001F000-\U0001FAFF☀-➿⬀-⯿️‼]")

# Официальные даты таблицы «Формирование учебных недель» на bteu.by. Под код
# не правятся: разошлись — значит якорь или таблица неверны.
OFFICIAL_WEEKS = {(2026, 9, 21): "Under", (2026, 10, 17): "Over", (2026, 10, 26): "Over",
                  (2026, 11, 2): "Under", (2026, 12, 21): "Over", (2026, 12, 28): "Under"}

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
def check_rust():
    """Сборка, cargo test, паритет против снимков и память — всё из check.py."""
    section("ЛОКАЛЬНО: Rust — сборка, тесты, паритет, память")
    for name in ("views.json", "handlers.json"):
        if not (FIXTURES / name).exists():
            fail(f"нет снимка эталона: rust/tests/fixtures/{name}")
            return
    try:
        r = subprocess.run([sys.executable, "-X", "utf8", "rust/tools/check.py"],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", cwd=ROOT, timeout=1800)
    except FileNotFoundError:
        fail("python не найден — проверки Rust не было")
        return
    except subprocess.TimeoutExpired:
        fail("check.py не завершился за 30 минут")
        return
    out = (r.stdout or "") + (r.stderr or "")
    lines = [ln.strip() for ln in out.splitlines() if re.match(r"\[(OK|WARN|FAIL)\]", ln.strip())]
    if not lines:
        fail(f"check.py не вывел ни одной проверки (rc={r.returncode}): {out[-300:]!r}")
        return
    for ln in lines:
        verdict, msg = ln.split("]", 1)[0].strip("[] "), ln.split("]", 1)[1].strip()
        if verdict == "OK":
            ok(msg)
        elif verdict == "WARN":
            warn(msg)
        else:
            fail(msg)
    итог = [ln for ln in out.splitlines() if "ИТОГ" in ln]
    if r.returncode != 0 or not итог:
        fail(f"check.py: rc={r.returncode}, строки ИТОГ нет")
    elif итог[-1].split("ИТОГ:")[1].strip(" =") != "FAIL=0, WARN=0":
        ok(f"гейт Rust: {итог[-1].strip('= ')}")
    else:
        ok("гейт Rust: FAIL=0, WARN=0")


def check_static(src):
    """Правила, которые держат лимит 128 МБ, приватность и формат сообщений."""
    section("ЛОКАЛЬНО: статические правила rust/src")

    banned = [b for b in ("chrono", "aiogram", "tokio", "pytz", "zoneinfo")
              if re.search(r"\buse\s+%s\b|\b%s::" % (b, b), src["all"], re.M)]
    if banned:
        fail(f"запрещённая зависимость в коде: {banned} — в 128 МБ такое не влезает")
    else:
        ok("нет datetime-библиотек и async-рантайма: только стандартная библиотека")

    if "TZ_OFFSET_SECS: i64 = 3 * 3600" in src["date"]:
        ok("фиксированный UTC+3")
    else:
        fail("нет фиксированного смещения UTC+3 в rust/src/date.rs")

    guards = len(re.findall(r"!= Some\(self\.owner_id\)", src["bot"]))
    if guards >= 2 and "fn on_message" in src["bot"] and "fn on_callback" in src["bot"]:
        ok(f"фильтр владельца в обработчике сообщений и нажатий ({guards} проверки)")
    else:
        fail(f"фильтр владельца: проверок на owner — {guards}, нужно минимум 2 "
             "(on_message и on_callback)")

    if "pub fn esc(" in src["render"] and src["render"].count("esc(") >= 8:
        ok("экранирование HTML применяется к динамическим строкам")
    else:
        fail("подозрение на незаэкранированный вывод: проверь esc() в rust/src/render.rs")

    bad = [f"{name}: {m.group(0)!r}"
           for name, text in src.items() if name != "all"
           for lit in re.findall(r'"(?:[^"\\\n]|\\.)*"', text)
           for m in [EMOJI.search(lit)] if m]
    if bad:
        fail("эмодзи в строках бота: " + ", ".join(bad[:5]))
    else:
        ok("эмодзи в строках нет")

    if '"\\r\\n"' in src["ics"] and "DTSTAMP:" in src["ics"]:
        ok(".ics: CRLF и DTSTAMP в UTC — RFC 5545 на месте")
    else:
        fail(".ics потерял части RFC 5545 (CRLF / DTSTAMP)")

    if "getUpdates" in src["main"]:
        ok("транспорт — long polling, вебхуков нет")
    else:
        fail("в rust/src/main.rs не нашли getUpdates: polling потерялся")


def check_data(src):
    """Данные: официальные даты недель в тесте, полнота таблицы, границы семестра."""
    section("ЛОКАЛЬНО: данные расписания")
    sched = src["schedule"]

    dates = {(int(y), int(m), int(d)): w
             for y, m, d, w in re.findall(r"\(\((\d+), (\d+), (\d+)\), Weeks::(Over|Under)\)", sched)}
    if dates == OFFICIAL_WEEKS:
        ok(f"таблица учебных недель: {len(dates)} официальных дат в тесте совпадают с bteu.by")
    else:
        fail(f"даты недель в rust/src/schedule.rs расходятся с официальной таблицей: "
             f"есть {sorted(dates.items())}, ждём {sorted(OFFICIAL_WEEKS.items())}. "
             "Если сменился семестр — обнови таблицу «Формирование учебных недель» "
             "на bteu.by, ANCHOR_MONDAY и этот тест")

    # считаем только стабильную таблицу: литералы замен в тестах не в счёт
    at = sched.find("const SCHEDULE")
    table = sched[at:sched.find("/// Тип занятия по предмету", at)] if at >= 0 else ""
    pairs = len(re.findall(r"^\s+subj:", table, re.M))
    if pairs >= 25:
        ok(f"пар в данных: {pairs} записей с учётом вариантов над/под")
    else:
        fail(f"в rust/src/schedule.rs только {pairs} записей пар — таблица неполная")

    subjects = set(re.findall(r'subj:\s*(?:\n\s*)?"((?:[^"\\]|\\.)+)"', table))
    at = sched.find("const KIND")
    kind_block = sched[at:sched.find("];", at)] if at >= 0 else ""
    missing = sorted(s for s in subjects if f'"{s}"' not in kind_block)
    if missing:
        warn("KIND не покрывает предметы (тип занятия не выведется): " + "; ".join(missing)[:200])
    else:
        ok(f"KIND покрывает все {len(subjects)} предметов")

    def const3(name):
        m = re.search(rf"{name}: Date = Date::new_const\((\d+), (\d+), (\d+)\)", sched)
        return tuple(int(v) for v in m.groups()) if m else None

    start, end, anchor = const3("SEMESTER_START"), const3("SEMESTER_END"), const3("ANCHOR_MONDAY")
    if start and end and anchor and start < end and anchor[2] == 21:
        ok(f"семестр {start}..{end}, якорь {anchor} (понедельник под-недели)")
    else:
        fail(f"границы семестра или якорь подозрительные: {start}, {end}, {anchor}")

    today = subprocess.run([sys.executable, "-c",
                            "from datetime import date; print(date.today().isoformat())"],
                           capture_output=True, text=True).stdout.strip()
    if end and today > "%04d-%02d-%02d" % end:
        warn(f"данные кончились: сегодня {today}, а семестр до {end} — везде «пар нет»")

    at = sched.find("pub const SUBSTITUTIONS")
    block = sched[at:sched.find("];", at)] if at >= 0 else ""
    subs = re.findall(
        r"Sub\s*\{\s*day:\s*\((\d+),\s*(\d+),\s*(\d+)\),\s*num:\s*(\d+)", block, re.S)
    if not subs:
        ok("датных замен в данных нет — бот показывает стабильную таблицу")
    else:
        bad = []
        for y, m, d, num in subs:
            iso = "%04d-%02d-%02d" % (int(y), int(m), int(d))
            if not 1 <= int(num) <= 7:
                bad.append(f"слот {num} в {iso}")
            if start and not ("%04d-%02d-%02d" % start <= iso <= "%04d-%02d-%02d" % end):
                bad.append(f"дата {iso} вне семестра")
        if bad:
            fail("замены с ошибками: " + ", ".join(bad))
        else:
            ok(f"датных замен: {len(subs)} — вне семестра и чужих слотов нет "
               "(свежесть против сайта проверяет check_site.py)")


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
    sys.stdout.reconfigure(encoding="utf-8")

    src = {p.stem: p.read_text(encoding="utf-8") for p in sorted(RUST_SRC.glob("*.rs"))}
    src["all"] = "\n".join(src.values())

    check_rust()
    check_static(src)
    check_data(src)

    if not local_only:
        env = load_env()
        check_prod(env)
        check_deploy()
        check_panel(env)

    print(f"\n=== ИТОГ: FAIL={len(FAILS)}, WARN={len(WARNS)} ===")
    for f in FAILS:
        print(f"  FAIL: {f}")
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main()
