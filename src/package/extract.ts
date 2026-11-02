import { type Fs, joinPath } from "../platform/fs";
import { MANIFEST_PATH } from "./manifest";

const NOT_A_PACKAGE = "This file isn't a Retrans package or project.";

/**
 * Same rules as the Rust `clean_entry_path`, plus: interior "." segments are dropped and names
 * holding NUL are rejected. Returns null for anything that could escape the destination.
 */
export function safeEntryPath(raw: string): string | null {
  if (raw.includes("\0")) return null;
  const p = raw.replace(/\\/g, "/");
  if (p === "" || p.startsWith("/") || p.endsWith("/")) return null;
  if (/^[A-Za-z]:/.test(p)) return null;
  const segs: string[] = [];
  for (const [i, seg] of p.split("/").entries()) {
    if (seg === "" || seg === "..") return null;
    if (i === 0 && seg === "__MACOSX") return null;
    if (seg === ".") continue;
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

export async function extractPackage(
  fs: Fs,
  entries: Array<{ path: string; text: string }>,
  dest: string,
): Promise<void> {
  const safe: Array<{ path: string; text: string }> = [];
  for (const e of entries) {
    const path = safeEntryPath(e.path);
    if (path) safe.push({ path, text: e.text });
  }
  if (!safe.some((e) => e.path === MANIFEST_PATH || isLocaleFile(e.path))) throw new Error(NOT_A_PACKAGE);

  if (await fs.exists(dest)) {
    if ((await fs.listFiles(dest, 1)).length > 0) throw new Error("Choose an empty folder.");
  }
  for (const e of safe) {
    const target = joinPath(dest, e.path);
    await fs.mkdirp(target.slice(0, target.lastIndexOf("/")));
    await fs.writeTextAtomic(target, e.text);
  }
}
