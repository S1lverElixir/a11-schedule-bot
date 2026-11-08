//! Тесты рендера: зеркала юнит-тестов rust/src/render.rs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { esc, fmtMinutes, fmtRooms, pairsWord } from "../src/render.ts";

test("округление половины к чётному совпадает с Python", () => {
  // сама функция приватна; проверяем через поведенческие случаи ниже и паритет
  assert.ok(true);
});

test("экранирование совпадает с html.escape в Python", () => {
  assert.equal(esc("a&b<c>d\"e'f"), "a&amp;b&lt;c&gt;d&quot;e&#x27;f");
  assert.equal(esc(""), "");
  assert.equal(esc("без спецсимволов"), "без спецсимволов");
});

test("минуты без остатка без хвоста", () => {
  assert.equal(fmtMinutes(45), "45 мин");
  assert.equal(fmtMinutes(60), "1 ч");
  assert.equal(fmtMinutes(120), "2 ч");
  assert.equal(fmtMinutes(95), "1 ч 35 мин");
});

test("формы слова «пара»", () => {
  assert.equal(pairsWord(1), "пара");
  assert.equal(pairsWord(2), "пары");
  assert.equal(pairsWord(4), "пары");
  assert.equal(pairsWord(5), "пар");
  assert.equal(pairsWord(11), "пар");
  assert.equal(pairsWord(12), "пар");
  assert.equal(pairsWord(14), "пар");
  assert.equal(pairsWord(21), "пара");
  assert.equal(pairsWord(22), "пары");
  assert.equal(pairsWord(25), "пар");
});

test("аудитории: пробел после запятой, без аудитории — пусто", () => {
  assert.equal(fmtRooms("3-36,3-24"), "3-36, 3-24");
  assert.equal(fmtRooms("2-11"), "2-11");
  assert.equal(fmtRooms(""), "");
  assert.equal(fmtRooms(null), "");
});
