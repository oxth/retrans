import type { Format } from "../core/model";
import { type Fs, joinPath } from "../platform/fs";
import type { DetectResult } from "./adapter";
import { detectProject } from "./detect";

export interface NewProjectInput {
  format: Format;
  root: string;
  baseLocale: string;
  locales: string[];
  namespace?: string; // defaults to "common"
}

const MESSAGE_SCHEMA = "https://inlang.com/schema/inlang-message-format";
const PLUGIN_URL = "https://cdn.jsdelivr.net/npm/@inlang/plugin-message-format@4/dist/index.js";

function canonical(code: string): string {
  try {
    const out = Intl.getCanonicalLocales(code);
    if (out.length === 1 && code.trim() !== "") return code;
  } catch {
    /* fall through */
  }
  throw new Error(`Invalid locale code: "${code}"`);
}

function orderedLocales(baseLocale: string, locales: string[]): string[] {
  const out: string[] = [];
  for (const l of [baseLocale, ...locales]) {
    canonical(l);
    if (!out.includes(l)) out.push(l);
  }
  return out;
}

const list = (xs: string[], q: (s: string) => string) => `[${xs.map(q).join(", ")}]`;

async function writeNext(fs: Fs, root: string, base: string, locales: string[], ns: string): Promise<void> {
  for (const l of locales) await fs.writeTextAtomic(joinPath(root, "public/locales", l, `${ns}.json`), "{}\n");
  for (const ext of ["js", "mjs", "cjs", "ts"]) {
    if (await fs.exists(joinPath(root, `next-i18next.config.${ext}`))) return;
  }
  const text =
    "/** @type {import('next-i18next').UserConfig} */\n" +
    "module.exports = {\n  i18n: {\n" +
    `    defaultLocale: '${base}',\n` +
    `    locales: ${list(locales, (s) => `'${s}'`)},\n` +
    "  },\n}\n";
  await fs.writeTextAtomic(joinPath(root, "next-i18next.config.js"), text);
}

async function writeParaglide(fs: Fs, root: string, base: string, locales: string[]): Promise<void> {
  const settings =
    "{\n" +
    `  "$schema": "https://inlang.com/schema/project-settings",\n` +
    `  "baseLocale": ${JSON.stringify(base)},\n` +
    `  "locales": ${list(locales, (s) => JSON.stringify(s))},\n` +
    `  "modules": [${JSON.stringify(PLUGIN_URL)}],\n` +
    `  "plugin.inlang.messageFormat": {\n    "pathPattern": "./messages/{locale}.json"\n  }\n}\n`;
  await fs.writeTextAtomic(joinPath(root, "project.inlang/settings.json"), settings);
  for (const l of locales) {
    await fs.writeTextAtomic(
      joinPath(root, "messages", `${l}.json`),
      `{\n  "$schema": ${JSON.stringify(MESSAGE_SCHEMA)}\n}\n`,
    );
  }
}

export async function createProject(fs: Fs, input: NewProjectInput): Promise<DetectResult> {
  const { format, root, baseLocale } = input;
  const namespace = input.namespace ?? "common";
  if (namespace === "" || /[/\\]/.test(namespace)) throw new Error(`Invalid namespace: "${namespace}"`);
  const locales = orderedLocales(baseLocale, input.locales);

  let existing: DetectResult | null;
  try {
    existing = await detectProject(fs, root);
  } catch {
    existing = {} as DetectResult; // malformed project settings still count as an existing project
  }
  if (existing) throw new Error("This folder already contains a translation project");

  if (format === "paraglide") await writeParaglide(fs, root, baseLocale, locales);
  else await writeNext(fs, root, baseLocale, locales, namespace);

  const result = await detectProject(fs, root);
  if (!result) throw new Error("Project was created but could not be detected");
  return result;
}
