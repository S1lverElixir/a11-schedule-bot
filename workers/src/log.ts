//! Логи с одной оговоркой: в строку никогда не попадает токен.
//!
//! Сеть при ошибке может напечатать URL, а в URL бота живёт токен; логи воркера
//! видны в панели Cloudflare, поэтому всё, что похоже на токен, заменяется звёздочками.

import { localStamp } from "./date.ts";

let secret = "";

/// Первый непустой токен выигрывает: запрос с пустым секретом (ещё не подвязан)
/// не должен раз и навсегда оставить скраббер выключенным.
export function setSecret(s: string): void {
  if (secret === "" && s !== "") secret = s;
}

export function info(msg: string): void {
  emit("INFO", msg);
}

export function warn(msg: string): void {
  emit("WARNING", msg);
}

export function error(msg: string): void {
  emit("ERROR", msg);
}

function emit(level: string, msg: string): void {
  const clean =
    secret !== "" && msg.includes(secret) ? msg.replaceAll(secret, "***") : msg;
  console.log(`${localStamp()} ${level} ${clean}`);
}
