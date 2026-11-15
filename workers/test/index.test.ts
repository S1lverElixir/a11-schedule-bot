//! Платформенный слой входной точки: секрет вебхука (fail-closed, constant-time),
//! отсечка тела, разбор MY_TELEGRAM_ID, ветки утренней сводки с дедупликацией.
//!
//! Сеть подменяется швом makeBot из handleWebhook и заглушкой sendMessage.

import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { handleWebhook, cronSummary, parseOwnerId, secretOk, type Env } from "../src/index.ts";
import { Date, type Now } from "../src/date.ts";
import { Recorder } from "./helpers.ts";
import { Bot } from "../src/bot.ts";

/// Секрет вебхука в реальности — ASCII (ограничение заголовков Telegram), здесь тоже.
const SECRET = "test-webhook-secret-0123456789abcdef";
const NOW: Now = { date: Date.parseIso("2026-11-13")!, minute: 450 };

function envOf(over: Partial<Env> = {}): Env {
  return {
    BOT_TOKEN: "1:тест",
    MY_TELEGRAM_ID: "42",
    WEBHOOK_SECRET: SECRET,
    DEDUP: null as unknown as KVNamespace,
    ...over,
  };
}

function post(body: string, secret: string | undefined): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== undefined) {
    headers["X-Telegram-Bot-Api-Secret-Token"] = secret;
  }
  return new Request("https://worker.example/webhook", { method: "POST", body, headers });
}

async function runPost(update: unknown, env: Env, secret: string | undefined = SECRET) {
  const rec = new Recorder();
  const resp = await handleWebhook(
    post(JSON.stringify(update), secret),
    env,
    (ownerId) => new BotStub(rec, ownerId),
  );
  return { resp, rec };
}

/// Обёртка, чтобы Recorder снаружи выглядел как бот для шва handleWebhook.
class BotStub {
  rec: Recorder;
  ownerId: number;

  constructor(rec: Recorder, ownerId: number) {
    this.rec = rec;
    this.ownerId = ownerId;
  }

  async handleUpdate(update: unknown, now: Now = NOW): Promise<void> {
    const bot = new Bot(this.rec, this.ownerId);
    await bot.handleUpdate(update, now);
  }
}

test("secretOk: fail-closed и постоянное время сравнения", async () => {
  assert.equal(await secretOk(undefined, SECRET), false);
  assert.equal(await secretOk("", SECRET), false);
  assert.equal(await secretOk(SECRET, null), false);
  assert.equal(await secretOk(SECRET, ""), false);
  assert.equal(await secretOk(SECRET, "не-тот-секрет"), false);
  assert.equal(await secretOk(SECRET, `${SECRET}x`), false);
  assert.equal(await secretOk(SECRET, SECRET), true);
});

test("parseOwnerId: строгий разбор идентификатора владельца", () => {
  assert.equal(parseOwnerId("42"), 42);
  assert.equal(parseOwnerId(" 42 "), 42);
  assert.equal(parseOwnerId(undefined), null);
  assert.equal(parseOwnerId(""), null);
  assert.equal(parseOwnerId("  "), null);
  assert.equal(parseOwnerId("0"), null);
  assert.equal(parseOwnerId("+42"), null);
  assert.equal(parseOwnerId("-42"), null);
  assert.equal(parseOwnerId("42abc"), null);
  assert.equal(parseOwnerId("0123"), null);
  assert.equal(parseOwnerId("1".repeat(16)), null);
});

test("вебхук: GET живой, прочие методы отклонены", async () => {
  const get = await handleWebhook(
    new Request("https://worker.example/"),
    envOf(),
    () => new BotStub(new Recorder(), 42),
  );
  assert.equal(get.status, 200);
  assert.equal(await get.text(), "a11-bot worker\n");
  const put = await handleWebhook(
    new Request("https://worker.example/", { method: "PUT", body: "{}" }),
    envOf(),
    () => new BotStub(new Recorder(), 42),
  );
  assert.equal(put.status, 405);
});

test("вебхук: без секрета не принимается ничего (fail-closed)", async () => {
  const rec = new Recorder();
  const resp = await handleWebhook(
    post(JSON.stringify({ message: { from: { id: 42 }, chat: { id: 42 }, text: "Сегодня" } }), SECRET),
    envOf({ WEBHOOK_SECRET: undefined }),
    (ownerId) => new BotStub(rec, ownerId),
  );
  assert.equal(resp.status, 401);
  assert.deepEqual(rec.calls, []);
  const empty = await handleWebhook(
    post("{}", SECRET),
    envOf({ WEBHOOK_SECRET: "" }),
    (ownerId) => new BotStub(rec, ownerId),
  );
  assert.equal(empty.status, 401);
});

test("вебхук: чужой секрет и отсутствие заголовка отклонены", async () => {
  const { resp } = await runPost({}, envOf(), "another-secret-456");
  assert.equal(resp.status, 401);
  const rec = new Recorder();
  const noHeader = await handleWebhook(
    new Request("https://worker.example/", { method: "POST", body: "{}" }),
    envOf(),
    (ownerId) => new BotStub(rec, ownerId),
  );
  assert.equal(noHeader.status, 401);
  assert.deepEqual(rec.calls, []);
});

