import { hashValue } from "../core/hash";
import { type KeyId, type MessageValue, valuesEqual } from "../core/model";
import { ProjectSession } from "../core/session";
import type { StateEntry } from "../core/state-file";
import { detectProject } from "../formats/detect";
import { type Fs, FsError, joinPath } from "../platform/fs";
import { MemoryFs } from "../platform/memory-fs";
import { safeEntryPath } from "./extract";
import { type CellSnapshot, MANIFEST_PATH, type PackageManifest, parseManifest } from "./manifest";

export interface ImportItem {
  id: KeyId;
  locale: string;
  kind: "new" | "changed" | "status" | "conflict";
  mine?: MessageValue;
  theirs?: MessageValue;
  theirsEntry?: StateEntry;
}

export interface ImportDiff {
  items: ImportItem[];
  skipped: Array<{ id: KeyId; locale: string; reason: "unknown-key" | "unknown-locale" | "base-locale" | "read-only-file" }>;
  otherProject: boolean;
  hasManifest: boolean;
}

const NO_FILES = "Couldn't find translation files here.";
const INCOMING_ROOT = "/incoming";

/** Incoming sessions whose base language was only a guess (see openIncomingFolder). */
const fallbackBase = new WeakSet<ProjectSession>();

async function readOrNull(fs: Fs, path: string): Promise<string | null> {
  try {
    return await fs.readText(path);
  } catch (err) {
    if (err instanceof FsError && err.code === "NotFound") return null;
    throw err;
  }
}

/**
 * Open a project (package or plain folder) read for import. Base language: the manifest's, else
 * detection's, else `currentBase` when the folder has it, else the first detected locale. Only a
 * base from the manifest or detection is trusted (`baseKnown`); a fallback base is never protected
 * by the diff, so a folder holding only target languages still merges.
 */
export async function openIncomingFolder(
  fs: Fs,
  root: string,
  currentBase?: string,
): Promise<{ session: ProjectSession; manifest: PackageManifest | null; baseKnown: boolean }> {
  const d = await detectProject(fs, root);
  if (!d || d.locales.length === 0) throw new Error(NO_FILES);
  const manifest = parseManifest(await readOrNull(fs, joinPath(root, MANIFEST_PATH)));
  const known =
    (manifest && d.locales.includes(manifest.baseLocale) ? manifest.baseLocale : null) ?? d.baseLocale;
  const baseLocale =
    known ??
    (currentBase && d.locales.includes(currentBase) ? currentBase : null) ??
    d.locales[0];
  const session = await ProjectSession.open(fs, root, d, { baseLocale, localesPath: d.localesPath });
  if (!known) fallbackBase.add(session);
  return { session, manifest, baseKnown: !!known };
}

/** Load package entries into memory (unsafe paths dropped) and open them as a project. */
export async function openIncoming(
  entries: Array<{ path: string; text: string }>,
  currentBase?: string,
): Promise<{ session: ProjectSession; manifest: PackageManifest | null; baseKnown: boolean }> {
  const files: Record<string, string> = {};
  for (const e of entries) {
    const path = safeEntryPath(e.path);
    if (path) files[joinPath(INCOMING_ROOT, path)] = e.text;
  }
  return openIncomingFolder(new MemoryFs(files), INCOMING_ROOT, currentBase);
}

const EMPTY_HASH = hashValue(undefined);
const EMPTY_SNAP: CellSnapshot = { v: EMPTY_HASH };

/**
 * A cell's value hash, status and machine flag. A value with no status entry counts as
 * "translated": that is what it shows as, and Retrans adds such entries on its own (a base edit
 * pins untracked translations), which must not read as the translator's change.
 */
function sig(value: MessageValue | undefined, entry: StateEntry | undefined): string {
  const s = entry?.s ?? (value ? "translated" : "");
  return hashValue(value) + "|" + s + "|" + (entry?.m ? "m" : "");
}

function snapSig(snap: CellSnapshot): string {
  const s = snap.s ?? (snap.v !== EMPTY_HASH ? "translated" : "");
  return snap.v + "|" + s + "|" + (snap.m ? "m" : "");
}

