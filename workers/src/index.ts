//! Входная точка воркера: вебхук Telegram и утренняя сводка по Cron Trigger.
//!
//! Логика ответов — в bot.ts и render.ts; здесь только платформенный слой:
//! проверка секрета вебхука, условные часы по UTC+3, KV-дедупликация сводки.
//! Long polling не переносится: Workers живёт от запроса до запроса, а Telegram
//! копит апдейты и отдаёт их первым же вызовом — сообщения не теряются.

import { Bot } from "./bot.ts";
import { nowLocal } from "./date.ts";
import * as log from "./log.ts";
import { mainKb, morningText } from "./render.ts";
import { SEMESTER_END, SEMESTER_START } from "./schedule.ts";
import { Telegram } from "./telegram.ts";

export interface Env {
  BOT_TOKEN: string;
  MY_TELEGRAM_ID: string;
  /// Секрет, который Telegram передаёт в заголовке каждого вызова вебхука.
  WEBHOOK_SECRET?: string;
  /// KV-пространство: отметка «сводка за сегодня уже ушла» (то, что у Rust-бота
  /// жило в памяти и терялось при рестарте).
  DEDUP: KVNamespace;
}

/// Время сводки по UTC+3; крон в wrangler.jsonc стоит на 04:30 UTC.
const MORNING_LOCAL = "07:30";

function morningTargetMinutes(): number {
  const [h, m] = MORNING_LOCAL.split(":");
  return Number(h) * 60 + Number(m);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    log.setSecret(env.BOT_TOKEN ?? "");
    if (request.method === "GET") {
      // живость воркера: ничего не рассылает, секретов не называет
      return new Response("a11-bot worker\n", { status: 200 });
    }
    if (request.method !== "POST") {
      return new Response("", { status: 405 });
    }
    if (
      env.WEBHOOK_SECRET !== undefined &&
      request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET
    ) {
      return new Response("", { status: 401 });
    }
    let update: unknown;
    try {
      update = await request.json();
    } catch {
      return new Response("", { status: 400 });
    }
    const ownerId = Number(env.MY_TELEGRAM_ID.trim());
    if (!Number.isSafeInteger(ownerId)) {
      log.error("MY_TELEGRAM_ID — не число");
      return new Response("", { status: 500 });
    }
    const bot = new Bot(new Telegram(env.BOT_TOKEN), ownerId);
    await bot.handleUpdate(update, nowLocal());
    return new Response("ok", { status: 200 });
  },

  async scheduled(
    _event: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    log.setSecret(env.BOT_TOKEN ?? "");
    const ownerId = Number(env.MY_TELEGRAM_ID.trim());
    if (!Number.isSafeInteger(ownerId)) {
      log.error("MY_TELEGRAM_ID — не число, сводка не отправлена");
      return;
    }
    const now = nowLocal();
    if (
      !(
        SEMESTER_START.days() <= now.date.days() &&
        now.date.days() <= SEMESTER_END.days()
      )
    ) {
      return; // вне семестра сводки нет, как у Rust-бота
    }
    const target = morningTargetMinutes();
    const secs = now.minute * 60;
    // окно полтора часа — наследие Rust-бота, расширено на две минуты назад:
    // крон может сработать чуть раньше графика, Rust-цикл ловил бы это на следующей минуте
    if (secs < (target - 2) * 60 || secs >= (target + 90) * 60) {
      log.warn(`крон пришёл вне окна сводки: ${now.minute} мин`);
      return;
    }
    const key = `morning:${now.date.fmtIso()}`;
    const seen = await env.DEDUP.get(key);
    if (seen !== null) {
      return; // сводка за этот день уже ушла
    }
    const tg = new Telegram(env.BOT_TOKEN);
    try {
      await tg.sendMessage(ownerId, morningText(now.date, now), mainKb(), "HTML");
    } catch (e) {
      log.error(`morning summary failed: ${errText(e)}`);
      return; // отметки нет: сводка уйдёт со следующим запуском в окне
    }
    await env.DEDUP.put(key, "1", { expirationTtl: 172800 });
    log.info("morning summary sent");
  },
};
