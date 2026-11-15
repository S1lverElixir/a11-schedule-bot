//! Машинный дамп данных расписания: node workers/tools/dump_schedule.ts.
//!
//! Печатает компактный JSON одной строкой — тот же формат, что отдавал
//! `a11-bot --dump-schedule`; его читает tools/check_site.py для сверки с bteu.by.

import { dumpSchedule } from "../src/schedule.ts";
import { sortedStringify } from "./serialize.ts";

process.stdout.write(sortedStringify(dumpSchedule()) + "\n");
