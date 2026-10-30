export type FsErrorCode = "NotFound" | "Io";

export class FsError extends Error {
  code: FsErrorCode;
  constructor(code: FsErrorCode, message: string) {
    super(message);
    this.name = "FsError";
    this.code = code;
  }
}

export interface Fs {
  /** Throws FsError{code:"NotFound"} if missing. */
  readText(path: string): Promise<string>;
  /** Creates parent dirs. */
  writeTextAtomic(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Files only, relative, "/"-separated, sorted. */
  listFiles(root: string, maxDepth: number): Promise<string[]>;
  remove(path: string): Promise<void>;
  mkdirp(path: string): Promise<void>;
}

/** "\" -> "/", collapse "//", strip trailing "/". */
export function normalizePath(p: string): string {
  let out = p.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

export function joinPath(...parts: string[]): string {
  return normalizePath(parts.filter((p) => p !== "").join("/"));
}
