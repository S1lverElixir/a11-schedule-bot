//! Обработчики апдейтов — дословный порт rust/src/bot.rs.
//!
//! Владелец один: всё, что не от него, игнорируется молча — и в сообщениях,
//! и в нажатиях (кнопки существуют только в его личке). Проверки owner_id
//! не ослаблять. Сторожа fps.ms сюда не входят: на новой платформе продлевать
//! нечего, а сводка живёт в index.ts.

import { Date, Stamp, type Now } from "./date.ts";
import { icsForWeek } from "./ics.ts";
import * as log from "./log.ts";
import {
  BTN_BELLS,
  BTN_NOW,
  BTN_PICK,
  BTN_TODAY,
  BTN_TOMORROW,
  BTN_WEEK,
  GREETING,
  PICK_PROMPT,
  bellsText,
  calendarKb,
  dayText,
  mainKb,
  nowText,
  renderWeek,
  weekKb,
  weekText,
} from "./render.ts";
import { weekLabel } from "./schedule.ts";
import { sendMessageParams, type Api } from "./telegram.ts";

const BUTTONS: readonly string[] = [
  BTN_TODAY,
  BTN_TOMORROW,
  BTN_NOW,
  BTN_WEEK,
  BTN_BELLS,
  BTN_PICK,
];

const encoder = new TextEncoder();

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function badData(data: string): void {
  log.warn(`bad callback data: ${JSON.stringify(data)}`);
}

export class Bot {
  readonly api: Api;
  readonly ownerId: number;

  constructor(api: Api, ownerId: number) {
    this.api = api;
    this.ownerId = ownerId;
  }

  /// now передаётся снаружи: обработчики становятся проверяемыми без часов и сети.
  async handleUpdate(update: unknown, now: Now): Promise<void> {
    const u = (update ?? {}) as Record<string, unknown>;
    if (u.message !== undefined && u.message !== null) {
      await this.onMessage(u.message as Record<string, unknown>, now);
    } else if (u.callback_query !== undefined && u.callback_query !== null) {
      await this.onCallback(u.callback_query as Record<string, unknown>, now);
    }
  }

  /// Отправка с логированием ошибки: сетевой сбой не должен ронять обработку.
  ///
  /// Telegram Desktop прячет клавиатуру кнопок, если последнее сообщение бота
  /// пришло без reply_markup — телефон её оставляет. Поэтому main_kb() едет почти
  /// с каждым ответом; не влезает она только туда, где уже лежит inline-клавиатура
  /// («Неделя» и «Выбрать день»).
  private async send(
    chatId: number,
    text: string,
    markup: unknown,
    mode: string | undefined,
  ): Promise<void> {
    const params = sendMessageParams(chatId, text, markup, mode);
    try {
      await this.api.call("sendMessage", params);
    } catch (e) {
      log.error(`sendMessage: ${errText(e)}`);
    }
  }

  private async onMessage(
    msg: Record<string, unknown>,
    now: Now,
  ): Promise<void> {
    const from = msg.from as { id?: unknown } | undefined;
    if (from?.id !== this.ownerId) {
      return; // чужим — молчание
    }
    const text = msg.text;
    if (typeof text !== "string") {
      return;
    }
    const chat = msg.chat as { id?: unknown } | undefined;
    const chatId = chat?.id;
    if (typeof chatId !== "number") {
      log.warn("сообщение без chat_id");
      return;
    }
    if (text === "/start") {
      await this.send(chatId, GREETING, mainKb(), undefined);
      return;
    }
    if (!BUTTONS.includes(text)) {
      return; // незнакомые тексты игнорируются молча
    }
    const today = now.date;
    switch (text) {
      case BTN_TODAY:
        await this.send(chatId, dayText(today, " · сегодня", now), mainKb(), "HTML");
        break;
      case BTN_TOMORROW:
        await this.send(
          chatId,
          dayText(today.addDays(1), " · завтра", now),
          mainKb(),
          "HTML",
        );
        break;
      case BTN_NOW:
        await this.send(chatId, nowText(now), mainKb(), "HTML");
        break;
      case BTN_WEEK: {
        const monday = today.addDays(-today.weekday());
        await this.send(
          chatId,
          weekText(today, now),
          weekKb(monday).toValue(),
          "HTML",
        );
        break;
      }
      case BTN_BELLS:
        await this.send(chatId, bellsText(), mainKb(), "HTML");
        break;
      default:
        await this.send(
          chatId,
          PICK_PROMPT,
          calendarKb(today.year(), today.month(), now).toValue(),
          "HTML",
        );
    }
  }

