/**
 * Export back to Figma (spec C5): one .tokens.json per mode, rewritten from the files in the
 * workspace's Figma folder so only `$value` of string variables changes. Only variables that came
 * from Figma are written; a project language with no mode becomes a new mode file.
 */
import type { ProjectSession } from "../core/session";
import { joinPath } from "../platform/fs";
import type { ExportPlan } from "../workspace/export";
import { readFigmaFolder } from "./sync";
import { newModeFile, rewriteTokens } from "./tokens";

const MAX_NAMES = 10;

export async function planFigmaExport(session: ProjectSession, dir: string): Promise<ExportPlan> {
  const plan: ExportPlan = { root: dir, files: [], snippets: [], leftOutLocales: [], warnings: [] };
  const f = session.workspace?.figma;
  if (!f) throw new Error("This workspace has no Figma files");
  const { baseLocale, locales } = session.data;
  const folder = await readFigmaFolder(session.fs, session.data.root, f.dir);
  const text = (row: string, locale: string) => {
    const v = session.value(row, locale);
    return v?.kind === "text" ? v.text : undefined;
  };
  const newModes: Record<string, string> = {};
  /** What new mode files hold (variableId -> locale -> text), so syncing them back changes nothing. */
  const written: Record<string, Record<string, string>> = {};

  for (const collection of [...new Set(folder.files.map((x) => x.collection))]) {
    const files = folder.files.filter((x) => x.collection === collection);
    const readable = files.flatMap((x) =>
      x.parsed.ok && x.parsed.mode !== null && f.modes[x.parsed.mode] !== undefined ? [{ ...x, locale: f.modes[x.parsed.mode] }] : [],
    );
    for (const x of files) {
      if (!x.parsed.ok || x.parsed.mode === null) plan.warnings.push(`Couldn't read ${x.relPath}; it was not exported.`);
    }
    const out = (name: string) => joinPath(dir, collection, name);
    const fileName = (relPath: string) => relPath.slice(relPath.lastIndexOf("/") + 1);

    for (const x of readable) {
      if (!x.parsed.ok) continue;
      const values = new Map<string, string>();
      for (const v of x.parsed.vars) {
        const link = f.vars[v.id];
        if (v.type !== "string" || !link) continue;
        const t = text(link.row, x.locale);
        if (t !== undefined) values.set(v.id, t); // untranslated: the file keeps its value
      }
      plan.files.push({ path: out(fileName(x.relPath)), text: rewriteTokens(x.text, values) });
    }

    // Project languages with no mode in this collection: a new mode file from the first one.
    const template = readable[0];
    if (!template?.parsed.ok) continue;
    const have = new Set(readable.map((x) => x.locale));
    // Files whose mode isn't mapped are Figma's own: never replaced by a generated one.
    const taken = new Set(files.flatMap((x) => [fileName(x.relPath).toUpperCase(), ...(x.parsed.ok && x.parsed.mode ? [x.parsed.mode.toUpperCase()] : [])]));
    for (const locale of locales) {
      if (have.has(locale)) continue;
      const mode = locale.toUpperCase();
      if (taken.has(mode) || taken.has(`${mode}.TOKENS.JSON`)) {
        plan.warnings.push(`Mode ${mode} isn't mapped to a language; ${mode}.tokens.json was left as it is. Map it in Settings → Figma.`);
        continue;
      }
      const values = new Map<string, string>();
      const fallback: string[] = [];
      for (const v of template.parsed.vars) {
        const link = f.vars[v.id];
        if (v.type !== "string" || !link) continue;
        const t = text(link.row, locale);
        const base = text(link.row, baseLocale);
        const value = t ?? base;
        if (value === undefined) continue;
        values.set(v.id, value);
        (written[v.id] ??= {})[locale] = value;
        if (t === undefined) fallback.push(v.name);
      }
      plan.files.push({ path: out(`${mode}.tokens.json`), text: newModeFile(template.text, mode, values) });
      newModes[mode] = locale;
      if (fallback.length) {
        const names = fallback.slice(0, MAX_NAMES).join(", ") + (fallback.length > MAX_NAMES ? ", …" : "");
        plan.warnings.push(`New mode ${mode}: ${fallback.length} strings use the ${baseLocale} text: ${names}`);
      }
    }
  }
  if (Object.keys(newModes).length) {
    plan.figmaModes = newModes;
    plan.figmaBaseline = written;
  }
  return plan;
}

/** `extra` cells added to a Figma baseline (variableId -> locale -> value); `extra` wins. */
export function mergeBaseline(
  base: Record<string, Record<string, string>>,
  extra: Record<string, Record<string, string>>,
): Record<string, Record<string, string>> {
  const out = structuredClone(base);
  for (const [id, cells] of Object.entries(extra)) out[id] = { ...out[id], ...cells };
  return out;
}
