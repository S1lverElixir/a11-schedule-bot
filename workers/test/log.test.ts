//! Тесты лога: скраббер токена и правило «первый непустой секрет выигрывает».
//! Файл исполняется в отдельном процессе node --test — модульное состояние log.ts
//! здесь своё и чужие тесты не задевает.

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import * as log from "../src/log.ts";

test("скраббер: первый непустой секрет остаётся навсегда", () => {
  const lines: string[] = [];
  const spy = mock.method(console, "log", (msg: string) => lines.push(msg));
  try {
    log.setSecret("");
    log.info("пока секрета нет — строка как есть: бот 1:секрет");
    assert.ok(lines.at(-1)!.includes("1:секрет"), "пустой секрет не включает скраббер");

    log.setSecret("1:секрет");
    log.warn("упало соединение с 1:секрет в URL");
    assert.ok(!lines.at(-1)!.includes("1:секрет"), "токен заменён звёздочками");
    assert.ok(lines.at(-1)!.includes("***"));

    log.setSecret("другой-токен");
    log.error("новый секрет другой-токен не подхватился, старый 1:секрет всё в силе");
    assert.ok(!lines.at(-1)!.includes("1:секрет"), "первый секрет всё ещё скраббится");
    assert.ok(lines.at(-1)!.includes("другой-токен"), "новый секрет скраббером не ловится");
  } finally {
    spy.mock.restore();
  }
});

test("метка времени и уровень в начале строки", () => {
  const lines: string[] = [];
  const spy = mock.method(console, "log", (msg: string) => lines.push(msg));
  try {
    log.info("текст");
    assert.match(lines.at(-1)!, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} INFO текст$/);
    log.error("беда");
    assert.match(lines.at(-1)!, / ERROR беда$/);
  } finally {
    spy.mock.restore();
  }
});