  private async onCallback(
    cb: Record<string, unknown>,
    now: Now,
  ): Promise<void> {
    const from = cb.from as { id?: unknown } | undefined;
    if (from?.id !== this.ownerId) {
      return;
    }
    const cbId = cb.id;
    if (typeof cbId !== "string") {
      log.warn("callback без id");
      return;
    }
    try {
      await this.api.call("answerCallbackQuery", { callback_query_id: cbId });
    } catch (e) {
      log.error(`answerCallbackQuery: ${errText(e)}`);
    }
    const data = cb.data;
    if (typeof data !== "string") {
      log.warn("пустые callback data");
      return;
    }
    const parts = data.split(":");
    if (parts.length < 2 || parts[1] === "x") {
      return;
    }
    // Telegram не присылает message у очень старых сообщений — чат владельца
    // в личке совпадает с его id
    const msg = cb.message as
      | { chat?: { id?: unknown }; message_id?: unknown }
      | undefined;
    const chatId =
      typeof msg?.chat?.id === "number" ? msg.chat.id : this.ownerId;
    switch (parts[0]) {
      case "cal": {
        const ym = Date.parseMonth(parts[1] ?? "");
        if (ym === null) return badData(data);
        const [y, m] = ym;
        if (parts.length === 3) {
          const dayRaw = parts[2] ?? "";
          if (!/^\d+$/.test(dayRaw)) return badData(data);
          const day = Number(dayRaw);
          const d = Date.new(y, m, day);
          if (d === null) return badData(data);
          await this.send(chatId, dayText(d, "", now), mainKb(), "HTML");
        } else {
          const messageId = msg?.message_id;
          if (typeof messageId !== "number") return badData(data);
          const markup = calendarKb(y, m, now).toValue();
          try {
            await this.api.call("editMessageReplyMarkup", {
              chat_id: chatId,
              message_id: messageId,
              reply_markup: markup,
            });
          } catch (e) {
            log.error(`editMessageReplyMarkup: ${errText(e)}`);
          }
        }
        break;
      }
      case "wk": {
        const monday = Date.parseIso(parts[1] ?? "");
        if (monday === null) return badData(data);
        await this.send(
          chatId,
          renderWeek(monday, now),
          weekKb(monday).toValue(),
          "HTML",
        );
        break;
      }
      case "ics": {
        const monday = Date.parseIso(parts[1] ?? "");
        if (monday === null) return badData(data);
        const sunday = monday.addDays(6);
        const name = `raspisanie_${monday.fmtDm()}-${sunday.fmtDm()}.ics`;
        const caption = `<b>Неделя ${monday.fmtDm()}–${sunday.fmtDm()} · ${weekLabel(monday)} чертой</b>`;
        // DTSTAMP из тех же условных часов, что и тексты: иначе снимки не сойдутся
        const stamp = Stamp.fromLocal(now.date, now.minute * 60);
        const file = icsForWeek(monday, stamp);
        try {
          await this.api.sendDocument(chatId, name, encoder.encode(file), caption);
        } catch (e) {
          log.error(`sendDocument: ${errText(e)}`);
        }
        break;
      }
      default:
        badData(data);
    }
  }
}
