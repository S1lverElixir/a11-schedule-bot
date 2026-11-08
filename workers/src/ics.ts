//! .ics недели по RFC 5545 — дословный порт rust/src/ics.rs: событие на каждую пару,
//! время локальное плавающее, DTSTAMP — обязательный UTC. Мелочи (CRLF, фолдинг по
//! 75 октетов, экранирование) перенесены из bot.py дословно: однажды экспорт уже
//! молчал в проде, поэтому упрощать нельзя.

import { Date, Stamp } from "./date.ts";
import { dayPairs } from "./schedule.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/// Экранирование бэкслэша, точки с запятой, запятой и перевода строки.
function icsEscape(s: string): string {
  return s
    .replaceAll("\\", "\\\\")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,")
    .replaceAll("\n", "\\n");
}

/// Фолдинг §3.1: строки длиннее 75 октетов режутся, продолжение — с CRLF и пробелом;
/// многобайтовые символы UTF-8 не рвутся.
function icsFold(line: string): string {
  const data = encoder.encode(line);
  if (data.length <= 75) {
    return line;
  }
  const parts: Uint8Array[] = [];
  let rest = data;
  let limit = 75;
  while (rest.length > 0) {
    let cut = Math.min(limit, rest.length);
    while (cut < rest.length && rest[cut] >= 0x80 && rest[cut] <= 0xbf) {
      cut -= 1;
    }
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
    limit = 74; // продолжение начинается с пробела, на него отводится 1 октет
  }
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) {
      out += "\r\n ";
    }
    out += decoder.decode(parts[i]!);
  }
  return out;
}

/// .ics на неделю, начинающуюся с понедельника monday.
export function icsForWeek(monday: Date, stamp: Stamp): string {
  const out: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//a11-schedule-bot//RU",
    "CALSCALE:GREGORIAN",
  ];
  const dtstamp = stamp.fmtIcs();
  for (let i = 0; i < 7; i++) {
    const day = monday.addDays(i);
    for (const p of dayPairs(day)) {
      const t = (s: string) => `${s.replaceAll(":", "")}00`;
      out.push("BEGIN:VEVENT");
      out.push(`UID:${day.fmtCompact()}-${p.num}@a11-bot`);
      out.push(`DTSTAMP:${dtstamp}`);
      out.push(`DTSTART:${day.fmtCompact()}T${t(p.start)}`);
      out.push(`DTEND:${day.fmtCompact()}T${t(p.end)}`);
      out.push(`SUMMARY:${icsEscape(p.subj)}`);
      out.push(`LOCATION:${icsEscape(p.rooms ?? "")}`);
      let description = p.teachers.join(", ");
      if (p.sub) {
        if (description !== "") {
          description += " ";
        }
        description += "замена";
      }
      out.push(`DESCRIPTION:${icsEscape(description)}`);
      out.push("END:VEVENT");
    }
  }
  out.push("END:VCALENDAR");
  let text = "";
  for (const line of out) {
    text += icsFold(line);
    text += "\r\n";
  }
  return text;
}
