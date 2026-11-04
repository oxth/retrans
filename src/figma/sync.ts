/**
 * Sync from Figma (spec Part C): merges the Figma Variables files in the workspace's Figma folder
 * into the workspace, three-way per cell against the Figma baseline kept in the workspace meta.
 * Variables are identified by their Figma variable ID, so a rename in Figma keeps the row, its
 * code key, links and translations. Writes no files: everything lands in the session and is
 * written by the next save.
 */
import type { Conflict } from "../core/merge";
import { keyId, type KeyId, type MessageValue, parseKeyId, valuesEqual } from "../core/model";
import type { ProjectSession } from "../core/session";
import { type Fs, joinPath } from "../platform/fs";
import { jsonEqual, type FigmaSource, type FigmaVarLink } from "../workspace/meta";
import { figmaGroupName } from "./meta";
import { type ParsedTokens, parseTokens } from "./tokens";

/** A Figma conflict also carries the value both sides started from. */
export interface FigmaConflict extends Conflict {
  base?: MessageValue;
}

export interface FigmaSyncResult {
  /** False when the workspace has no Figma folder set, or it's missing; nothing changed. */
  available: boolean;
  conflicts: FigmaConflict[];
  added: KeyId[];
  updated: KeyId[];
  renamed: Array<{ from: KeyId; to: KeyId }>;
  /** Unmapped Figma rows newly marked "removed in source". */
  removed: KeyId[];
  /** Mode names in the folder with no language yet, sorted. Their files were skipped. */
  unmappedModes: string[];
  /** Files that couldn't be read, by root-relative path. */
  warnings: string[];
}

export interface FigmaFolder {
  files: Array<{ relPath: string; collection: string; text: string; parsed: ParsedTokens }>;
}

const SUFFIX = ".tokens.json";

const unavailable = (): FigmaSyncResult => ({
  available: false, conflicts: [], added: [], updated: [], renamed: [], removed: [], unmappedModes: [], warnings: [],
});

/** Every `*.tokens.json` in `dir` (the collection "") and one subfolder deep (collection = subfolder). */
export async function readFigmaFolder(fs: Fs, root: string, dir: string): Promise<FigmaFolder> {
  const abs = joinPath(root, dir);
  const files: FigmaFolder["files"] = [];
  for (const rel of await fs.listFiles(abs, 2)) {
    if (!rel.endsWith(SUFFIX)) continue;
    const parts = rel.split("/");
    const text = await fs.readText(joinPath(abs, rel));
    files.push({ relPath: joinPath(dir, rel), collection: parts.length > 1 ? parts[0] : "", text, parsed: parseTokens(text) });
  }
  return { files };
}

const asText = (s: string | undefined): MessageValue | undefined => (s === undefined ? undefined : { kind: "text", text: s });

export function syncFromFigma(session: ProjectSession): Promise<FigmaSyncResult> {
  // One sync at a time per session, so two runs never merge against the same baseline.
  const run = (queues.get(session) ?? Promise.resolve()).then(() => syncNow(session));
  queues.set(session, run.catch(() => undefined));
  return run;
}

const queues = new WeakMap<ProjectSession, Promise<unknown>>();

/** Per session: the Figma values read by the last sync (variableId -> locale -> value). */
const lastRead = new WeakMap<ProjectSession, Record<string, Record<string, string>>>();

