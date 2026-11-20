// Prepares the Retrans Preview plugin for a release: checks the manifest and the built files, and
// writes the "What's new" text for Figma's publish form from this version's CHANGELOG.md section.
//
//   node figma-plugin/release.mjs <version> <out-dir>
//
// Exits non-zero (with a GitHub Actions ::error::) when the manifest still has the placeholder id,
// the built files are missing, or CHANGELOG.md has no section for the version.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Why the manifest's id can't be published to, or null when it is the numeric id Figma assigns. */
export function pluginIdProblem(manifest) {
  const id = manifest?.id;
  if (typeof id !== "string" || id === "") return 'The manifest has no "id".';
  if (!/^\d+$/.test(id)) {
    return `The manifest id "${id}" is a placeholder. Put the id Figma assigned in figma-plugin/manifest.json.`;
  }
  return null;
}

/** The manifest's main and ui files that don't exist under `dir`. */
export function builtFilesMissing(manifest, dir, exists = existsSync) {
  return [manifest.main, manifest.ui].filter((f) => typeof f === "string" && !exists(join(dir, f)));
}

/** This version's CHANGELOG.md section as plain text, or null when there is none. */
export function whatsNew(changelog, version) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start < 0) return null;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## [")) break;
    if (/^\[[^\]]+\]: /.test(line)) continue;
    body.push(line.replace(/^#+\s*/, "").replace(/\*\*(.+?)\*\*/g, "$1"));
  }
  const text = body.join("\n").trim();
  return text ? text : null;
}

async function main() {
  const [version, outDir] = process.argv.slice(2);
  if (!version || !outDir) {
    console.error("usage: node figma-plugin/release.mjs <version> <out-dir>");
    process.exit(2);
  }
  const pluginDir = dirname(fileURLToPath(import.meta.url));
  const manifest = JSON.parse(await readFile(join(pluginDir, "manifest.json"), "utf8"));
  const missing = builtFilesMissing(manifest, pluginDir);
  if (missing.length) fail(`Built plugin files are missing: ${missing.join(", ")}. Run pnpm build:figma-plugin first.`);

  const notes = whatsNew(await readFile(resolve(pluginDir, "../CHANGELOG.md"), "utf8"), version);
  if (!notes) fail(`CHANGELOG.md has no section for ${version}.`);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "whats-new.txt"), notes + "\n");
  console.log(`Wrote ${join(outDir, "whats-new.txt")}`);

  // Last, so the zip and notes are still produced for testers while the id is a placeholder.
  const problem = pluginIdProblem(manifest);
  if (problem) fail(problem);
}

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
