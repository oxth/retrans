/**
 * Retrans Preview, plugin window. A guided flow in three steps: get drafts (from Retrans or a file),
 * select a frame (a temporary preview follows the selection), then check each string and send the results.
 */
import { parseBundle, serializePreview } from "../../src/preview/format";
import { renderKeepingNote } from "./keep-focus";
import { currentStep, linkNote, nothingLinked, type PluginState, progress, resultsKey, toResults } from "./logic";
import { LinkError, type RetransProject, draftsProject, draftsTarget, reloadLanguage, findRetrans, linkAfterError, liveApi, pair, pickProject, sendResults } from "./live";
import type { ToCode, ToUi } from "./protocol";

const app = document.getElementById("app")!;
let state: PluginState = { bundle: null, fileName: null, rows: [] };
let error: string | null = null;
/** True while the designer is picking new drafts although some are loaded. */
let choosing = false;
/** Show the file route in step 1 even though Retrans is connected. */
let useFile = false;

// Live link to the Retrans app on this computer.
let link: { base: string; paired: boolean } | null | "searching" = "searching";
let token: string | null = null;
let projects: RetransProject[] = [];
let projectId = "";
let locale = "";
let includeReviewed = false;
let code = "";
let busy = false;
/** The frame whose preview the plugin is building right now. */
let previewing: string | null = null;
/** The marks as they were when last sent or copied, so the confirmation hides once they change. */
let sentKey: string | null = null;
let copiedKey: string | null = null;

const api = () => liveApi(fetch.bind(window), (link as { base: string }).base, token!);
const connected = () => !!link && link !== "searching" && !!token;
const projectNow = () => projects.find((p) => p.id === projectId);
const targetLocales = () => (projectNow() ? projectNow()!.locales.filter((l) => l !== projectNow()!.baseLocale) : []);

const post = (msg: ToCode) => parent.postMessage({ pluginMessage: msg }, "*");
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const shortKey = (key: string) => key.slice(key.indexOf("::") + 2);
const dis = (off: boolean) => (off ? "disabled" : "");

type Step = "drafts" | "select" | "check";

function stepsHtml(step: Step): string {
  const names = [["drafts", "Get drafts"], ["select", "Select a frame"], ["check", "Check & send"]] as const;
  const at = names.findIndex(([id]) => id === step);
  return `<ol class="steps">${names
    .map(([, label], i) => `<li class="${i === at ? "now" : i < at ? "done" : ""}" ${i === at ? 'aria-current="step"' : ""}>${i < at ? "✓" : i + 1} ${label}</li>`)
    .join("")}</ol>`;
}

function rowHtml(r: PluginState["rows"][number]): string {
  const flag = r.flag === "overflow" ? `<span class="warn">⚠ may overflow</span>` : r.flag === "font-missing" ? `<span class="warn">⚠ font missing</span>` : "";
  return `<div class="row" data-key="${esc(r.key)}">
    <div class="row-head"><strong>${esc(shortKey(r.key))}</strong> ${flag}
      <button class="link show" data-focus aria-label="Show ${esc(shortKey(r.key))} in the preview copy">Show</button></div>
    <div class="text">${esc(r.text)}</div>
    <div class="bar">
      <button data-verdict="fits" aria-pressed="${r.verdict === "fits"}">Fits</button>
      <button data-verdict="too-long" aria-pressed="${r.verdict === "too-long"}">Too long</button>
    </div>
    <input type="text" data-note placeholder="Note (optional)" value="${esc(r.note ?? "")}" aria-label="Note for ${esc(shortKey(r.key))}">
  </div>`;
}

/** Shown at every step while Retrans can't be reached, unless the designer is working from a file. */
function bannerHtml(): string {
  const fromFile = useFile || (!!state.bundle && !state.projectId);
  if (link !== null || fromFile) return "";
  return `<div class="banner" role="status"><strong>Can't reach Retrans.</strong> Open it and turn on Settings → Figma plugin → Live link.
    <div class="bar"><button id="retry" ${dis(busy)}>Try again</button><button id="use-file">Use a preview file</button></div></div>`;
}

const fileInput = `<input type="file" id="file" accept=".json" hidden>`;

