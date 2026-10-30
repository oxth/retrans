/**
 * Generates a large next-i18next project (5,000 keys x 10 languages) for manual perf checks.
 * Usage: pnpm tsx src/test/gen-large-fixture.ts <output-dir>   (or: node src/test/gen-large-fixture.ts <dir>)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = process.argv[2];
if (!out) {
  console.error("usage: gen-large-fixture <output-dir>");
  process.exit(1);
}
const LOCALES = ["en", "th", "ja", "de", "fr", "es", "it", "pt", "ko", "zh"];
const KEYS = 5000;
const NS = ["common", "checkout"];

for (const ns of NS) {
  for (const l of LOCALES) {
    const obj: Record<string, string> = {};
    for (let i = 0; i < KEYS / NS.length; i++) {
      // ~15% of non-base cells are left untranslated so Missing filters have work to do
      if (l !== "en" && (i * 7 + l.length * 3 + LOCALES.indexOf(l)) % 7 === 0) continue;
      obj[`section${i % 50}.key${i}`] = `${l} text ${i} {{name}}`;
    }
    const dir = join(out, "public", "locales", l);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${ns}.json`), JSON.stringify(obj, null, 2) + "\n");
  }
}
console.log(`Wrote ${KEYS} keys x ${LOCALES.length} languages to ${out}`);
