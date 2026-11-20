// Builds the Retrans Preview Figma plugin into figma-plugin/dist (code.js, and ui.html with its script inlined).
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const out = join(dir, "dist");
await mkdir(out, { recursive: true });

await build({ entryPoints: [join(dir, "src/code.ts")], bundle: true, outfile: join(out, "code.js"), target: "es2019", format: "iife" });

const ui = await build({ entryPoints: [join(dir, "src/ui.ts")], bundle: true, write: false, target: "es2019", format: "iife" });
const html = await readFile(join(dir, "src/ui.html"), "utf8");
const script = ui.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
await writeFile(join(out, "ui.html"), html.replace("<!-- SCRIPT -->", () => `<script>${script}</script>`));
console.log("Built figma-plugin/dist");
