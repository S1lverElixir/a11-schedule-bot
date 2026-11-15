//! Тесты обработчиков на сбоях сети и враждебном вводе: ошибки Telegram не роняют
//! обработку, чужие чаты и кривые callback-данные отсекаются молча.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Bot } from "../src/bot.ts";
import { Date, type Now } from "../src/date.ts";
import type { Api } from "../src/telegram.ts";

const NOW: Now = { date: Date.parseIso("2026-11-13")!, minute: 450 };
const OWNER = 1;

/// Заглушка Api: бросает на выбранном методе, вызовы записывает до броска.
class FailApi implements Api {
  calls: { method: string; params: unknown }[] = [];
  failOn: string | null = null;

  async call(method: string, params: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === this.failOn) throw new Error("сеть легла");
    return null;
  }

  async sendDocument(
    chatId: number,
    filename: string,
    content: Uint8Array,
    caption: string,
    replyMarkup?: unknown,
  ): Promise<unknown> {
    this.calls.push({
      method: "sendDocument",
      params: {
        chat_id: chatId,
        filename,
        caption,
        content: new TextDecoder().decode(content),
        reply_markup: replyMarkup,
      },
    });
    if (this.failOn === "sendDocument") throw new Error("сеть легла");
    return null;
  }
}

function message(text: string, chatId: number = OWNER): Record<string, unknown> {
  return { message: { from: { id: OWNER }, chat: { id: chatId }, text } };
}

function callback(data: string, chatId: number = OWNER): Record<string, unknown> {
  return {
    callback_query: { id: "cb1", from: { id: OWNER }, data, message: { chat: { id: chatId } } },
  };
}

test("send: сбой sendMessage не роняет обработку", async () => {
  const api = new FailApi();
  api.failOn = "sendMessage";
  const bot = new Bot(api, OWNER);
  await bot.handleUpdate(message("Сегодня"), NOW);
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0]!.method, "sendMessage");
});

test("ics: сбой sendDocument не роняет обработку", async () => {
  const api = new FailApi();
  api.failOn = "sendDocument";
  const bot = new Bot(api, OWNER);
  await bot.handleUpdate(callback("ics:2026-10-26"), NOW);
  assert.equal(api.calls.length, 2);
  assert.equal(api.calls[1]!.method, "sendDocument");
});

test("answerCallbackQuery: сбой не мешает отправке ответа", async () => {
  const api = new FailApi();
  api.failOn = "answerCallbackQuery";
  const bot = new Bot(api, OWNER);
  await bot.handleUpdate(callback("wk:2026-10-19"), NOW);
  assert.equal(api.calls.length, 2);
  assert.equal(api.calls[1]!.method, "sendMessage");
});

test("callback без id — только молчание", async () => {
  const api = new FailApi();
  const bot = new Bot(api, OWNER);
  await bot.handleUpdate(
    { callback_query: { from: { id: OWNER }, data: "wk:2026-10-19" } },
    NOW,
  );
  assert.deepEqual(api.calls, []);
});

test("нажатие из чужого чата — после «часиков» никакого ответа", async () => {
  const api = new FailApi();
  const bot = new Bot(api, OWNER);
  await bot.handleUpdate(callback("wk:2026-10-19", 999), NOW);
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0]!.method, "answerCallbackQuery");
});

test("кривые callback-данные: answer уходит, ответов нет", async () => {
  const api = new FailApi();
  const bot = new Bot(api, OWNER);
  for (const data of ["junk:x", "cal:криво", "wk:", "ics:2026-13-40", "cal:2026-02:99"]) {
    await bot.handleUpdate(callback(data), NOW);
  }
  const answers = api.calls.filter((c) => c.method === "answerCallbackQuery");
  assert.equal(answers.length, 5, "на каждый callback — свои «часики»");
  assert.equal(api.calls.filter((c) => c.method === "sendMessage").length, 0);
});

test("сообщение без chat_id и нетекстовое — молчание", async () => {
  const api = new FailApi();
  const bot = new Bot(api, OWNER);
  await bot.handleUpdate({ message: { from: { id: OWNER }, text: "Сегодня" } }, NOW);
  await bot.handleUpdate(
    { message: { from: { id: OWNER }, chat: { id: OWNER }, photo: {} } },
    NOW,
  );
  assert.deepEqual(api.calls, []);
});

test("перелистывание календаря без сообщения — только «часики»", () => {
  const api = new FailApi();
  const bot = new Bot(api, OWNER);
  // Telegram не присылает message у очень старых сообщений — чат берётся из владельца
  const cb = {
    callback_query: { id: "cb1", from: { id: OWNER }, data: "cal:2026-10" },
  };
  return bot.handleUpdate(cb, NOW).then(() => {
    assert.equal(api.calls.length, 1);
    assert.equal(api.calls[0]!.method, "answerCallbackQuery");
  });
});

test("неизвестный префикс callback — answer и badData, без ответов", async () => {
  const api = new FailApi();
  const bot = new Bot(api, OWNER);
  await bot.handleUpdate(callback("junk:2026"), NOW);
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0]!.method, "answerCallbackQuery");
});

test("editMessageReplyMarkup: сбой не роняет обработку", async () => {
  const api = new FailApi();
  api.failOn = "editMessageReplyMarkup";
  const bot = new Bot(api, OWNER);
  const cb = {
    callback_query: {
      id: "cb1",
      from: { id: OWNER },
      data: "cal:2026-10",
      message: { chat: { id: OWNER }, message_id: 500 },
    },
  };
  await bot.handleUpdate(cb, NOW);
  assert.equal(api.calls.length, 2);
  assert.equal(api.calls[1]!.method, "editMessageReplyMarkup");
});
