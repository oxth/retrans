import { type Fs, FsError, joinPath, normalizePath } from "../platform/fs";
import { hashText } from "./hash";
import type { KeyId, MessageValue } from "./model";
import type { StateFile } from "./state-file";
import type { WorkspaceMeta } from "../workspace/meta";

/** Unsaved edits of one project, written periodically so a crash loses nothing. */
export interface Journal {
  root: string;
  savedAt: string;
  locales: string[];
  namespaces: string[];
  /** [id, locale, mine, disk value when the journal was written]; null = absent/cleared. */
  cells: Array<[KeyId, string, MessageValue | null, MessageValue | null]>;
  /** Cells whose status entry differed from the last saved state when the journal was written. */
  stateCells: Array<[KeyId, string]>;
  state: StateFile;
  /**
   * Workspace only: meta fields changed since the last save (null = field removed), e.g. drafts
   * accepted or removed-in-source keys kept. The pending source baseline is never journaled: a
   * sync on open recomputes it.
   */
  workspaceMeta?: { [K in keyof WorkspaceMeta]?: WorkspaceMeta[K] | null };
}

export function journalPath(appDataDir: string, root: string): string {
  return joinPath(appDataDir, "recovery", `${hashText(normalizePath(root))}.json`);
}

export async function writeJournal(fs: Fs, path: string, j: Journal): Promise<void> {
  await fs.writeTextAtomic(path, JSON.stringify(j));
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

function isJournal(v: unknown): v is Journal {
  return (
    isObj(v) && typeof v.root === "string" && typeof v.savedAt === "string" &&
    isStrings(v.locales) && isStrings(v.namespaces) &&
    Array.isArray(v.cells) &&
    v.cells.every((c) => Array.isArray(c) && c.length === 4 && typeof c[0] === "string" && typeof c[1] === "string") &&
    Array.isArray(v.stateCells) &&
    v.stateCells.every((c) => Array.isArray(c) && c.length === 2 && typeof c[0] === "string" && typeof c[1] === "string") &&
    isObj(v.state) && isObj(v.state.entries) && isObj(v.state.project) &&
    (v.workspaceMeta === undefined || isObj(v.workspaceMeta))
  );
}

/** null when the journal is missing or not a valid journal. */
export async function readJournal(fs: Fs, path: string): Promise<Journal | null> {
  let text: string;
  try {
    text = await fs.readText(path);
  } catch (err) {
    if (err instanceof FsError && err.code === "NotFound") return null;
    throw err;
  }
  try {
    const v: unknown = JSON.parse(text);
    return isJournal(v) ? v : null;
  } catch {
    return null;
  }
}

export async function clearJournal(fs: Fs, path: string): Promise<void> {
  try {
    if (await fs.exists(path)) await fs.remove(path);
  } catch (err) {
    if (!(err instanceof FsError && err.code === "NotFound")) throw err;
  }
}
