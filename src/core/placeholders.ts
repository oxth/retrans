import type { Format } from "./model";

export function extractPlaceholders(format: Format, text: string): string[] {
  const out: string[] = [];
  if (format === "next-i18next") {
    for (const m of text.matchAll(/\$t\([^)]*\)/g)) out.push(m[0]);
    for (const m of text.matchAll(/\{\{\s*-?\s*([^,}\s]+)[^}]*\}\}/g)) out.push(m[1].trim());
  } else {
    for (const m of text.matchAll(/\{\s*([A-Za-z_][\w]*)\s*\}/g)) out.push(m[1]);
  }
  return out.sort();
}

function diff(a: string[], b: string[]): string[] {
  const counts = new Map<string, number>();
  for (const x of b) counts.set(x, (counts.get(x) ?? 0) + 1);
  const res: string[] = [];
  for (const x of a) {
    const n = counts.get(x) ?? 0;
    if (n > 0) counts.set(x, n - 1);
    else res.push(x);
  }
  return res;
}

export function comparePlaceholders(format: Format, base: string, target: string): { missing: string[]; extra: string[] } {
  const b = extractPlaceholders(format, base);
  const t = extractPlaceholders(format, target);
  return { missing: diff(b, t), extra: diff(t, b) };
}
