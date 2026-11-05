# -*- coding: utf-8 -*-
"""Проверка Rust-бота: сборка, тесты, паритет против замороженных снимков, память.

Запуск из корня проекта: python -X utf8 rust/tools/check.py
Код выхода 0 = нет [FAIL]. Секреты не читаются: .env не трогаем.
"""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RUST = ROOT / "rust"
BIN = RUST / "target" / "release" / ("a11-bot.exe" if os.name == "nt" else "a11-bot")
FIXTURE = RUST / "tests" / "fixtures" / "views.json"
HANDLERS = RUST / "tests" / "fixtures" / "handlers.json"

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


def tail(text, lines=6):
    rows = [r for r in text.strip().splitlines() if r.strip()]
    return " | ".join(rows[-lines:])


def run(cmd, cwd=RUST, env=None):
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", env=env)


def check_build():
    section("СБОРКА release")
    r = run(["cargo", "build", "--release"])
    if r.returncode != 0:
        fail(f"cargo build: {tail(r.stderr)}")
        return False
    if not BIN.exists():
        fail(f"бинарника нет: {BIN}")
        return False
    mb = BIN.stat().st_size / 1048576
    ok(f"бинарник {mb:.2f} МБ (лимит хостинга — 128 МБ памяти)")
    return True


def count_cases(path):
    try:
        return len(json.loads(path.read_text(encoding="utf-8"))["cases"])
    except (OSError, ValueError, KeyError) as e:
        fail(f"снимки {path.name} не читаются: {e}")
        return 0


def check_tests():
    section("ТЕСТЫ и паритет")
    r = run(["cargo", "test", "--quiet"])
    if r.returncode != 0:
        fail(f"cargo test: {tail(r.stderr, 12)}")
        return
    passed = sum(int(m) for m in re.findall(r"test result: ok\. (\d+) passed", r.stdout))
    ok(f"cargo test: {passed} тестов зелёные")
    views = count_cases(FIXTURE)
    handlers = count_cases(HANDLERS)
    if views < 7000:
        warn(f"снимков видов подозрительно мало: {views}")
    else:
        ok(f"паритет видов: {views} случаев")
    if handlers < 60:
        warn(f"снимков обработчиков подозрительно мало: {handlers}")
    else:
        ok(f"паритет обработчиков: {handlers} случаев")


def check_fixture_fresh():
    """Снимки — замороженный эталон поведения прежнего Python-бота.

    Python-бота в репозитории больше нет, поэтому снимки нечем перегенерировать:
    они ловят случайное изменение текстов и вызовов, а не сверяют два бота.
    Менять их руками можно только вместе с осознанной сменой поведения.
    """
    section("СНИМКИ: замороженный эталон")
    for path, minimum in ((FIXTURE, 7000), (HANDLERS, 60)):
        n = count_cases(path)
        if n == 0:
            return
        if n < minimum:
            warn(f"{path.name}: случаев {n}, ожидалось не меньше {minimum}")
        else:
            ok(f"{path.name}: {n} случаев, паритет обязан их прогнать")
    ok("эталон заморожен: проверка означает «Rust не изменил поведение», "
       "сверки с Python-ботом больше нет")


def check_memory():
    section("ПАМЯТЬ и мозг без сети")
    if not BIN.exists():
        fail("нечего измерять: нет бинарника")
        return
    r = run([str(BIN), "--selftest", "2"])
    if r.returncode != 0:
        fail(f"selftest: {tail(r.stderr or r.stdout)}")
        return
    m_hash = re.search(r"хеш ([0-9a-f]+)", r.stdout)
    m_mem = re.search(r"пик памяти процесса: ([\d.]+) МБ", r.stdout)
    if not m_hash:
        fail(f"selftest: непонятный вывод {r.stdout.strip()[:200]}")
        return
    ok(f"все виды за семестр построены, хеш {m_hash.group(1)}")
    if not m_mem:
        warn("пик памяти не прочитался (не Windows и не Linux)")
        return
    mb = float(m_mem.group(1))
    if mb >= 50:
        fail(f"пик памяти {mb:.1f} МБ — слишком много для бинарника, ищем утечку")
    elif mb >= 25:
        warn(f"пик памяти {mb:.1f} МБ — выше ожидаемого")
    else:
        ok(f"пик памяти {mb:.1f} МБ (лимит хостинга 128 МБ)")


def main():
    print("Rust-бот А-11: проверка")
    if not (RUST / "Cargo.toml").exists():
        print("  [FAIL] нет rust/Cargo.toml")
        sys.exit(1)
    built = check_build()
    check_tests()
    check_fixture_fresh()
    if built:
        check_memory()
    print(f"\n=== ИТОГ: FAIL={len(FAILS)}, WARN={len(WARNS)} ===")
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main()