test("вебхук: тело больше 1 МБ отсечено до разбора", async () => {
  const rec = new Recorder();
  const resp = await handleWebhook(
    post("x".repeat(1024 * 1024 + 1), SECRET),
    envOf(),
    (ownerId) => new BotStub(rec, ownerId),
  );
  assert.equal(resp.status, 413);
  assert.deepEqual(rec.calls, []);
});

test("вебхук: кривой JSON — 400, кривой MY_TELEGRAM_ID — 500", async () => {
  const rec = new Recorder();
  const bad = await handleWebhook(
    post("{не-json", SECRET),
    envOf(),
    (ownerId) => new BotStub(rec, ownerId),
  );
  assert.equal(bad.status, 400);
  const badOwner = await handleWebhook(
    post("{}", SECRET),
    envOf({ MY_TELEGRAM_ID: "abc" }),
    (ownerId) => new BotStub(rec, ownerId),
  );
  assert.equal(badOwner.status, 500);
});

test("вебхук: чужое и нетекстовое — молчание, незнакомый текст — подсказка", async () => {
  const stranger = await runPost(
    { message: { from: { id: 999 }, chat: { id: 999 }, text: "Сегодня" } },
    envOf(),
  );
  assert.equal(stranger.resp.status, 200);
  assert.deepEqual(stranger.rec.calls, []);
  const unknown = await runPost(
    { message: { from: { id: 42 }, chat: { id: 42 }, text: "какая-то строка" } },
    envOf(),
  );
  assert.equal(unknown.resp.status, 200);
  assert.deepEqual(unknown.rec.calls, [
    {
      method: "sendMessage",
      params: {
        chat_id: 42,
        text: "Не понял, кнопки ниже.",
        reply_markup: {
          keyboard: [
            [{ text: "Сегодня" }, { text: "Завтра" }, { text: "Сейчас" }, { text: "Неделя" }],
            [{ text: "Звонки" }, { text: "Выбрать день" }],
          ],
          resize_keyboard: true,
        },
      },
    },
  ]);
  const foreignChat = await runPost(
    { message: { from: { id: 42 }, chat: { id: 999 }, text: "Сегодня" } },
    envOf(),
  );
  assert.equal(foreignChat.resp.status, 200);
  assert.deepEqual(foreignChat.rec.calls, []);
});

test("вебхук: кнопка владельца даёт один sendMessage с HTML и клавиатурой", async () => {
  const { resp, rec } = await runPost(
    { message: { from: { id: 42 }, chat: { id: 42 }, text: "Сегодня" } },
    envOf(),
  );
  assert.equal(resp.status, 200);
  assert.equal(rec.calls.length, 1);
  const params = rec.calls[0]!.params as Record<string, unknown>;
  assert.equal(rec.calls[0]!.method, "sendMessage");
  assert.equal(params.chat_id, 42);
  assert.equal(params.parse_mode, "HTML");
  assert.ok(String(params.text).startsWith("<b>"));
  assert.deepEqual(params.reply_markup, {
    keyboard: [
      [{ text: "Сегодня" }, { text: "Завтра" }, { text: "Сейчас" }, { text: "Неделя" }],
      [{ text: "Звонки" }, { text: "Выбрать день" }],
    ],
    resize_keyboard: true,
  });
});

/// KV-заглушка с записью вызовов.
class FakeKv {
  store = new Map<string, string>();
  puts: { key: string; value: string; ttl: number | undefined }[] = [];

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    this.puts.push({ key, value, ttl: opts?.expirationTtl });
    this.store.set(key, value);
  }
}

function kvEnv(kv: FakeKv): Env {
  return envOf({ DEDUP: kv as unknown as KVNamespace });
}

function nowAt(iso: string, minute: number): Now {
  return { date: Date.parseIso(iso)!, minute };
}

class ThrowingTg {
  calls = 0;
  async sendMessage(): Promise<unknown> {
    this.calls += 1;
    throw new Error("сеть легла");
  }
}

class RecordingTg {
  calls: { chatId: number; text: string; parseMode?: string }[] = [];
  async sendMessage(
    chatId: number,
    text: string,
    _replyMarkup?: unknown,
    parseMode?: string,
  ): Promise<unknown> {
    this.calls.push({ chatId, text, parseMode });
    return null;
  }
}

test("сводка: вне семестра — ничего ни в чат, ни в KV", async () => {
  const kv = new FakeKv();
  const tg = new RecordingTg();
  const before = await cronSummary(kvEnv(kv), nowAt("2026-08-31", 450), 42, tg);
  const after = await cronSummary(kvEnv(kv), nowAt("2027-01-01", 450), 42, tg);
  assert.equal(before, "outside");
  assert.equal(after, "outside");
  assert.equal(tg.calls.length, 0);
  assert.equal(kv.puts.length, 0);
});

