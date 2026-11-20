/** Retrans Preview, plugin window: load a preview file, list the strings, record verdicts, save results. */
import { parseBundle, serializePreview } from "../../src/preview/format";
import { type PluginState, toResults } from "./logic";
import { LinkError, findRetrans, liveApi, pair } from "./live";
import type { ToCode, ToUi } from "./protocol";

const app = document.getElementById("app")!;
let state: PluginState = { bundle: null, fileName: null, rows: [] };
let selected = 0;
let error: string | null = null;

// Live link to the Retrans app on this computer.
type Project = { id: string; name: string; baseLocale: string; locales: string[] };
let link: { base: string; paired: boolean } | null | "searching" = "searching";
let token: string | null = null;
let projects: Project[] = [];
let projectId = "";
let locale = "";
let includeReviewed = false;
let code = "";
let busy = false;
let sent = false;

const api = () => liveApi(fetch.bind(window), (link as { base: string }).base, token!);
const projectNow = () => projects.find((p) => p.id === projectId);
const targetLocales = () => (projectNow() ? projectNow()!.locales.filter((l) => l !== projectNow()!.baseLocale) : []);

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

function liveHtml(): string {
  if (link === "searching") return `<p class="muted">Looking for Retrans…</p>`;
  if (!link) return `<p class="muted">Open Retrans to connect, or use a file below.</p>`;
  if (!token) {
    return `<div class="live"><strong>Connect to Retrans</strong>
      <p class="muted">Enter the 6-digit code shown in Retrans (Settings → Figma).</p>
      <div class="bar"><input type="text" id="code" inputmode="numeric" maxlength="6" placeholder="123456" value="${esc(code)}" aria-label="6-digit code">
      <button class="primary" id="pair" ${busy ? "disabled" : ""}>Connect</button></div></div>`;
  }
  const p = projectNow();
  return `<div class="live"><p><span class="ok">●</span> Connected to Retrans</p>
    ${p ? `<div class="bar">
      <select id="project" aria-label="Project">${projects.map((x) => `<option value="${esc(x.id)}" ${x.id === projectId ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>
      <select id="locale" aria-label="Language">${targetLocales().map((l) => `<option value="${esc(l)}" ${l === locale ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></div>
      <label><input type="checkbox" id="reviewed" ${includeReviewed ? "checked" : ""}> Include reviewed</label>
      <div class="bar"><button class="primary" id="drafts" ${busy || !locale ? "disabled" : ""}>Get drafts</button></div>` : `<p class="muted">No projects are open in Retrans.</p>`}
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
    ${liveHtml()}
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
        ${link && link !== "searching" && token ? `<button id="send" ${checked && !busy ? "" : "disabled"}>Send to Retrans</button>` : ""}
        <button id="remove">Remove copies</button>
      </div>
      ${sent ? `<p class="ok" role="status">Sent. Apply them in Retrans.</p>` : ""}` : `<p class="muted">Export a preview file from Retrans (Settings → Figma → Designer preview), then load it here.</p>`}`;
}

function resultsText(): string {
  return serializePreview(toResults(state, new Date()));
}

function resultsName(): string {
  const base = (state.fileName ?? "preview").replace(/\.retrans-preview\.json$|\.json$/, "");
  return `${base}.retrans-results.json`;
}

/** Runs a Retrans call; a 401 means the pairing is gone, so forget the token and ask to connect again. */
async function live(run: () => Promise<void>): Promise<void> {
  busy = true;
  error = null;
  render();
  try {
    await run();
  } catch (err) {
    if (err instanceof LinkError && err.status === 401) {
      token = null;
      post({ type: "token", token: null });
    }
    error = err instanceof Error ? err.message : String(err);
  }
  busy = false;
  render();
}

async function loadProjects(): Promise<void> {
  projects = await api().projects();
  if (!projectNow()) projectId = projects[0]?.id ?? "";
  if (!targetLocales().includes(locale)) locale = targetLocales()[0] ?? "";
}

async function connect(): Promise<void> {
  await live(async () => {
    token = await pair(fetch.bind(window), (link as { base: string }).base, code.trim());
    post({ type: "token", token });
    code = "";
    await loadProjects();
  });
}

async function start(): Promise<void> {
  link = await findRetrans(fetch.bind(window));
  render();
  if (link && token) await live(loadProjects);
}

app.addEventListener("click", async (e) => {
  const t = e.target as HTMLElement;
  const row = t.closest<HTMLElement>("[data-key]");
  if (t.id === "pair") await connect();
  else if (t.id === "drafts") {
    await live(async () => {
      const bundle = await api().bundle(projectId, locale, includeReviewed);
      sent = false;
      post({ type: "bundle", bundle, fileName: projectNow()?.name ?? projectId });
    });
  } else if (t.id === "send") {
    await live(async () => {
      await api().send(state.bundle?.sourceProjectId ?? projectId, toResults(state, new Date()));
      sent = true;
    });
  } else if (t.id === "load") (document.getElementById("file") as HTMLInputElement).click();
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

app.addEventListener("input", (e) => {
  const t = e.target as HTMLInputElement;
  if (t.id === "code") code = t.value;
});

app.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.target as HTMLElement).id === "code") void connect();
});

app.addEventListener("change", async (e) => {
  const t = e.target as HTMLInputElement;
  if (t.id === "project") {
    projectId = t.value;
    locale = targetLocales()[0] ?? "";
    render();
  } else if (t.id === "locale") locale = t.value;
  else if (t.id === "reviewed") includeReviewed = t.checked;
  else if (t.id === "file") {
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
    const hadToken = token;
    state = msg.state;
    token = msg.token;
    if (!hadToken && token && link && link !== "searching" && !projects.length) void live(loadProjects);
    selected = msg.selectedFrames;
    error = null;
  }
  render();
};

render();
void start();
