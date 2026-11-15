//! Общие заглушки тестов: записывающая Api вместо сети и структурное равенство.

import type { Api } from "../src/telegram.ts";

/// Записывающая заглушка вместо сети: собирает вызовы Bot API.
export class Recorder implements Api {
  calls: { method: string; params: unknown }[] = [];

  async call(method: string, params: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    return null;
  }

  async sendDocument(
    chatId: number,
    filename: string,
    content: Uint8Array,
    caption: string,
    replyMarkup?: unknown,
  ): Promise<unknown> {
    const params: Record<string, unknown> = {
      chat_id: chatId,
      filename,
      caption,
      content: new TextDecoder().decode(content),
    };
    if (replyMarkup !== undefined && replyMarkup !== null) {
      params.reply_markup = replyMarkup;
    }
    this.calls.push({ method: "sendDocument", params });
    return null;
  }
}

/// Структурное равенство значений снимков: строки — байт в байт.
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (a instanceof Object && b instanceof Object) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (!deepEqual(ka, kb)) return false;
    const oa = a as Record<string, unknown>;
    const ob = b as Record<string, unknown>;
    return ka.every((k) => deepEqual(oa[k], ob[k]));
  }
  return false;
}
