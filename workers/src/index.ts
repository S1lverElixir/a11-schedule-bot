//! Входная точка воркера: вебхук Telegram и утренняя сводка по Cron Trigger.
//!
//! Логика ответов — в bot.ts и render.ts; здесь только платформенный слой:
//! проверка секрета вебхука, условные часы по UTC+3, KV-дедупликация сводки.
//! Long polling не переносится: Workers живёт от запроса до запроса, а Telegram
//! копит апдейты и отдаёт их первым же вызовом — сообщения не теряются.
//!
//! Секрет вебхука обязателен (fail-closed): без него воркер отклоняет всё.
//! Иначе злоумышленник, подделав from.id в POST-JSON, смог бы командовать
//! ботом от имени владельца — Telegram без секрета не стучится, а чужой стучится.

import { Bot } from "./bot.ts";
import { nowLocal, type Now } from "./date.ts";
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

/// Отсечь тело больше 1 МБ до разбора JSON: Workers кладёт тело в память целиком.
const MAX_BODY_BYTES = 1024 * 1024;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/// Идентификатор владельца — непустая строка цифр без знака и нуля; кривая — отказ.
export function parseOwnerId(raw: string | undefined): number | null {
  const s = (raw ?? "").trim();
  if (!/^[1-9][0-9]{0,14}$/.test(s)) return null;
  const v = Number(s);
  return Number.isSafeInteger(v) ? v : null;
}

/// Сверка секрета вебхука constant-time: SHA-256 обеих сторон, XOR по октетам —
/// длина и байты секрета не просачиваются через время ответа.
/// Fail-closed: секрет не задан или заголовка нет — отказ.
export async function secretOk(
  expected: string | undefined,
  got: string | null,
): Promise<boolean> {
  if (
    expected === undefined ||
    expected === "" ||
    got === null ||
    got === ""
  ) {
    return false;
  }
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
    crypto.subtle.digest("SHA-256", enc.encode(got)),
  ]);
  const va = new Uint8Array(a);
  const vb = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < va.length; i++) {
    diff |= va[i]! ^ vb[i]!;
  }
  return diff === 0;
}

function morningTargetMinutes(): number {
  const [h, m] = MORNING_LOCAL.split(":");
  return Number(h) * 60 + Number(m);
}

/// Минимальная форма отправителя сводки: достаточно sendMessage.
interface SummaryTg {
  sendMessage(
    chatId: number,
    text: string,
    replyMarkup?: unknown,
    parseMode?: string,
  ): Promise<unknown>;
}

/// Утренняя сводка: семестр, окно, дедупликация. Отметка в KV ставится только
/// после успешной отправки — сбой повторяется со следующим запуском в окне.
/// Результат — буквальный, чтобы тесты проверяли каждую ветку.
export async function cronSummary(
  env: Env,
  now: Now,
  ownerId: number,
  tg: SummaryTg,
): Promise<"sent" | "seen" | "outside" | "window" | "error"> {
  if (
    !(
      SEMESTER_START.days() <= now.date.days() &&
      now.date.days() <= SEMESTER_END.days()
    )
  ) {
    return "outside"; // вне семестра сводки нет, как у Rust-бота
  }
  const target = morningTargetMinutes();
  const secs = now.minute * 60;
  // окно полтора часа — наследие Rust-бота, расширено на две минуты назад:
  // крон может сработать чуть раньше графика, Rust-цикл ловил бы это на следующей минуте
  if (secs < (target - 2) * 60 || secs >= (target + 90) * 60) {
    log.warn(`крон пришёл вне окна сводки: ${now.minute} мин`);
    return "window";
  }
  const key = `morning:${now.date.fmtIso()}`;
  const seen = await env.DEDUP.get(key);
  if (seen !== null) {
    return "seen"; // сводка за этот день уже ушла
  }
  try {
    await tg.sendMessage(ownerId, morningText(now.date, now), mainKb(), "HTML");
  } catch (e) {
    log.error(`morning summary failed: ${errText(e)}`);
    return "error"; // отметки нет: сводка уйдёт со следующим запуском в окне
  }
  await env.DEDUP.put(key, "1", { expirationTtl: 172800 });
  log.info("morning summary sent");
  return "sent";
}

/// Минимальный облик бота для шва тестов: ровно то, что вызывает вебхук.
export interface WebhookBot {
  handleUpdate(update: unknown, now: Now): Promise<void>;
}

/// Чтение тела с жёстким лимитом: потоковый размер проверяется по ходу,
/// поэтому отсечка срабатывает и без content-length (chunked).
/// null — лимит превышен.
async function readBody(request: Request): Promise<Uint8Array | null> {
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) return null;
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/// Обработка запроса вебхука. makeBot — шов для тестов: заглушка вместо сети.
export async function handleWebhook(
  request: Request,
  env: Env,
  makeBot: (ownerId: number) => WebhookBot = (ownerId) =>
    new Bot(new Telegram(env.BOT_TOKEN), ownerId),
): Promise<Response> {
  if (request.method === "GET") {
    // живость воркера: ничего не рассылает, секретов не называет
    return new Response("a11-bot worker\n", { status: 200 });
  }
  if (request.method !== "POST") {
    return new Response("", { status: 405 });
  }
  if (!(await secretOk(env.WEBHOOK_SECRET, request.headers.get("X-Telegram-Bot-Api-Secret-Token")))) {
    return new Response("", { status: 401 });
  }
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    return new Response("", { status: 413 });
  }
  const body = await readBody(request);
  if (body === null) {
    return new Response("", { status: 413 });
  }
  let update: unknown;
  try {
    update = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return new Response("", { status: 400 });
  }
  const ownerId = parseOwnerId(env.MY_TELEGRAM_ID);
  if (ownerId === null) {
    log.error("MY_TELEGRAM_ID — не число");
    return new Response("", { status: 500 });
  }
  const bot = makeBot(ownerId);
  await bot.handleUpdate(update, nowLocal());
  return new Response("ok", { status: 200 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    log.setSecret(env.BOT_TOKEN ?? "");
    try {
      return await handleWebhook(request, env);
    } catch (e) {
      // непойманное исключение вернуло бы 500: Telegram начал бы ретраить
      // и дублировать обработку; сбой уже записан в лог
      log.error(`webhook: ${errText(e)}`);
      return new Response("ok", { status: 200 });
    }
  },

  async scheduled(
    _event: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    log.setSecret(env.BOT_TOKEN ?? "");
    try {
      const ownerId = parseOwnerId(env.MY_TELEGRAM_ID);
      if (ownerId === null) {
        log.error("MY_TELEGRAM_ID — не число, сводка не отправлена");
        return;
      }
      await cronSummary(env, nowLocal(), ownerId, new Telegram(env.BOT_TOKEN));
    } catch (e) {
      log.error(`cron: ${errText(e)}`);
    }
  },
};
