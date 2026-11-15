//! Тонкий клиент Bot API поверх fetch.
//!
//! Через шов Api тесты подменяют сеть записывающей заглушкой и сверяют поведение
//! с эталоном handlers.json.

import { errText } from "./log.ts";

/// Что бот умеет у Telegram: ровно то, что нужно обработчикам.
export interface Api {
  call(method: string, params: unknown): Promise<unknown>;
  sendDocument(
    chatId: number,
    filename: string,
    content: Uint8Array,
    caption: string,
    replyMarkup?: unknown,
  ): Promise<unknown>;
}

/// Параметры sendMessage: пустые поля не отправляются вовсе.
export function sendMessageParams(
  chatId: number,
  text: string,
  replyMarkup?: unknown,
  parseMode?: string,
): Record<string, unknown> {
  const params: Record<string, unknown> = { chat_id: chatId, text };
  if (replyMarkup !== undefined && replyMarkup !== null) {
    params.reply_markup = replyMarkup;
  }
  if (parseMode !== undefined && parseMode !== null) {
    params.parse_mode = parseMode;
  }
  return params;
}

export class Telegram implements Api {
  private readonly base: string;

  constructor(token: string) {
    this.base = `https://api.telegram.org/bot${token}`;
  }

  /// Вызов метода Bot API; тело ответа разбирается даже при HTTP 4xx/5xx,
  /// потому что Telegram кладёт описание ошибки в JSON.
  async call(method: string, params: unknown): Promise<unknown> {
    let resp: Response;
    try {
      resp = await fetch(`${this.base}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params ?? {}),
        // висящий вызов держал бы вебхук открытым до платформенного лимита
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new Error(`${method}: сеть: ${errText(e)}`);
    }
    const body = await resp.json().catch(() => null);
    if (body !== null && typeof body === "object" && (body as { ok?: unknown }).ok === true) {
      return (body as { result?: unknown }).result ?? null;
    }
    const description = (body as { description?: unknown } | null)?.description;
    throw new Error(
      `${method}: ${typeof description === "string" ? description : "нет описания"}`,
    );
  }

  async sendMessage(
    chatId: number,
    text: string,
    replyMarkup?: unknown,
    parseMode?: string,
  ): Promise<unknown> {
    return this.call("sendMessage", sendMessageParams(chatId, text, replyMarkup, parseMode));
  }

  /// Отправка .ics как документа с подписью и HTML-разметкой подписи.
  async sendDocument(
    chatId: number,
    filename: string,
    content: Uint8Array,
    caption: string,
    replyMarkup?: unknown,
  ): Promise<unknown> {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("caption", caption);
    form.append("parse_mode", "HTML");
    if (replyMarkup !== undefined && replyMarkup !== null) {
      form.append("reply_markup", JSON.stringify(replyMarkup));
    }
    form.append(
      "document",
      new Blob([content as ArrayBufferView], { type: "text/calendar" }),
      filename,
    );
    let resp: Response;
    try {
      resp = await fetch(`${this.base}/sendDocument`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new Error(`sendDocument: сеть: ${errText(e)}`);
    }
    const body = await resp.json().catch(() => null);
    if (body !== null && typeof body === "object" && (body as { ok?: unknown }).ok === true) {
      return body;
    }
    const description = (body as { description?: unknown } | null)?.description;
    throw new Error(
      `sendDocument: ${typeof description === "string" ? description : "нет описания"}`,
    );
  }
}
