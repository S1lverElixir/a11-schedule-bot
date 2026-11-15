//! Пересъёмка эталона видов: node workers/tools/dump_views.ts [файл] [--generator ИМЯ].
//!
//! Строит ровно тот документ, который раньше писал `a11-bot --dump-views`: тот же
//! порядок случаев (snapshot.caseNames), те же значения, та же сериализация —
//! ключи алфавитно, отступ 2, перевод строки в конце файла. Гейт сверяет результат
//! с workers/test/fixtures/views.json байт-в-байт, так что тихий дрейф невозможен.

import { writeFileSync } from "node:fs";
import { snapshotDocument } from "../src/snapshot.ts";
import { sortedStringify } from "./serialize.ts";

const args = process.argv.slice(2);
let file: string | undefined;
let generator = "node workers/tools/dump_views.ts";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--generator") generator = args[++i] ?? generator;
  else if (!args[i]!.startsWith("--")) file = args[i];
}

const doc = snapshotDocument() as { cases: { name: string }[]; generator: string };
doc.generator = generator;
const text = sortedStringify(doc, 2) + "\n";

if (file) {
  writeFileSync(file, text);
  console.log(`эталон: ${file}, случаев: ${doc.cases.length}`);
} else {
  process.stdout.write(text);
}
