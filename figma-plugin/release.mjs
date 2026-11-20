// Prepares a Retrans Preview plugin release, separate from the app's: the plugin has its own
// version, taken from the newest section of figma-plugin/CHANGELOG.md.
//
//   node figma-plugin/release.mjs <out-dir>
//
// Checks the built files and writes <out-dir>/whats-new.txt (that section as plain text, for Figma's
// publish form). Reports `version`, `publishable` (whether the manifest has the id Figma assigned)
// and `id_problem` to $GITHUB_OUTPUT when run in GitHub Actions, else prints them. Exits non-zero
// only when something is broken: no released version in the changelog, or missing built files.
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
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

/** The newest released version in a changelog (the first `## [x.y.z]` heading), or null. */
export function latestVersion(changelog) {
  const m = changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m);
  return m ? m[1] : null;
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
  const [outDir] = process.argv.slice(2);
  if (!outDir) {
    console.error("usage: node figma-plugin/release.mjs <out-dir>");
    process.exit(2);
  }
  const pluginDir = dirname(fileURLToPath(import.meta.url));
  const manifest = JSON.parse(await readFile(join(pluginDir, "manifest.json"), "utf8"));
  const missing = builtFilesMissing(manifest, pluginDir);
  if (missing.length) fail(`Built plugin files are missing: ${missing.join(", ")}. Run pnpm build:figma-plugin first.`);

  const changelog = await readFile(join(pluginDir, "CHANGELOG.md"), "utf8");
  const version = latestVersion(changelog);
  if (!version) fail("figma-plugin/CHANGELOG.md has no released version yet.");
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "whats-new.txt"), whatsNew(changelog, version) + "\n");

  const problem = pluginIdProblem(manifest);
  const out = { version, publishable: problem ? "false" : "true", id_problem: problem ?? "" };
  const lines = Object.entries(out).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, lines);
  else process.stdout.write(lines);
}

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
