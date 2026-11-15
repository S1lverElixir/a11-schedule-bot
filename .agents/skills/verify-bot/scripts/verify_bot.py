# -*- coding: utf-8 -*-
"""Полная проверка бота расписания А-11: тесты и паритет фикстур, пересъёмка
эталона, статика воркера, данные расписания, прод-живость.

Запуск из корня проекта: python -X utf8 .agents/skills/verify-bot/scripts/verify_bot.py
Флаг --local пропускает сетевые проверки. Код выхода 0 = нет [FAIL].

Прод — воркер a11-bot на Cloudflare Workers, деплой вручную (npx wrangler deploy
из workers/). Локальная часть: node --test с паритетом против замороженных
фикстур workers/test/fixtures, tsc, статические правила воркера, данные
расписания и байт-в-байт пересъёмка эталона инструментом dump_views.ts.
Сеть: 409-тест канала Telegram, живость воркера, вебхук, команды.
"""

import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
WORKERS = ROOT / "workers"
WORKERS_TESTS = ["date", "schedule", "render", "ics", "parity", "handlers", "index"]
FIXTURES = WORKERS / "test" / "fixtures"
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
def check_fixtures():
    """Фикстуры на месте и в разумных пределах: паритет 7600 видов и 70 вызовов."""
    section("ЛОКАЛЬНО: замороженные фикстуры")
    missing = [n for n in ("views.json", "handlers.json") if not (FIXTURES / n).exists()]
    if missing:
        fail("нет фикстур: " + ", ".join(f"workers/test/fixtures/{n}" for n in missing))
        return
    views = json.loads((FIXTURES / "views.json").read_text(encoding="utf-8"))
    cases = views.get("cases", [])
    if len(cases) >= 7000:
        ok(f"views.json: {len(cases)} случаев, генератор {views.get('generator', '?')!r}")
    else:
        fail(f"views.json подозрительно мал: {len(cases)} случаев (ждём не меньше 7000)")
    names = [c.get("name") for c in cases]
    dup = len(names) - len(set(names))
    if dup:
        fail(f"в views.json {dup} дублей имён — эталон повреждён")
    else:
        ok("имена видов уникальны")
    handlers = json.loads((FIXTURES / "handlers.json").read_text(encoding="utf-8"))
    n = len(handlers.get("cases", handlers if isinstance(handlers, list) else []))
    if n >= 60:
        ok(f"handlers.json: {n} вызовов обработчиков")
    else:
        fail(f"handlers.json подозрительно мал: {n} вызовов (ждём не меньше 60)")


