import { type Fs, joinPath } from "../platform/fs";
import { MANIFEST_PATH } from "./manifest";

const NOT_A_PACKAGE = "This file isn't a Retrans package or project.";

/** Windows device names, reserved with or without an extension ("CON", "nul.json"). */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * Same rules as the Rust `clean_entry_path`, plus: interior "." segments are dropped and names
 * holding NUL or ":" are rejected, as are `.git` segments and Windows device names. Returns null
 * for anything that could escape the destination or misbehave when written.
 */
export function safeEntryPath(raw: string): string | null {
  if (raw.includes("\0") || raw.includes(":")) return null;
  const p = raw.replace(/\\/g, "/");
  if (p === "" || p.startsWith("/") || p.endsWith("/")) return null;
  if (/^[A-Za-z]:/.test(p)) return null;
  const segs: string[] = [];
  for (const [i, seg] of p.split("/").entries()) {
    if (seg === "" || seg === "..") return null;
    if (i === 0 && seg === "__MACOSX") return null;
    if (seg === ".") continue;
    if (seg.toLowerCase() === ".git" || RESERVED.test(seg)) return null;
    segs.push(seg);
  }
  if (segs.length === 0 || segs[segs.length - 1] === ".DS_Store") return null;
  return segs.join("/");
}

function isLocaleFile(path: string): boolean {
  if (path === "project.inlang/settings.json") return true;
  if (path.startsWith(".retrans/") || !path.endsWith(".json")) return false;
  const dirs = path.split("/").slice(0, -1);
  return dirs.includes("locales") || dirs.includes("messages");
}

/** Only what a package needs is written: Retrans files, Paraglide settings, the config copy, JSON. */
function isPackageFile(path: string): boolean {
  if (path.startsWith(".retrans/") || path.startsWith("project.inlang/")) return true;
  if (/^next-i18next\.config\.(js|mjs|cjs|ts)$/.test(path)) return true;
  return path.endsWith(".json");
}

export async function extractPackage(
  fs: Fs,
  entries: Array<{ path: string; text: string }>,
  dest: string,
): Promise<void> {
  const safe: Array<{ path: string; text: string }> = [];
  for (const e of entries) {
    const path = safeEntryPath(e.path);
    if (path && isPackageFile(path)) safe.push({ path, text: e.text });
  }
  if (!safe.some((e) => e.path === MANIFEST_PATH || isLocaleFile(e.path))) throw new Error(NOT_A_PACKAGE);

  if (await destHasFiles(fs, dest)) throw new Error("Choose an empty folder.");
  for (const e of safe) {
    const target = joinPath(dest, e.path);
    await fs.mkdirp(target.slice(0, target.lastIndexOf("/")));
    await fs.writeTextAtomic(target, e.text);
  }
}

/** True when `dest` exists and holds any file at any depth (a saved package may hold only folders). */
export async function destHasFiles(fs: Fs, dest: string): Promise<boolean> {
  return (await fs.exists(dest)) && (await fs.listFiles(dest, 32)).length > 0;
}