/** Step 1: drafts come from Retrans when it's connected, else from a preview file. */
function draftsHtml(): string {
  const fileRoute = `<div class="bar"><button class="primary" id="load">Load preview file…</button></div>
    <p class="muted">In Retrans: Settings → Figma → Export preview for a designer…</p>`;
  if (link === "searching") return `<p class="muted">Looking for Retrans…</p>`;
  if (useFile || !link) {
    return `${fileRoute}${link ? `<p><button class="link" id="use-live">Get drafts from Retrans instead</button></p>` : ""}`;
  }
  if (!token) {
    return `<p><strong>Connect to Retrans</strong></p>
      <p class="muted">Enter the 6-digit code from Retrans: Settings → Figma plugin → Pair a plugin.</p>
      <div class="bar"><input type="text" id="code" inputmode="numeric" maxlength="6" placeholder="123456" value="${esc(code)}" aria-label="6-digit code">
      <button class="primary" id="pair" ${dis(busy)}>Connect</button></div>
      <p><button class="link" id="use-file">Use a preview file instead</button></p>`;
  }
  const p = projectNow();
  if (!p) {
    return `<p class="muted">No Figma-linked projects are open in Retrans. Open one, then refresh.</p>
      <div class="bar"><button id="refresh" ${dis(busy)}>Refresh</button></div>
      <p><button class="link" id="use-file">Use a preview file instead</button></p>`;
  }
  return `<p class="muted"><span class="ok">●</span> Connected to Retrans</p>
    <div class="bar">
      <select id="project" aria-label="Project">${projects.map((x) => `<option value="${esc(x.id)}" ${x.id === projectId ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>
      <select id="locale" aria-label="Language">${targetLocales().map((l) => `<option value="${esc(l)}" ${l === locale ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>
      <button id="refresh" title="Reload the open projects" ${dis(busy)}>Refresh</button>
    </div>
    <label><input type="checkbox" id="reviewed" ${includeReviewed ? "checked" : ""}> Include reviewed</label>
    <div class="bar"><button class="primary" id="drafts" ${dis(busy || !locale)}>Get drafts</button></div>
    <p><button class="link" id="use-file">Use a preview file instead</button></p>`;
}

/** The loaded drafts, with a quick way to switch language (Retrans) or file. */
function loadedHtml(): string {
  const b = state.bundle!;
  const fromRetrans = !!state.projectId;
  const project = fromRetrans && connected() ? draftsProject(projects, state.projectId, b.sourceProjectId) : undefined;
  const langs = project ? project.locales.filter((l) => l !== project.baseLocale) : [];
  let language: string;
  if (project) {
    // Always the picker for drafts from Retrans, even with one language, so switching is where you expect it.
    language = `<label class="lang">Language <select id="draft-locale" aria-label="Language" ${dis(busy)}>${langs
      .map((l) => `<option value="${esc(l)}" ${l === b.locale ? "selected" : ""}>${esc(l)}</option>`)
      .join("")}</select></label>
      <button class="link" id="reload" title="Get the latest languages and translations from Retrans" ${dis(busy)}>Reload</button>`;
  } else if (fromRetrans) {
    language = `Language <strong>${esc(b.locale)}</strong> <span class="muted">(connect to Retrans to switch)</span>`;
  } else {
    language = `Language <strong>${esc(b.locale)}</strong> <span class="muted">from a file</span> · <button class="link" id="load">Load another language</button>`;
  }
  return `<div class="loaded"><div><strong>${esc(state.fileName ?? "")}</strong> · ${plural(b.strings.length, "string", "strings")} · <button class="link" id="change">Change</button></div>
    <div class="lang-row">${language}</div></div>`;
}

/** Step 2: select a frame; the preview follows the selection. */
function selectHtml(): string {
  return `${loadedHtml()}
    ${previewing
      ? `<p class="hint" role="status">Previewing <strong>${esc(previewing)}</strong>…</p>`
      : `<p class="hint">Select a frame to preview.</p>`}
    <p class="muted">A temporary copy appears next to it with the drafts in place. It moves when you select another frame and goes away when you close the plugin. Your frames are never changed.</p>`;
}

/** Step 3: check the previewed frame's strings, then send or save. */
function checkHtml(): string {
  const note = state.preview ? linkNote(state.preview) : null;
  const head = `${loadedHtml()}
    <p class="previewing" role="status">${previewing ? `Previewing <strong>${esc(previewing)}</strong>…` : `Previewing <strong>${esc(state.preview!.frameName)}</strong>`}</p>
    ${note ? `<div class="info">${esc(note)}${nothingLinked(state) ? " Select another frame, or link the text in Figma first." : ""}</div>` : ""}`;
  if (nothingLinked(state)) return head;
  const p = progress(state.rows);
  const rows = state.rows.filter((r) => r.found).sort((a, c) => Number(!!c.flag) - Number(!!a.flag));
  const rest = state.rows.some((r) => r.found && !r.flag && r.verdict === null);
  const checked = state.rows.filter((r) => r.verdict).length;
  const live = connected();
  return `${head}
    <p class="summary">${p.flagged ? `<span class="warn">⚠ ${p.flagged} may overflow</span> · ` : ""}${checked} of ${p.total} checked</p>
    ${rest ? `<div class="bar"><button id="rest">Mark the rest as Fits</button></div>` : ""}
    ${rows.map(rowHtml).join("")}
    <div class="bar sticky">
      ${live ? `<button class="primary" id="send" ${dis(!checked || busy)}>Send to Retrans</button>` : ""}
      <button ${live ? "" : 'class="primary"'} id="save" ${dis(!checked)}>Save results</button>
      <button id="copy" ${dis(!checked)}>Copy results</button>
    </div>
    ${sentKey === resultsKey(state) ? `<p class="ok" role="status">Sent. Apply them in Retrans.</p>` : ""}
    ${copiedKey === resultsKey(state) ? `<p class="ok" role="status">Copied. Paste it into a file named ${esc(resultsName())} and import it in Retrans with Import designer results….</p>` : ""}
    <p class="muted">Select another frame to check it too; your marks are kept.</p>`;
}

function render(): void {
  const step: Step = choosing ? "drafts" : currentStep(state);
  const body = step === "drafts" ? draftsHtml() : step === "select" ? selectHtml() : checkHtml();
  renderKeepingNote(app, `
    ${stepsHtml(step)}
    ${bannerHtml()}
    ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
    ${body}
    ${fileInput}
    ${choosing && state.bundle ? `<p><button class="link" id="keep">Keep the current drafts</button></p>` : ""}`);
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
    link = linkAfterError(link, err);
    error = err instanceof Error ? err.message : String(err);
  } finally {
    busy = false;
    render();
  }
}

async function loadProjects(): Promise<void> {
  projects = await api().projects();
  projectId = pickProject(projects, projectId, state.bundle?.sourceProjectId);
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
  link = "searching";
  render();
  link = await findRetrans(fetch.bind(window));
  render();
  if (link && token) await live(loadProjects);
}

/** Loads drafts; the plugin side previews the selected (or already previewed) frame with them. */
function useDrafts(msg: ToCode & { type: "bundle" }): void {
  choosing = false;
  useFile = false;
  sentKey = copiedKey = null;
  post(msg);
}

/** Gets the latest languages and translations for the loaded drafts' project; marks on unchanged text stay. */
async function reloadDrafts(): Promise<void> {
  const b = state.bundle;
  if (!b) return;
  await live(async () => {
    projects = await api().projects();
    const project = draftsProject(projects, state.projectId, b.sourceProjectId);
    if (!project) throw new Error("That project isn't open in Retrans any more. Open it, then reload.");
    const lang = reloadLanguage(project, b.locale);
    if (!lang) throw new Error(`${project.name} has no languages to translate into any more.`);
    const bundle = await api().bundle(project.id, lang, includeReviewed);
    useDrafts({ type: "bundle", bundle, fileName: project.name, projectId: project.id });
  });
}

/** Fetches `lang` drafts for a Retrans project and loads them. */
async function fetchDrafts(project: string, lang: string): Promise<void> {
  await live(async () => {
    projects = await api().projects();
    const target = draftsTarget(projects, project, lang);
    const bundle = await api().bundle(target.project.id, target.locale, includeReviewed);
    useDrafts({ type: "bundle", bundle, fileName: target.project.name, projectId: target.project.id });
  });
}

app.addEventListener("click", async (e) => {
  const t = e.target as HTMLElement;
  const row = t.closest<HTMLElement>("[data-key]");
  if (t.id === "pair") await connect();
  else if (t.id === "retry") {
    if (!busy) await start();
  } else if (t.id === "refresh") await live(loadProjects);
  else if (t.id === "use-file") {
    useFile = true;
    // From steps 2 and 3 too: go to step 1, where the file route is.
    choosing = !!state.bundle;
    render();
  } else if (t.id === "use-live") {
    useFile = false;
    render();
  } else if (t.id === "change") {
    choosing = true;
    error = null;
    render();
  } else if (t.id === "keep") {
    choosing = false;
    render();
  } else if (t.id === "drafts") {
    await live(async () => {
      const picked = projectId;
      const wanted = locale;
      projects = await api().projects();
      let target: ReturnType<typeof draftsTarget>;
      try {
        target = draftsTarget(projects, picked, wanted);
      } finally {
        projectId = pickProject(projects, projectId, state.bundle?.sourceProjectId);
        if (!targetLocales().includes(locale)) locale = targetLocales()[0] ?? "";
      }
      const bundle = await api().bundle(target.project.id, target.locale, includeReviewed);
      useDrafts({ type: "bundle", bundle, fileName: target.project.name, projectId: target.project.id });
    });
  } else if (t.id === "send") {
    await live(async () => {
      sentKey = null;
      await sendResults(api(), toResults(state, new Date()), state.projectId ? state.fileName ?? undefined : undefined, state.projectId);
      sentKey = resultsKey(state);
    });
  } else if (t.id === "load") (document.getElementById("file") as HTMLInputElement).click();
  else if (t.id === "reload") await reloadDrafts();
  else if (t.id === "rest") post({ type: "mark-rest-fits" });
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
    copiedKey = resultsKey(state);
    render();
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
  else if (t.id === "draft-locale" && state.bundle) {
    const project = draftsProject(projects, state.projectId, state.bundle.sourceProjectId);
    if (project) await fetchDrafts(project.id, t.value);
  }
  else if (t.id === "reviewed") includeReviewed = t.checked;
  else if (t.id === "file") {
    const f = t.files?.[0];
    if (!f) return;
    const r = parseBundle(await f.text());
    error = r.ok ? null : r.error;
    if (r.ok) useDrafts({ type: "bundle", bundle: r.bundle, fileName: f.name });
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
    previewing = msg.previewing;
    if (!hadToken && token && link && link !== "searching" && !projects.length) void live(loadProjects);
    error = null;
  }
  render();
};

render();
void start();
