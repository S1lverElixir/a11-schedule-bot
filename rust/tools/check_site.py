# -*- coding: utf-8 -*-
"""Сверка расписания А-11 с сайтом bteu.by: замены, стабильная таблица, недели.

Запуск из корня проекта (нужен xlrd: python -m pip install xlrd):

    python -X utf8 rust/tools/check_site.py            # отчёт
    python -X utf8 rust/tools/check_site.py --emit     # ещё и блок SUBSTITUTIONS

Скрипт ничего не меняет в репозитории: он читает сайт, разбирает файлы и сверяет
с тем, что знает бот (`a11-bot --dump-schedule`). Замены он предлагает блоком,
который человек смотрит и переносит в rust/src/schedule.rs — предмет в файлах
деканата набран то заглавными, то строчными, и самовставка была бы правкой текста
бота без проверки.

Что смотрим:
- «Стабильное расписание» ФЭУ, файл потока А-1 (в нём колонка А-11);
- «Начитка» — файлы того же потока на диапазон дат: это и есть замены;
- «Час куратора ФЭУ» — датные занятия, которых в недельной таблице нет;
- «Формирование учебных недель» — черта недели, чтобы якорь не уехал.
"""

import datetime as dt
import html
import io
import json
import re
import subprocess
import sys
import urllib.parse
import urllib.request

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0"}

PAGE_STABLE = 11427   # Стабильное расписание ФЭУ
PAGE_NACHITKA = 8929  # Начитка (дневная форма)
PAGE_WEEKS = 30575    # Формирование учебных недель
PAGE_CURATOR = 11427  # график кураторского часа лежит на той же странице

# Время первой половины пары -> номер слота. Звонки берём с сайта, но слоты
# у А-11 всегда эти.
SLOT_BY_TIME = {
    "9.00": 1, "10.50": 2, "12.55": 3, "14.40": 4,
    "16.25": 5, "18.30": 6, "20.15": 7,
}
# вторая половина пары: строка с таким временем продолжает тот же слот
SECOND_HALF = {"9.50", "11.40", "13.45", "15.30", "17.15", "19.20", "21.05"}
MONTHS = {
    "января": 1, "февраля": 2, "марта": 3, "апреля": 4, "мая": 5, "июня": 6,
    "июля": 7, "августа": 8, "сентября": 9, "октября": 10, "ноября": 11, "декабря": 12,
}
DAY_NAMES = {
    "ПОНЕДЕЛЬНИК": 0, "ПОНЕДЕЛЬ": 0, "ВТОРНИК": 1, "ВТОРНИК": 1, "СРЕДА": 2,
    "ЧЕТВЕРГ": 3, "ПЯТНИЦА": 4, "СУББОТА": 5, "ВОСКРЕСЕНЬЕ": 6,
}
GROUP_COLUMN = "А -11"


def ok(msg):
    print(f"  [OK]   {msg}")


def warn(msg):
    print(f"  [WARN] {msg}")


def fail(msg):
    print(f"  [FAIL] {msg}")
    FAILS.append(msg)


FAILS = []


def get(url, timeout=90):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout).read()


def page(pid):
    return json.loads(get(f"https://bteu.by/wp-json/wp/v2/pages/{pid}").decode("utf-8", "replace"))


def page_links(pid):
    body = page(pid)["content"]["rendered"]
    out = []
    for m in re.finditer(r'<a[^>]*href="([^"]+)"[^>]*>(.*?)</a>', body, re.S):
        text = html.unescape(re.sub(r"<[^>]+>", "", m.group(2)))
        out.append((re.sub(r"\s+", " ", text).strip(), m.group(1)))
    return out


def clean(raw):
    """Строка таблицы к сравнению: без даты действия, в нижнем регистре, без лишнего."""
    s = re.sub(r"с\s*\d{2}\.\d{2}\.\d{2}", " ", raw)
    s = re.sub(r"\s+", " ", s).strip().lower()
    return s