test("сводка: день без пар не отправляется вовсе", async () => {
  const kv = new FakeKv();
  const tg = new RecordingTg();
  // суббота 14.11.2026 — над-неделя, пар нет
  assert.equal(await cronSummary(kvEnv(kv), nowAt("2026-11-14", 450), 42, tg), "empty");
  assert.equal(tg.calls.length, 0);
  assert.equal(kv.puts.length, 0);
});

test("сводка: окно — до 07:28 и после 09:00 не отправляется", async () => {
  const kv = new FakeKv();
  const tg = new RecordingTg();
  assert.equal(await cronSummary(kvEnv(kv), nowAt("2026-11-13", 447), 42, tg), "window");
  assert.equal(await cronSummary(kvEnv(kv), nowAt("2026-11-13", 900), 42, tg), "window");
  assert.equal(tg.calls.length, 0);
});

test("сводка: границы окна и семестра включительны", async () => {
  // 07:28 — первый годный момент, 08:59 — последний; 07:27 и 09:00 уже нет
  const t1 = new RecordingTg();
  assert.equal(await cronSummary(kvEnv(new FakeKv()), nowAt("2026-11-13", 448), 42, t1), "sent");
  const t2 = new RecordingTg();
  assert.equal(await cronSummary(kvEnv(new FakeKv()), nowAt("2026-11-13", 539), 42, t2), "sent");
  const t3 = new RecordingTg();
  assert.equal(await cronSummary(kvEnv(new FakeKv()), nowAt("2026-11-13", 540), 42, t3), "window");
  const t4 = new RecordingTg();
  assert.equal(await cronSummary(kvEnv(new FakeKv()), nowAt("2026-11-13", 447), 42, t4), "window");
  // края семестра: 01.09 и 31.12 — внутри, 31.08 и 01.01 — снаружи
  const t5 = new RecordingTg();
  assert.equal(await cronSummary(kvEnv(new FakeKv()), nowAt("2026-09-01", 450), 42, t5), "sent");
  const t6 = new RecordingTg();
  assert.equal(await cronSummary(kvEnv(new FakeKv()), nowAt("2026-12-31", 450), 42, t6), "sent");
  const t7 = new RecordingTg();
  assert.equal(await cronSummary(kvEnv(new FakeKv()), nowAt("2026-08-31", 450), 42, t7), "outside");
  const t8 = new RecordingTg();
  assert.equal(await cronSummary(kvEnv(new FakeKv()), nowAt("2027-01-01", 450), 42, t8), "outside");
});

test("сводка: первый запуск в окне отправляет и ставит отметку в KV", async () => {
  const kv = new FakeKv();
  const tg = new RecordingTg();
  const result = await cronSummary(kvEnv(kv), nowAt("2026-11-13", 450), 42, tg);
  assert.equal(result, "sent");
  assert.equal(tg.calls.length, 1);
  assert.equal(tg.calls[0]!.chatId, 42);
  assert.equal(tg.calls[0]!.parseMode, "HTML");
  assert.ok(tg.calls[0]!.text.includes("Доброе утро"));
  assert.deepEqual(kv.puts, [{ key: "morning:2026-11-13", value: "1", ttl: 172800 }]);
});

test("сводка: отметка в KV гасит повтор", async () => {
  const kv = new FakeKv();
  const env = kvEnv(kv);
  const tg = new RecordingTg();
  await cronSummary(env, nowAt("2026-11-13", 450), 42, tg);
  const second = await cronSummary(env, nowAt("2026-11-13", 539), 42, tg);
  assert.equal(second, "seen");
  assert.equal(tg.calls.length, 1);
});

test("сводка: сбой отправки не ставит отметку — повтор на следующем запуске", async () => {
  const kv = new FakeKv();
  const tg = new ThrowingTg();
  const result = await cronSummary(kvEnv(kv), nowAt("2026-11-13", 450), 42, tg);
  assert.equal(result, "error");
  assert.equal(kv.puts.length, 0);
  assert.equal(tg.calls, 1);
});

test("обёртка fetch: сбой обработки всё равно отвечает 200 «ok» — без ретраев Telegram", async () => {
  // тело-поток падает посреди чтения: исключение ловит обёртка, не обработчик
  const stream = new ReadableStream({
    start(controller) {
      controller.error(new Error("канал умер"));
    },
  });
  // duplex — требование undici для тела-потока; в типах Workers этого поля нет
  const init = {
    method: "POST",
    body: stream,
    duplex: "half",
    headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET },
  } as unknown as RequestInit;
  const broken = new Request("https://worker.example/webhook", init);
  const resp = await worker.fetch(broken, envOf());
  assert.equal(resp.status, 200);
  assert.equal(await resp.text(), "ok");
});

test("обёртка scheduled: кривой MY_TELEGRAM_ID — тихий выход, сети не было", async () => {
  await worker.scheduled(
    {} as ScheduledController,
    envOf({ MY_TELEGRAM_ID: "abc" }),
    {} as ExecutionContext,
  );
});