/** Three-way, per-cell comparison of an incoming project against the current one. */
export function diffPackage(
  current: ProjectSession,
  incoming: ProjectSession,
  manifest: PackageManifest | null,
): ImportDiff {
  const out: ImportDiff = {
    items: [],
    skipped: [],
    otherProject: !!manifest && manifest.sourceProjectId !== current.state.project.id,
    hasManifest: !!manifest,
  };
  const curLocales = new Set(current.data.locales);
  const curKeys = new Set(current.data.keyOrder);
  // The current base is always protected; the incoming base too when it is known (manifest or
  // detection), in case the two sides disagree. A guessed incoming base is never protected, or a
  // folder holding only a target language would merge nothing.
  const bases = new Set([current.data.baseLocale]);
  if (!fallbackBase.has(incoming)) bases.add(incoming.data.baseLocale);
  // With a manifest only the package's languages count (plus the bases, so base edits are reported);
  // anything else the translator's copy carries is ignored.
  const inPackage = (l: string) => !manifest || bases.has(l) || manifest.locales.includes(l);
  const locales = incoming.data.locales.filter((l) => {
    if (!inPackage(l)) return false;
    if (curLocales.has(l)) return true;
    out.skipped.push({ id: "", locale: l, reason: "unknown-locale" });
    return false;
  });

  for (const id of incoming.data.keyOrder) {
    for (const locale of locales) {
      const theirs = incoming.value(id, locale);
      if (!curKeys.has(id)) {
        if (theirs) out.skipped.push({ id, locale, reason: "unknown-key" });
        continue;
      }
      const mine = current.value(id, locale);
      if (bases.has(locale)) {
        if (!valuesEqual(mine, theirs)) out.skipped.push({ id, locale, reason: "base-locale" });
        continue;
      }
      const item = manifest ? withManifest(current, incoming, manifest, id, locale) : valuesOnly(id, locale, mine, theirs);
      if (!item) continue;
      // A file that failed to parse is read-only: applying would throw halfway through.
      if (!current.isWritable(id, locale)) out.skipped.push({ id, locale, reason: "read-only-file" });
      else out.items.push(item);
    }
  }
  return out;
}

function withManifest(
  current: ProjectSession,
  incoming: ProjectSession,
  manifest: PackageManifest,
  id: KeyId,
  locale: string,
): ImportItem | null {
  const mine = current.value(id, locale);
  const theirs = incoming.value(id, locale);
  const mineEntry = current.state.entries[id]?.[locale];
  const theirsEntry = incoming.state.entries[id]?.[locale];
  const base = snapSig(manifest.baseline[id]?.[locale] ?? EMPTY_SNAP);
  const mineChanged = sig(mine, mineEntry) !== base;
  const theirsChanged = sig(theirs, theirsEntry) !== base;
  if (!theirsChanged) return null;
  const item: ImportItem = { id, locale, kind: "changed", mine, theirs };
  if (theirsEntry) item.theirsEntry = { ...theirsEntry };
  if (valuesEqual(mine, theirs)) {
    const statusDiffers = sig(mine, mineEntry) !== sig(theirs, theirsEntry);
    return statusDiffers && !mineChanged ? { ...item, kind: "status" } : null;
  }
  if (!mineChanged) return { ...item, kind: mine ? "changed" : "new" };
  return { ...item, kind: "conflict" };
}

function valuesOnly(id: KeyId, locale: string, mine?: MessageValue, theirs?: MessageValue): ImportItem | null {
  if (!theirs || valuesEqual(mine, theirs)) return null;
  return { id, locale, kind: mine ? "conflict" : "new", mine, theirs };
}

/**
 * Apply the diff: "theirs" for every item except conflicts left unpicked (they keep mine) and
 * items picked "mine". Pick keys are `${id}|${locale}`. Returns the number of cells changed.
 * Base-language and other skipped cells are never touched. The session is left dirty for a save.
 */
export function applyImport(
  current: ProjectSession,
  diff: ImportDiff,
  picks: Map<string, "mine" | "theirs">,
): number {
  const keys = new Set(current.data.keyOrder);
  const locales = new Set(current.data.locales);
  // One change notification for the whole import: each one costs a full dirty-cell rescan.
  return current.batch(() => {
    let n = 0;
    for (const item of diff.items) {
      const pick = picks.get(`${item.id}|${item.locale}`) ?? (item.kind === "conflict" ? "mine" : "theirs");
      if (pick !== "theirs") continue;
      if (item.locale === current.data.baseLocale) continue;
      if (!keys.has(item.id) || !locales.has(item.locale)) continue;
      current.importCell(item.id, item.locale, item.theirs, item.theirsEntry);
      n++;
    }
    return n;
  });
}