def split_entry(text):
    """«1-25 Линейная алгебра ... доц.Кузменкова И.А.» -> предмет, аудитории, люди."""
    t = re.sub(r"^с\s*\d{2}\.\d{2}(\.\d{2,4})?\.?\s*", "", " ".join(text.split()))
    rooms = ""
    m = re.match(r"^(\d+\s*-\s*\d+(?:\s*[;,]\s*\d+\s*-\s*\d+)*)\s+", t)
    if m:
        rooms = re.sub(r"\s+", "", m.group(1)).replace(";", ",")
        t = t[m.end():]
    people = ""
    m = re.search(r"\b(доц|ст\.?\s*пр|пр\.?-ст|пр|асс|преп)\b", t)
    if m:
        people = " ".join(t[m.start():].split())
        t = t[:m.start()]
    return " ".join(t.split()), rooms, people


def read_sheet(blob):
    """Последний лист .xls как список непустых строк по трём колонкам."""
    import xlrd

    book = xlrd.open_workbook(file_contents=blob)
    sh = book.sheet_by_index(book.nsheets - 1)
    rows = []
    for r in range(sh.nrows):
        vals = []
        for c in range(min(sh.ncols, 3)):
            v = sh.cell_value(r, c)
            if isinstance(v, float) and v == int(v):
                v = int(v)
            vals.append(str(v).strip())
        if any(vals):
            rows.append(vals)
    return rows


def group_block(rows):
    """Колонка нашей группы и строки её блока: от заголовка до следующего «Дни».

    В файлах деканата группы идут столбцами (стабильное расписание) или блоками
    строк (график кураторского часа) — без границы блока читались бы чужие занятия.
    """
    want = clean(GROUP_COLUMN).replace(" ", "")
    for i, row in enumerate(rows):
        for c, v in enumerate(row):
            if clean(v).replace(" ", "") != want:
                continue
            end = len(rows)
            for j in range(i + 1, len(rows)):
                if rows[j] and clean(rows[j][0]).upper().startswith("ДНИ"):
                    end = j
                    break
            return c, rows[i + 1:end]
    return None, []


def parse_week_table(rows, col):
    """Сетка дней: {день: {слот: {'над': [строки], 'под': [строки]}}} по правилу черты.

    Черта в файле делит слот пополам: строки над ней действуют в недели «над»,
    под ней — в недели «под»; пустая половина означает, что занятий нет.
    """
    out = {}
    day = slot = None
    half = "над"
    for row in rows:
        head = clean(row[0]) if row else ""
        when = clean(row[1]) if len(row) > 1 else ""
        text = (row[col] if col < len(row) else "").strip()
        up = head.upper()
        matched = next((num for key, num in DAY_NAMES.items() if up.startswith(key)), None)
        if matched is not None:
            day, slot, half = matched, None, "над"
            out.setdefault(day, {})
        if day is None:
            continue
        m = re.match(r"^(\d{1,2})\.(\d{2})", when)
        if m:
            key = f"{int(m.group(1))}.{m.group(2)}"
            if key in SECOND_HALF:
                pass  # продолжает текущий слот
            elif key in SLOT_BY_TIME:
                slot = SLOT_BY_TIME[key]
                half = "над"
                out[day].setdefault(slot, {"над": [], "под": []})
            else:
                slot = None
        if slot is None or not text:
            continue
        if set(text) <= set("—-–"):
            half = "под"
            continue
        out[day][slot][half].append(text)
    return {d: {s: {k: " ".join(v) for k, v in halves.items()}
                for s, halves in slots.items()}
            for d, slots in out.items()}


def dated_rows(rows, col):
    """Строки вида «03.12.2026 | 12.55-13.40 | 3-6 Химия ...» — занятия с датой."""
    out = []
    for row in rows:
        first = clean((row + [""])[0])
        m = re.match(r"^(\d{2})\.(\d{2})\.(\d{2,4})$", first)
        if not m:
            continue
        d, mo, y = m.groups()
        y = (y if len(y) == 4 else "20" + y).zfill(4)
        when = (row + ["", ""])[1]
        text = row[col] if col < len(row) else (row + ["", "", ""])[2]
        if not text:
            continue
        mm = re.match(r"^(\d{1,2})\.(\d{2})", clean(when))
        slot = SLOT_BY_TIME.get(f"{int(mm.group(1))}.{mm.group(2)}") if mm else None
        try:
            date = dt.date(int(y), int(mo), int(d))
        except ValueError:
            continue
        out.append({"date": date, "slot": slot, "time": when, "raw": text})
    return out


