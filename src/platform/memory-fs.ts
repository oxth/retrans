import { readdirSync, readFileSync, statSync } from "node:fs";
import { type Fs, FsError, joinPath, normalizePath } from "./fs";

export class MemoryFs implements Fs {
  private files = new Map<string, string>();
  writes: string[] = [];

  constructor(files: Record<string, string> = {}) {
    for (const [p, c] of Object.entries(files)) this.files.set(normalizePath(p), c);
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries(this.files);
  }

  async readText(path: string): Promise<string> {
    const v = this.files.get(normalizePath(path));
    if (v === undefined) throw new FsError("NotFound", `not found: ${path}`);
    return v;
  }

  async writeTextAtomic(path: string, content: string): Promise<void> {
    const p = normalizePath(path);
    this.files.set(p, content);
    this.writes.push(p);
  }

  async exists(path: string): Promise<boolean> {
    const p = normalizePath(path);
    if (this.files.has(p)) return true;
    const prefix = p === "/" ? "/" : p + "/";
    for (const k of this.files.keys()) if (k.startsWith(prefix)) return true;
    return false;
  }

  async listFiles(root: string, maxDepth: number): Promise<string[]> {
    const r = normalizePath(root);
    const prefix = r === "/" ? "/" : r + "/";
    const out: string[] = [];
    for (const k of this.files.keys()) {
      if (!k.startsWith(prefix)) continue;
      const rel = k.slice(prefix.length);
      if (rel.split("/").length <= maxDepth) out.push(rel);
    }
    if (!(await this.exists(r))) throw new FsError("NotFound", `not found: ${root}`);
    return out.sort();
  }

  async remove(path: string): Promise<void> {
    const p = normalizePath(path);
    this.files.delete(p);
    const prefix = p + "/";
    for (const k of [...this.files.keys()]) if (k.startsWith(prefix)) this.files.delete(k);
  }

  async mkdirp(): Promise<void> {
    // directories are implicit in MemoryFs
  }
}

/** Test-only: loads a real directory into a MemoryFs, mounted at `mountAt`. */
export function loadFixtureDir(absDir: string, mountAt = "/project"): MemoryFs {
  const files: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir)) {
      const abs = joinPath(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(abs).isDirectory()) walk(abs, r);
      else files[joinPath(mountAt, r)] = readFileSync(abs, "utf8");
    }
  };
  walk(absDir, "");
  return new MemoryFs(files);
}
