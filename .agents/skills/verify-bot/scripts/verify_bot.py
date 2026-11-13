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
WORKERS = ROOT / "workers"
WORKERS_TESTS = ["date", "schedule", "render", "ics", "parity", "handlers", "index"]


def check_workers():
    """Порт на Cloudflare Workers: тесты node, типы, статика нового кода.

    Главный тест здесь — паритет: порт пересчитывает те же 7600 снимков видов
    и 70 вызовов обработчиков против замороженных фикстур rust/tests/fixtures.
    """
    section("ЛОКАЛЬНО: порт Workers — тесты, типы, статика")
    if not (WORKERS / "package.json").exists():
        warn("папки workers нет — порт не проверялся")
        return
    test_files = [str(WORKERS / "test" / f"{n}.test.ts") for n in WORKERS_TESTS]
    missing = [f for f in test_files if not Path(f).exists()]
    if missing:
        fail("нет тестов порта: " + ", ".join(Path(f).name for f in missing))
        return
    try:
        r = subprocess.run(["node", "--test", *test_files],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", cwd=ROOT, timeout=600)
    except FileNotFoundError:
        fail("node не найден — порт Workers не проверялся")
        return
    except subprocess.TimeoutExpired:
        fail("node --test не завершился за 10 минут")
        return
    m_pass = re.search(r"^ℹ pass (\d+)", r.stdout, re.M)
    m_fail = re.search(r"^ℹ fail (\d+)", r.stdout, re.M)
    failed = int(m_fail.group(1)) if m_fail else (0 if r.returncode == 0 else -1)
    if r.returncode != 0 or failed != 0:
        tail = "\n".join(ln for ln in (r.stdout + r.stderr).splitlines() if ln.strip())[-500:]
        fail(f"node --test: rc={r.returncode}, провалено {failed} — порт расходится с эталоном\n{tail}")
    else:
        ok(f"порт Workers: {m_pass.group(1) if m_pass else '?'} тестов зелёные "
           "(паритет 7600 видов и 70 вызовов внутри)")

    if not (WORKERS / "node_modules" / "typescript").exists():
        warn("node_modules в workers нет (npm install) — типы не проверялись")
    else:
        try:
            t = subprocess.run(["node", "node_modules/typescript/bin/tsc", "--noEmit"],
                               capture_output=True, text=True, encoding="utf-8",
                               errors="replace", cwd=WORKERS, timeout=300)
            if t.returncode == 0:
                ok("типизация workers: tsc --noEmit чистая")
            else:
                fail(f"tsc --noEmit: rc={t.returncode}: {(t.stdout + t.stderr).strip()[-300:]}")
        except Exception as e:
            warn(f"tsc не запустился: {e}")

    wsrc = {p.stem: p.read_text(encoding="utf-8") for p in sorted((WORKERS / "src").glob("*.ts"))}
    wall = "\n".join(wsrc.values())

    guards = len(re.findall(r"\?\.id !== this\.ownerId", wsrc.get("bot", "")))
    if guards >= 2:
        ok(f"фильтр владельца в порте обработчиков ({guards} проверки)")
    else:
        fail(f"в workers/src/bot.ts проверок на owner — {guards}, нужно минимум 2")

    chats = len(re.findall(r"chatId !== this\.ownerId", wsrc.get("bot", "")))
    if chats >= 2:
        ok(f"страховка chat_id в порте обработчиков ({chats} проверки)")
    else:
        fail(f"в workers/src/bot.ts страховок chat_id — {chats}, нужно минимум 2")

    bad = [f"{name}: {m.group(0)!r}"
           for name, text in wsrc.items()
           for m in [EMOJI.search(text)] if m]
    if bad:
        fail("эмодзи в коде воркера: " + ", ".join(bad[:5]))
    else:
        ok("эмодзи в строках воркера нет")

    idx_src = wsrc.get("index", "")
    if "X-Telegram-Bot-Api-Secret-Token" not in idx_src:
        fail("в workers/src/index.ts нет проверки секрета вебхука")
    elif "crypto.subtle" not in idx_src or "secretOk" not in idx_src:
        fail("секрет вебхука сверяется не constant-time (нужны crypto.subtle и secretOk)")
    else:
        ok("вебхук: секретный заголовок, constant-time сверка, fail-closed (тесты index)")

    if re.search(r"\b\d{8,}:[A-Za-z0-9_-]{30,}\b", wall):
        fail("в workers/src похоже на литерал токена бота — секреты в коде запрещены")
    else:
        ok("токенов в исходниках воркера нет")

    try:
        cfg = (WORKERS / "wrangler.jsonc").read_text(encoding="utf-8")
        if "30 4 * * *" in cfg and "50 4 * * *" in cfg:
            ok("крон сводки: два слота 04:30/04:50 UTC = 07:30/07:50 по Минску")
        else:
            fail("в workers/wrangler.jsonc нет двух слотов крона 30/50 4 * * *")
    except OSError:
        fail("нет workers/wrangler.jsonc")


WORKER_URL = "https://a11-bot.egor-kuzko-04.workers.dev"


def check_workers_prod(env):
    section("ПРОД: воркер на Cloudflare Workers (URL, вебхук, команды)")
    if not env.get("BOT_TOKEN"):
        warn("нет BOT_TOKEN в .env — прод-проверки воркера пропущены")
        return
    try:
        # workers.dev за Cloudflare: urllib получает 403, curl с браузерным UA проходит;
        # локальный DNS иногда отдаёт только IPv6 с мёртвым путём — поэтому -4 и ретраи
        r = subprocess.run(
            ["curl", "-4", "-s", "--max-time", "25", "--retry", "4", "--retry-all-errors",
             "--retry-delay", "2", "-w", "\n%{http_code}", WORKER_URL,
             "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                   "AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36"],
            capture_output=True, text=True, timeout=180)
        body, _, code = r.stdout.rpartition("\n")
        if code == "200" and "a11-bot worker" in body:
            ok(f"воркер отвечает 200: {WORKER_URL}")
        else:
            fail(f"воркер ответил {code or r.returncode}, тело не распознано")
    except Exception as e:
        fail(f"воркер недоступен: {e.__class__.__name__}: {str(e)[:120]}")
        return
    try:
        req = urllib.request.Request(
            f"https://api.telegram.org/bot{env['BOT_TOKEN']}/getWebhookInfo",
            data=b"{}",
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read().decode("utf-8"))
        if not data.get("ok"):
            fail("getWebhookInfo вернул ok=false")
            return
        info = data.get("result", {})
        url = info.get("url", "")
        if url == WORKER_URL:
            ok("вебхук указывает на воркер")
        else:
            fail(f"вебхук указывает не на воркер: {url!r}")
        if info.get("last_error_message"):
            # поле живёт и после восстановления: свежесть решает, fail это или память
            age = time.time() - int(info.get("last_error_date", 0))
            if age < 3600:
                fail(f"свежая ошибка доставки: {info.get('last_error_message')}")
            else:
                warn(f"устаревшая ошибка доставки ({age // 3600} ч назад): {info.get('last_error_message')}")
        else:
            ok("ошибок доставки вебхука нет")
        pending = info.get("pending_update_count", 0)
        if pending:
            warn(f"в очереди вебхука {pending} апдейтов")
        else:
            ok("очередь вебхука пуста")
    except Exception as e:
        fail(f"getWebhookInfo: {e.__class__.__name__}: {str(e)[:120]}")
    try:
        req = urllib.request.Request(
            f"https://api.telegram.org/bot{env['BOT_TOKEN']}/getMyCommands",
            data=b"{}",
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read().decode("utf-8"))
        cmds = [c.get("command") for c in (data.get("result") or [])]
        if cmds == ["start", "help"]:
            ok("меню команд: /start, /help")
        else:
            warn(f"меню команд: {cmds or 'пусто'}")
    except Exception as e:
        warn(f"getMyCommands: {e.__class__.__name__}: {str(e)[:120]}")


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
        ok("409 получен — канал Telegram жив (polling или активный вебхук)")
    else:
        fail("409 не получен — прод-бот не держит ни polling, ни вебхук")


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
        if isinstance(data, dict) and data.get("errors"):
            detail = json.dumps(data["errors"], ensure_ascii=False)
            if "suspend" in detail.lower() or "ServerStateConflict" in detail:
                # после переезда на Workers это ожидаемо: срок сервера истёк
                warn("панель: сервер suspended — срок истёк, прод живёт на Workers")
                return
            fail(f"панель: непонятная ошибка {detail[:150]}")
            return
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
        elif suspended:
            # после переключения на Workers это ожидаемо: срок сервера истёк,
            # контейнер не работает, продление ручное и нужно только для отката
            warn("контейнер suspended — сервер приостановлен, прод живёт на Workers")
        elif state == "stopped":
            # штатное состояние после переключения на Workers: запаска выключена
            warn("контейнер stopped — переключено на Workers, запаска выключена")
        else:
            fail(f"контейнер {state}")
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
    check_workers()

    if not local_only:
        env = load_env()
        check_prod(env)
        check_deploy()
        check_workers_prod(env)
        check_panel(env)

    print(f"\n=== ИТОГ: FAIL={len(FAILS)}, WARN={len(WARNS)} ===")
    for f in FAILS:
        print(f"  FAIL: {f}")
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main()
