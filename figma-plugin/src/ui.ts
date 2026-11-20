// Spike: load a preview file and save a results file from the plugin window.
import { parseBundle } from "../../src/preview/format";

const app = document.getElementById("app")!;
app.innerHTML = `<input type="file" id="file" accept=".json"><p id="info" class="muted"></p>
<div class="bar"><button id="log">Log bound variables</button><button id="save">Save results</button></div>`;

document.getElementById("file")!.addEventListener("change", async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  const r = parseBundle(await f.text());
  document.getElementById("info")!.textContent = r.ok ? `${r.bundle.locale} · ${r.bundle.strings.length} strings` : r.error;
});
document.getElementById("log")!.addEventListener("click", () => parent.postMessage({ pluginMessage: { type: "make-copies" } }, "*"));
document.getElementById("save")!.addEventListener("click", () => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(['{"retransPreviewResults":1}\n'], { type: "application/json" }));
  a.download = "spike.retrans-results.json";
  a.click();
});
