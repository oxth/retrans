/** Retrans Preview, plugin window: load a preview file, list the strings, record verdicts, save results. */
import { parseBundle, serializePreview } from "../../src/preview/format";
import { type PluginState, toResults } from "./logic";
import type { ToCode, ToUi } from "./protocol";

const app = document.getElementById("app")!;
let state: PluginState = { bundle: null, fileName: null, rows: [] };
let selected = 0;
let error: string | null = null;

const post = (msg: ToCode) => parent.postMessage({ pluginMessage: msg }, "*");
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const shortKey = (key: string) => key.slice(key.indexOf("::") + 2);

function rowHtml(r: PluginState["rows"][number]): string {
  const flag = r.flag === "overflow" ? `<span class="warn">⚠ may overflow</span>` : r.flag === "font-missing" ? `<span class="warn">⚠ font missing</span>` : "";
  return `<div class="row" data-key="${esc(r.key)}">
    <div><strong>${esc(shortKey(r.key))}</strong> ${flag}</div>
    <div class="text" data-focus title="Show in the preview copy">${esc(r.text)}</div>
    <div class="bar">
      <button data-verdict="fits" aria-pressed="${r.verdict === "fits"}">Fits</button>
      <button data-verdict="too-long" aria-pressed="${r.verdict === "too-long"}">Too long</button>
    </div>
    <input type="text" data-note placeholder="Note (optional)" value="${esc(r.note ?? "")}" aria-label="Note for ${esc(shortKey(r.key))}">
  </div>`;
}

function render(): void {
  const b = state.bundle;
  const found = state.rows.filter((r) => r.found);
  const flagged = found.filter((r) => r.flag);
  const missing = state.rows.length - found.length;
  const checked = state.rows.filter((r) => r.verdict).length;
  const rows = [...found].sort((a, c) => Number(!!c.flag) - Number(!!a.flag));
  app.innerHTML = `
    ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
    <div class="bar"><button id="load">${b ? "Load other…" : "Load preview file…"}</button>
      <input type="file" id="file" accept=".json" hidden></div>
    ${b ? `
      <p><strong>${esc(state.fileName ?? "")}</strong><br><span class="muted">${esc(b.locale)} · ${plural(b.strings.length, "string", "strings")}</span></p>
      <div class="bar"><button class="primary" id="make" ${selected ? "" : "disabled"}>Make preview copies</button>
        <span class="muted">${selected ? plural(selected, "frame", "frames") + " selected" : "Select frames to preview"}</span></div>
      ${found.length ? `<p>${flagged.length ? `<span class="warn">⚠ ${flagged.length} may overflow</span> · ` : ""}✓ ${found.length - flagged.length} look fine</p>` : ""}
      ${rows.map(rowHtml).join("")}
      ${missing && found.length ? `<p class="muted">${missing} not on these frames</p>` : ""}
      <div class="bar">
        <button class="primary" id="save" ${checked ? "" : "disabled"}>Save results</button>
        <button id="copy" ${checked ? "" : "disabled"}>Copy results</button>
        <button id="remove">Remove copies</button>
      </div>` : `<p class="muted">Export a preview file from Retrans (Settings → Figma → Designer preview), then load it here.</p>`}`;
}

function resultsText(): string {
  return serializePreview(toResults(state, new Date()));
}

function resultsName(): string {
  const base = (state.fileName ?? "preview").replace(/\.retrans-preview\.json$|\.json$/, "");
  return `${base}.retrans-results.json`;
}

app.addEventListener("click", async (e) => {
  const t = e.target as HTMLElement;
  const row = t.closest<HTMLElement>("[data-key]");
  if (t.id === "load") (document.getElementById("file") as HTMLInputElement).click();
  else if (t.id === "make") post({ type: "make-copies" });
  else if (t.id === "remove") post({ type: "remove-copies" });
  else if (t.id === "save") {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([resultsText()], { type: "application/json" }));
    a.download = resultsName();
    a.click();
  } else if (t.id === "copy") {
    const text = resultsText();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      document.body.append(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
  } else if (row && t.dataset.verdict) {
    const v = t.dataset.verdict as "fits" | "too-long";
    const current = state.rows.find((r) => r.key === row.dataset.key)?.verdict;
    post({ type: "verdict", key: row.dataset.key!, verdict: current === v ? null : v });
  } else if (row && t.hasAttribute("data-focus")) post({ type: "focus", key: row.dataset.key! });
});

app.addEventListener("change", async (e) => {
  const t = e.target as HTMLInputElement;
  if (t.id === "file") {
    const f = t.files?.[0];
    if (!f) return;
    const r = parseBundle(await f.text());
    error = r.ok ? null : r.error;
    if (r.ok) post({ type: "bundle", bundle: r.bundle, fileName: f.name });
    else render();
  } else if (t.hasAttribute("data-note")) {
    const key = t.closest<HTMLElement>("[data-key]")!.dataset.key!;
    const verdict = state.rows.find((r) => r.key === key)?.verdict ?? null;
    post({ type: "verdict", key, verdict, note: t.value });
  }
});

window.onmessage = (e: MessageEvent<{ pluginMessage: ToUi }>) => {
  const msg = e.data.pluginMessage;
  if (!msg) return;
  if (msg.type === "error") error = msg.message;
  else {
    state = msg.state;
    selected = msg.selectedFrames;
    error = null;
  }
  render();
};

render();
