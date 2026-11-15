//! JSON-сериализация с алфавитной сортировкой ключей на любой глубине.
//!
//! Прежний генератор эталона (Rust/serde_json) держал ключи в BTreeMap —
//! алфавитно; JSON.stringify сохраняет порядок вставки. Фикстуры сверяются
//! байт-в-байт, поэтому порядок должен совпадать дословно.

function sortedValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortedValue);
  if (v !== null && typeof v === "object") {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = sortedValue(src[k]);
    return out;
  }
  return v;
}

/// indent как у JSON.stringify: 2 — pretty (эталон видов), undefined — компактный.
export function sortedStringify(v: unknown, indent?: number): string {
  return JSON.stringify(sortedValue(v), null, indent);
}