def range_of(label):
    """«А-1 с 01.09-13.09» -> (date, date) в 2026 году, если диапазон понятен."""
    m = re.search(r"(\d{2})\.(\d{2})\s*[-–]\s*(\d{2})\.(\d{2})", label)
    if not m:
        return None
    d1, m1, d2, m2 = (int(v) for v in m.groups())
    year = 2026
    try:
        return dt.date(year, m1, d1), dt.date(year, m2, d2)
    except ValueError:
        return None


def our_data():
    import pathlib

    bin_path = pathlib.Path("rust/target/release/a11-bot.exe" if sys.platform == "win32"
                            else "rust/target/release/a11-bot")
    if not bin_path.exists():
        raise SystemExit("сначала собери бинарник: cargo build --release --manifest-path rust/Cargo.toml")
    out = subprocess.run([str(bin_path), "--dump-schedule"], capture_output=True,
                         text=True, encoding="utf-8", check=True)
    return json.loads(out.stdout)


def week_mark(d, anchor):
    """Черта недели, содержащей день, — как её считает бот."""
    monday = d - dt.timedelta(days=d.weekday())
    return "под" if ((monday - anchor).days // 7) % 2 == 0 else "над"


def weeks_table():
    """Официальная таблица недель: {понедельник: 'над'|'под'} из текста страницы."""
    body = html.unescape(re.sub(r"<[^>]+>", " ", page(PAGE_WEEKS)["content"]["rendered"]))
    body = re.sub(r"\s+", " ", body)
    out = {}
    for mark in ("над", "под"):
        section = re.search(mark + r" чертой(.*?)(над чертой|под чертой|$)", body, re.S)
        if not section:
            continue
        seg = section.group(1)
        for r in re.finditer(r"(\d{1,2})\s+(" + "|".join(MONTHS) + r")\s*[–-]\s*\d{1,2}\s+\w+", seg):
            try:
                out[dt.date(2026, MONTHS[r.group(2)], int(r.group(1)))] = mark
            except ValueError:
                continue
        for r in re.finditer(r"(\d{2})\.(\d{2})\s*[–-]\s*(\d{2})\.(\d{2})", seg):
            try:
                out[dt.date(2026, int(r.group(2)), int(r.group(1)))] = mark
            except ValueError:
                continue
    return out


def compare_base(site, ours):
    """Стабильная таблица сайта против того, что знает бот."""
    bad = 0
    for day in range(7):
        ours_day = ours["days"][day]
        site_day = site.get(day, {})
        for slot, variants in sorted(site_day.items()):
            over, under = variants["над"], variants["под"]
            mine = [p for p in ours_day if p["num"] == slot]
            variants = [v for v in (over, under) if v]
            if len(variants) != len(mine):
                fail(f"день {day} слот {slot}: на сайте {len(variants)} вариант(а), в боте {len(mine)}")
                bad += 1
                continue
            for v in variants:
                subj, _, _ = split_entry(v)
                key = clean(subj)[:24]
                if not any(key in clean(p["subj"]) or clean(p["subj"])[:24] in key for p in mine):
                    fail(f"день {day} слот {slot}: на сайте «{subj[:60]}», в боте такого нет")
                    bad += 1
    if not bad:
        ok(f"стабильная таблица совпала с ботом (7 дней, {sum(len(v) for v in site.values())} слотов)")


def main():
    emit = "--emit" in sys.argv
    ours = our_data()
    print("=== Сверка с bteu.by ===")

    # 1) стабильное расписание
    stable = [(t, u) for t, u in page_links(PAGE_STABLE) if t.replace(" ", "").upper() == "А-1"]
    if not stable:
        fail("на странице «Стабильное расписание» не нашли файл потока А-1")
        return 1
    label, url = stable[0]
    rows = read_sheet(get(url))
    col, block = group_block(rows)
    if col is None:
        fail(f"в файле {label} нет колонки {GROUP_COLUMN}")
        return 1
    site = parse_week_table(block, col)
    compare_base(site, ours)

    # 2) черта недели
    weeks = weeks_table()
    anchor = dt.date.fromisoformat(ours["anchor_monday"])
    wrong = 0
    for monday, mark in sorted(weeks.items()):
        if monday < dt.date(2026, 9, 14) or monday > dt.date(2026, 12, 28):
            continue
        weeks_between = (monday - anchor).days // 7
        ours_mark = "под" if weeks_between % 2 == 0 else "над"
        if ours_mark != mark:
            fail(f"неделя {monday}: сайт говорит «{mark}», бот — «{ours_mark}»")
            wrong += 1
    if not wrong and weeks:
        ok(f"черта недели совпала с таблицей сайта ({len(weeks)} понедельников)")
    elif not weeks:
        warn("таблицу учебных недель не разобрали — проверь страницу вручную")

    # 3) начитка: файлы на диапазон дат = замены всего расписания того периода
    today = dt.date.today()
    subs = []
    for label, url in page_links(PAGE_NACHITKA):
        if not re.match(r"^А-1\b", label):
            continue
        rng = range_of(label)
        if not rng:
            continue
        a, b = rng
        if b < today - dt.timedelta(days=7):
            continue
        rows2 = read_sheet(get(url))
        col2, block2 = group_block(rows2)
        if col2 is None:
            continue
        site2 = parse_week_table(block2, col2)
        d = max(a, today)
        while d <= b:
            for slot, variants in site2.get(d.weekday(), {}).items():
                chosen = variants[week_mark(d, anchor)]
                if not chosen:
                    continue
                subj, rooms, people = split_entry(chosen)
                subs.append({"date": d, "slot": slot, "subj": subj,
                             "rooms": rooms, "teachers": people, "src": label,
                             "raw": chosen})
            d += dt.timedelta(days=1)
        ok(f"начитка «{label}» ({a}..{b}) разобрана")

    # 4) датные занятия: час куратора и подобные файлы
    for label, url in page_links(PAGE_CURATOR):
        if "КУРАТОРА" not in label.upper():
            continue
        try:
            rows3 = read_sheet(get(url))
        except Exception as e:
            warn(f"{label}: не разобрали ({e})")
            continue
        col3, block3 = group_block(rows3)
        if col3 is None:
            continue
        for e in dated_rows(block3, col3):
            if e["date"] < today:
                continue
            subj, rooms, people = split_entry(e["raw"])
            subs.append({"date": e["date"], "slot": e["slot"], "subj": subj,
                         "rooms": rooms, "teachers": people, "src": label,
                         "raw": e["raw"]})
        ok(f"график «{label}» прочитан")

    known = {(s["date"], s["num"]) for s in ours["substitutions"]}  # date уже строкой ISO
    fresh = [s for s in subs
             if s["slot"] and (s["date"].isoformat(), s["slot"]) not in known]
    stale = [s for s in ours["substitutions"]
             if (s["date"], s["num"]) not in
             {(x["date"].isoformat(), x["slot"]) for x in subs if x["slot"]}]
    if fresh:
        warn(f"на сайте есть замены, которых бот не знает: {len(fresh)}")
        for s in fresh[:20]:
            print(f"    {s['date']} {s['slot']}-я пара: {s['subj']}"
                  f"{', ауд. ' + s['rooms'] if s['rooms'] else ''} ({s['src']})")
    else:
        ok("новых замен на сайте нет")
    if stale:
        warn(f"в данных бота есть замены, которых нет на сайте: {len(stale)} — снять?")

    if emit:
        bells = {b["num"]: (b["start"], b["end"]) for b in ours["bells"]}
        print("\n// блок для rust/src/schedule.rs — проверь регистр предметов и пробелы")
        print("// у людей должность пишется как в данных бота: «ст.пр. Игнатьев А.М.»")
        for s in fresh:
            start, end = bells.get(s["slot"], ("", ""))
            print('    Sub {{ day: ({y}, {m}, {d}), num: {n}, start: "{start}", '
                  'end: "{end}", subj: "{subj}", rooms: {rooms}, '
                  'teachers: &[{teachers}] }},  // {raw}'.format(
                      y=s["date"].year, m=s["date"].month, d=s["date"].day, n=s["slot"],
                      start=start, end=end, subj=s["subj"].replace('"', "'"),
                      rooms=f'Some("{s["rooms"]}")' if s["rooms"] else "None",
                      teachers='"' + s["teachers"].replace('"', "'") + '"'
                      if s["teachers"] else "",
                      raw=s["raw"]))
    print(f"\n=== ИТОГ: FAIL={len(FAILS)} ===")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