async function syncNow(session: ProjectSession): Promise<FigmaSyncResult> {
  const figma = session.workspace?.figma;
  if (!figma) return unavailable();
  const { fs } = session;
  const root = session.data.root;
  if (!(await session.fs.exists(joinPath(root, figma.dir)))) return unavailable();
  const folder = await readFigmaFolder(fs, root, figma.dir);
  // Everything below is synchronous, so the workspace can't change underneath the merge.
  const meta = session.workspace;
  const f = meta?.figma;
  if (!meta || !f) return unavailable();

  const result: FigmaSyncResult = { ...unavailable(), available: true };
  const unreadable = new Set<string>(); // collections with a file that couldn't be read
  const unmapped = new Set<string>();
  /** variableId -> { collection, name, locale -> value } from the readable, mapped files. */
  const read = new Map<string, { collection: string; name: string; values: Record<string, string> }>();
  const order: string[] = [];
  for (const file of folder.files) {
    if (!file.parsed.ok || file.parsed.mode === null) {
      result.warnings.push(`Couldn't read ${file.relPath}; it was skipped.`);
      unreadable.add(file.collection);
      continue;
    }
    const locale = f.modes[file.parsed.mode];
    if (locale === undefined) {
      unmapped.add(file.parsed.mode);
      continue;
    }
    for (const v of file.parsed.vars) {
      if (v.type !== "string" || typeof v.value !== "string") continue;
      let entry = read.get(v.id);
      if (!entry) {
        entry = { collection: file.collection, name: v.name, values: {} };
        read.set(v.id, entry);
        order.push(v.id);
      }
      entry.values[locale] = v.value;
    }
  }
  result.unmappedModes = [...unmapped].sort();

  const vars: Record<string, FigmaVarLink> = { ...f.vars };
  const baseline: FigmaSource["baseline"] = structuredClone(f.baseline);
  const removedInSource = [...meta.removedInSource];
  const added = new Set<KeyId>();
  const updated = new Set<KeyId>();

  session.batch(() => {
    for (const id of order) {
      const v = read.get(id)!;
      const group = figmaGroupName(v.collection);
      let link = vars[id];
      if (!link || !session.data.keyOrder.includes(link.row)) {
        const row = keyId(group, v.name);
        if (!session.data.namespaces.includes(group)) session.addNamespace(group);
        if (!session.data.keyOrder.includes(row)) session.insertKey(row);
        link = { collection: v.collection, name: v.name, row };
        vars[id] = link;
        added.add(row);
      } else if (link.name !== v.name) {
        // Renamed in Figma: an unmapped row follows the new name; a row with a code key keeps it.
        let row = link.row;
        if (parseKeyId(row).ns === figmaGroupName(link.collection)) {
          row = session.renameKey(row, v.name);
          result.renamed.push({ from: link.row, to: row });
        }
        link = { ...link, name: v.name, row };
        vars[id] = link;
      }
      const ix = removedInSource.indexOf(link.row);
      if (ix >= 0) removedInSource.splice(ix, 1); // back in Figma

      const locales = new Set([...Object.keys(v.values), ...Object.keys(baseline[id] ?? {})]);
      for (const locale of locales) {
        const base = asText(baseline[id]?.[locale]);
        const theirs = asText(v.values[locale]);
        if (theirs === undefined) continue; // not in a readable mode file: leave it
        const settle = () => ((baseline[id] ??= {})[locale] = v.values[locale]);
        if (valuesEqual(base, theirs)) continue;
        const mine = session.value(link.row, locale);
        if (valuesEqual(mine, theirs)) {
          settle();
          continue;
        }
        if (valuesEqual(mine, base)) {
          if (!session.data.locales.includes(locale)) session.addLanguage(locale);
          session.importCell(link.row, locale, theirs, undefined);
          settle();
          if (!added.has(link.row)) updated.add(link.row);
          continue;
        }
        const c: FigmaConflict = { id: link.row, locale, theirs };
        if (mine) c.mine = mine;
        if (base) c.base = base;
        result.conflicts.push(c); // the baseline keeps the old value until resolved
      }
    }

    // Gone from Figma: only for collections whose files were all read.
    for (const [id, link] of Object.entries(vars)) {
      if (read.has(id) || unreadable.has(link.collection)) continue;
      if (!folder.files.some((x) => x.collection === link.collection)) continue;
      const unmappedRow = parseKeyId(link.row).ns === figmaGroupName(link.collection);
      if (unmappedRow && session.data.keyOrder.includes(link.row) && !removedInSource.includes(link.row)) {
        removedInSource.push(link.row);
        result.removed.push(link.row);
      }
    }

    const next: FigmaSource = { ...f, vars, baseline };
    const patch: { figma?: FigmaSource; removedInSource?: KeyId[] } = {};
    if (!jsonEqual(next, f)) patch.figma = next;
    if (!jsonEqual(removedInSource, meta.removedInSource)) patch.removedInSource = removedInSource;
    if (patch.figma || patch.removedInSource) session.setWorkspaceMeta(patch);
  });
  result.added = [...added];
  result.updated = [...updated];
  const values: Record<string, Record<string, string>> = {};
  for (const [id, v] of read) values[id] = v.values;
  lastRead.set(session, values);
  return result;
}

/**
 * Resolves a conflict reported by syncFromFigma: "theirs" takes the Figma value, "mine" keeps the
 * workspace value. Either way the cell's Figma baseline becomes the Figma value read, so the next
 * sync no longer reports it.
 */
export function resolveFigmaConflict(session: ProjectSession, c: Conflict, pick: "mine" | "theirs"): void {
  const f = session.workspace?.figma;
  if (!f) throw new Error("This workspace has no Figma source");
  const varId = Object.keys(f.vars).find((id) => f.vars[id].row === c.id);
  const figmaValue = varId ? lastRead.get(session)?.[varId]?.[c.locale] : undefined;
  session.batch(() => {
    if (pick === "theirs" && c.theirs) {
      if (!session.data.locales.includes(c.locale)) session.addLanguage(c.locale);
      session.importCell(c.id, c.locale, c.theirs, undefined);
    }
    if (varId && figmaValue !== undefined) {
      const baseline = structuredClone(f.baseline);
      (baseline[varId] ??= {})[c.locale] = figmaValue;
      session.setWorkspaceMeta({ figma: { ...f, baseline } });
    }
    session.conflicts = session.conflicts.filter((x) => x.id !== c.id || x.locale !== c.locale);
  });
}
