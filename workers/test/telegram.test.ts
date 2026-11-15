//! Тесты транспорта: разбор ответов Bot API на подменённом fetch —
//! ok/description/не-JSON/сетевой сбой и сборка multipart для документа.

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { sendMessageParams, Telegram } from "../src/telegram.ts";

/// Подмена fetch: собирает вызовы и отдаёт заготовленный ответ.
function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  return mock.method(globalThis, "fetch", impl as typeof fetch);
}

test("sendMessageParams: пустые поля не попадают в параметры", () => {
  assert.deepEqual(sendMessageParams(1, "текст"), { chat_id: 1, text: "текст" });
  assert.deepEqual(sendMessageParams(1, "текст", undefined, undefined), {
    chat_id: 1,
    text: "текст",
  });
  assert.deepEqual(sendMessageParams(1, "текст", null as unknown), {
    chat_id: 1,
    text: "текст",
  });
  assert.deepEqual(sendMessageParams(1, "текст", undefined, null as unknown as string), {
    chat_id: 1,
    text: "текст",
  });
});

test("call: ok-ответ возвращает result", async () => {
  const fetchStub = stubFetch(async () =>
    new Response(JSON.stringify({ ok: true, result: { id: 7 } })),
  );
  try {
    const tg = new Telegram("1:тест");
    assert.deepEqual(await tg.call("getMe", {}), { id: 7 });
    assert.equal(fetchStub.mock.calls[0]!.arguments[0], "https://api.telegram.org/bot1:тест/getMe");
  } finally {
    fetchStub.mock.restore();
  }
});

test("call: ok без result — null", async () => {
  const fetchStub = stubFetch(async () => new Response(JSON.stringify({ ok: true })));
  try {
    const tg = new Telegram("1:тест");
    assert.equal(await tg.call("deleteWebhook", {}), null);
  } finally {
    fetchStub.mock.restore();
  }
});

test("call: ошибка Telegram с описанием уходит в текст исключения", async () => {
  const fetchStub = stubFetch(async () =>
    new Response(JSON.stringify({ ok: false, description: "chat not found" })),
  );
  try {
    const tg = new Telegram("1:тест");
    await assert.rejects(tg.call("sendMessage", {}), /sendMessage: chat not found/);
  } finally {
    fetchStub.mock.restore();
  }
});

test("call: не-JSON тело — «нет описания», код статуса не прячется за исключением сети", async () => {
  const fetchStub = stubFetch(async () => new Response("<html>502</html>", { status: 502 }));
  try {
    const tg = new Telegram("1:тест");
    await assert.rejects(tg.call("sendMessage", {}), /sendMessage: нет описания/);
  } finally {
    fetchStub.mock.restore();
  }
});

test("call: сетевой сбой помечается методом и словом «сеть»", async () => {
  const fetchStub = stubFetch(async () => {
    throw new Error("connect ECONNREFUSED");
  });
  try {
    const tg = new Telegram("1:тест");
    await assert.rejects(tg.call("sendMessage", {}), /sendMessage: сеть: connect ECONNREFUSED/);
  } finally {
    fetchStub.mock.restore();
  }
});

test("sendDocument: multipart несёт chat_id, подпись, разметку и файл", async () => {
  let captured: FormData | undefined;
  const fetchStub = stubFetch(async (_url, init) => {
    captured = init?.body as FormData;
    return new Response(JSON.stringify({ ok: true, result: { message_id: 5 } }));
  });
  try {
    const tg = new Telegram("1:тест");
    const kb = { keyboard: [[{ text: "Сегодня" }]], resize_keyboard: true };
    // sendDocument возвращает всё тело ответа, не только result
    const body = (await tg.sendDocument(
      42,
      "raspisanie_26.10-01.11.ics",
      new TextEncoder().encode("BEGIN:VCALENDAR"),
      "<b>Неделя</b>",
      kb,
    )) as { ok: boolean; result: { message_id: number } };
    assert.equal(body.ok, true);
    assert.equal(body.result.message_id, 5);
    assert.ok(captured);
    assert.equal(captured.get("chat_id"), "42");
    assert.equal(captured.get("caption"), "<b>Неделя</b>");
    assert.equal(captured.get("parse_mode"), "HTML");
    assert.equal(captured.get("reply_markup"), JSON.stringify(kb));
    const file = captured.get("document") as File;
    assert.equal(file.name, "raspisanie_26.10-01.11.ics");
    assert.equal(await file.text(), "BEGIN:VCALENDAR");
  } finally {
    fetchStub.mock.restore();
  }
});

test("sendDocument: без разметки поле reply_markup не уходит", async () => {
  let captured: FormData | undefined;
  const fetchStub = stubFetch(async (_url, init) => {
    captured = init?.body as FormData;
    return new Response(JSON.stringify({ ok: true, result: {} }));
  });
  try {
    const tg = new Telegram("1:тест");
    await tg.sendDocument(1, "x.ics", new Uint8Array(), "подпись");
    assert.ok(captured);
    assert.equal(captured.get("reply_markup"), null);
  } finally {
    fetchStub.mock.restore();
  }
});

test("sendDocument: ошибка Telegram уходит в исключение с описанием", async () => {
  const fetchStub = stubFetch(async () =>
    new Response(JSON.stringify({ ok: false, description: "file too big" })),
  );
  try {
    const tg = new Telegram("1:тест");
    await assert.rejects(
      tg.sendDocument(1, "x.ics", new Uint8Array(), "подпись"),
      /sendDocument: file too big/,
    );
  } finally {
    fetchStub.mock.restore();
  }
});

test("sendMessage собирает параметры через sendMessageParams", async () => {
  const fetchStub = stubFetch(async () =>
    new Response(JSON.stringify({ ok: true, result: {} })),
  );
  try {
    const tg = new Telegram("1:тест");
    await tg.sendMessage(1, "привет", { keyboard: [] }, "HTML");
    const init = fetchStub.mock.calls[0]!.arguments[1] as RequestInit;
    assert.deepEqual(JSON.parse(init.body as string), {
      chat_id: 1,
      text: "привет",
      reply_markup: { keyboard: [] },
      parse_mode: "HTML",
    });
  } finally {
    fetchStub.mock.restore();
  }
});

test("sendDocument: сетевой сбой помечается словом «сеть»", async () => {
  const fetchStub = stubFetch(async () => {
    throw new Error("TLS отвалился");
  });
  try {
    const tg = new Telegram("1:тест");
    await assert.rejects(
      tg.sendDocument(1, "x.ics", new Uint8Array(), "подпись"),
      /sendDocument: сеть: TLS отвалился/,
    );
  } finally {
    fetchStub.mock.restore();
  }
});

test("sendDocument: не-JSON тело — «нет описания»", async () => {
  const fetchStub = stubFetch(async () => new Response("<html>504</html>", { status: 504 }));
  try {
    const tg = new Telegram("1:тест");
    await assert.rejects(
      tg.sendDocument(1, "x.ics", new Uint8Array(), "подпись"),
      /sendDocument: нет описания/,
    );
  } finally {
    fetchStub.mock.restore();
  }
});