def check_dump_parity():
    """dump_views.ts обязан воспроизводить фикстуру байт-в-байт: генератор и порт
    не могут разойтись — любое расхождение означает, что кто-то правил одну сторону."""
    section("ЛОКАЛЬНО: пересъёмка эталона dump-инструментом")
    fixture = FIXTURES / "views.json"
    if not fixture.exists():
        fail("views.json нет — пересъёмку не с чем сверять")
        return
    try:
        doc = json.loads(fixture.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        fail(f"views.json не разбирается: {e}")
        return
    generator = doc.get("generator", "")
    try:
        r = subprocess.run(
            ["node", "workers/tools/dump_views.ts", "--generator", generator],
            capture_output=True, timeout=300, cwd=ROOT)
    except FileNotFoundError:
        fail("node не найден — пересъёмка не выполнена")
        return
    except subprocess.TimeoutExpired:
        fail("dump_views.ts не завершился за 5 минут")
        return
    if r.returncode != 0:
        fail(f"dump_views.ts упал (rc={r.returncode}): {r.stderr.decode('utf-8', 'replace')[-300:]}")
        return
    fresh = r.stdout
    frozen = fixture.read_bytes()
    if fresh == frozen:
        ok(f"dump_views.ts воспроизводит эталон байт-в-байт ({len(doc.get('cases', []))} видов)")
        return
    n = min(len(fresh), len(frozen))
    pos = next((i for i in range(n) if fresh[i] != frozen[i]), n)
    fail(f"переснятый эталон расходится с фикстурой: первое различие на байте {pos} "
         f"(переснято {len(fresh)}, заморожено {len(frozen)}). "
         "Если смену поведения планировали — пересними фикстуру dump_views.ts и "
         "прочитай diff; если нет — ищи, что поломалось")


def check_workers():
    """Воркер: тесты node с паритетом внутри, типы, статические правила."""
    section("ЛОКАЛЬНО: воркер Workers — тесты, типы, статика")
    if not (WORKERS / "package.json").exists():
        fail("папки workers нет")
        return
    test_files = [str(WORKERS / "test" / f"{n}.test.ts") for n in WORKERS_TESTS]
    missing = [f for f in test_files if not Path(f).exists()]
    if missing:
        fail("нет тестов воркера: " + ", ".join(Path(f).name for f in missing))
        return
    try:
        r = subprocess.run(["node", "--test", *test_files],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", cwd=ROOT, timeout=600)
    except FileNotFoundError:
        fail("node не найден — воркер не проверялся")
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
        ok(f"воркер: {m_pass.group(1) if m_pass else '?'} тестов зелёные "
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
        ok(f"фильтр владельца в обработчиках сообщений и нажатий ({guards} проверки)")
    else:
        fail(f"в workers/src/bot.ts проверок на owner — {guards}, нужно минимум 2")

    chats = len(re.findall(r"chatId !== this\.ownerId", wsrc.get("bot", "")))
    if chats >= 2:
        ok(f"страховка chat_id в обработчиках ({chats} проверки)")
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


def check_data():
    """Данные: официальные даты недель в тесте, полнота таблицы, границы семестра."""
    section("ЛОКАЛЬНО: данные расписания")
    sched = (WORKERS / "src" / "schedule.ts").read_text(encoding="utf-8")
    tests = (WORKERS / "test" / "schedule.test.ts").read_text(encoding="utf-8")

    dates = {(int(y), int(m), int(d)): w
             for y, m, d, w in re.findall(r"\[\[(\d+), (\d+), (\d+)\], \"(Over|Under)\"\]", tests)}
    if dates == OFFICIAL_WEEKS:
        ok(f"таблица учебных недель: {len(dates)} официальных дат в тесте совпадают с bteu.by")
    else:
        fail(f"даты недель в workers/test/schedule.test.ts расходятся с официальной таблицей: "
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
        fail(f"в workers/src/schedule.ts только {pairs} записей пар — таблица неполная")

    subjects = set(re.findall(r'subj:\s*(?:\n\s*)?"((?:[^"\\]|\\.)+)"', table))
    at = sched.find("const KIND")
    kind_block = sched[at:sched.find("];", at)] if at >= 0 else ""
    missing = sorted(s for s in subjects if f'"{s}"' not in kind_block)
    if missing:
        warn("KIND не покрывает предметы (тип занятия не выведется): " + "; ".join(missing)[:200])
    else:
        ok(f"KIND покрывает все {len(subjects)} предметов")

    def const3(name):
        m = re.search(rf"{name}: Date = Date\.newConst\((\d+), (\d+), (\d+)\)", sched)
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

    at = sched.find("export const SUBSTITUTIONS")
    block = sched[at:sched.find("\n];", at)] if at >= 0 else ""
    subs = re.findall(
        r"day:\s*\[(\d+),\s*(\d+),\s*(\d+)\],\s*\n\s*num:\s*(\d+)", block)
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
               "(свежесть против сайта проверяет tools/check_site.py)")


# ---------------------------------------------------------------- сеть
WORKER_URL = "https://a11-bot.egor-kuzko-04.workers.dev"


def check_workers_prod(env):
    section("ПРОД: воркер на Cloudflare Workers (URL, вебхук, команды)")
    if not env.get("BOT_TOKEN"):
        warn("нет BOT_TOKEN в .env — прод-проверки воркера пропущены")
        return
    try:
        # workers.dev за Cloudflare: urllib получает 403, curl с браузерным UA проходит;
        # локальный DNS качается волнами — то IPv6-only, то SERVFAIL — поэтому
        # лестница: прямой -4 с ретраями → A-записи через два DoH-резолвера →
        # известные anycast-IP эджа. SNI один и тот же, любой эдж отдаёт воркер.
        ua = ["-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                     "AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36"]
        host = WORKER_URL[len("https://"):]
        base = ["curl", "-4", "-s", "--max-time", "25", "-w", "\n%{http_code}", WORKER_URL] + ua
        attempts = [base + ["--retry", "4", "--retry-all-errors", "--retry-delay", "2"]]
        for resolver in ("https://cloudflare-dns.com/dns-query", "https://1.1.1.1/dns-query"):
            doh = subprocess.run(
                ["curl", "-4", "-s", "--max-time", "15", f"{resolver}?name={host}&type=A",
                 "-H", "accept: application/dns-json"],
                capture_output=True, text=True, timeout=25)
            attempts.extend(
                base + ["--resolve", f"{host}:443:{ip}"]
                for ip in re.findall(r'"data":\s*"(\d+\.\d+\.\d+\.\d+)"', doh.stdout)[:2])
        attempts.extend(
            base + ["--resolve", f"{host}:443:{ip}"]
            for ip in ("188.114.97.11", "104.21.0.1"))
        code = "000"
        body = ""
        for args in attempts:
            r = subprocess.run(args, capture_output=True, text=True, timeout=60)
            body, _, code = r.stdout.rpartition("\n")
            if code == "200" and "a11-bot worker" in body:
                break
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


def main():
    local_only = "--local" in sys.argv
    sys.stdout.reconfigure(encoding="utf-8")

    check_fixtures()
    check_dump_parity()
    check_workers()
    check_data()

    if not local_only:
        env = load_env()
        check_prod(env)
        check_workers_prod(env)

    print(f"\n=== ИТОГ: FAIL={len(FAILS)}, WARN={len(WARNS)} ===")
    for f in FAILS:
        print(f"  FAIL: {f}")
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main()
