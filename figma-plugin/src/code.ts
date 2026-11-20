/**
 * Retrans Preview, plugin side. Shows one temporary preview: a copy of the selected frame with the
 * drafts in place, which follows the selection and goes away when the plugin closes. Flags text that
 * spills and keeps the designer's verdicts. Only nodes this plugin made (tagged "retransPreview") are
 * ever changed or removed.
 */
import type { PreviewBundle, PreviewFlag } from "../../src/preview/format";
import { type Box, copyPlacement, frameToPreview, isOverflow, markRestFits, matchesVariable, type PluginState, type SelectedNode, type TextShape } from "./logic";
import type { ToCode, ToUi } from "./protocol";

const TAG = "retransPreview";
const SOURCE = "retransSource";
const FILE_ID = "retransFileId";

/** figma.fileKey is only given to private plugins, so each file gets its own id in the document's plugin data. */
function fileId(): string {
  let id = figma.root.getPluginData(FILE_ID);
  if (!id) {
    id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    figma.root.setPluginData(FILE_ID, id);
  }
  return id;
}
const storageKey = `retransPreview:${fileId()}`;

let state: PluginState = { bundle: null, fileName: null, rows: [] };
/** Pairing token for the Retrans app on this computer; kept here because only the plugin code can store it. */
let token: string | null = null;
/** Text nodes in the copies, per string key, for "focus". Not stored: copies may be gone next time. */
const nodesByKey = new Map<string, string[]>();

figma.showUI(__html__, { width: 360, height: 560, themeColors: true });

function send(msg: ToUi): void {
  figma.ui.postMessage(msg);
}

function selectedFrames(): number {
  return figma.currentPage.selection.filter((n) => "clone" in n && n.type !== "TEXT").length;
}

function publish(): void {
  send({ type: "state", state, selectedFrames: selectedFrames(), token });
}

async function save(): Promise<void> {
  await figma.clientStorage.setAsync(storageKey, state);
  publish();
}

function rowsFor(bundle: PreviewBundle, previous: PluginState): PluginState["rows"] {
  const old = new Map(previous.bundle?.locale === bundle.locale ? previous.rows.map((r) => [r.key, r]) : []);
  return bundle.strings.map((s) => {
    const o = old.get(s.key);
    const keep = o && o.text === s.text;
    return { key: s.key, text: s.text, flag: null, found: false, verdict: keep ? o.verdict : null, ...(keep && o.note ? { note: o.note } : {}) };
  });
}

function boxOf(n: SceneNode): Box {
  const b = n.absoluteBoundingBox;
  if (b) return { x: b.x, y: b.y, width: b.width, height: b.height };
  const t = n.absoluteTransform;
  return { x: t[0][2], y: t[1][2], width: n.width, height: n.height };
}

/** The node's shape, plus the height its text needs (measured by letting it grow, then restoring). */
function measure(node: TextNode): TextShape {
  const box = boxOf(node);
  const autoResize = node.textAutoResize;
  const mode: TextShape["autoResize"] = node.textTruncation === "ENDING" ? "TRUNCATE" : autoResize;
  if (mode === "HEIGHT" || mode === "WIDTH_AND_HEIGHT") return { box, autoResize: mode, needed: box };
  const truncation = node.textTruncation;
  const height = node.height;
  node.textTruncation = "DISABLED";
  node.textAutoResize = "HEIGHT";
  const needed = boxOf(node);
  node.textAutoResize = autoResize;
  node.textTruncation = truncation;
  if (autoResize === "NONE" || autoResize === "TRUNCATE") node.resize(node.width, height);
  return { box, autoResize: mode, needed };
}

function parentBox(node: SceneNode): Box | null {
  const p = node.parent;
  return p && p.type !== "PAGE" && p.type !== "DOCUMENT" && "absoluteBoundingBox" in p ? boxOf(p as SceneNode) : null;
}

async function loadFonts(node: TextNode): Promise<boolean> {
  if (node.hasMissingFont) return false;
  const fonts = node.characters.length > 0 ? node.getRangeAllFontNames(0, node.characters.length) : [node.fontName as FontName];
  try {
    await Promise.all(fonts.map((f) => figma.loadFontAsync(f)));
    return true;
  } catch {
    return false;
  }
}

function worse(a: PreviewFlag, b: PreviewFlag): PreviewFlag {
  return a === "font-missing" || b === "font-missing" ? "font-missing" : a ?? b;
}

/** Puts the drafts into one copy: the flag per key for the strings found in it, and how many text layers matched. */
async function fill(copy: SceneNode & ChildrenMixin, bundle: PreviewBundle): Promise<{ flags: Map<string, PreviewFlag>; linked: number }> {
  const flags = new Map<string, PreviewFlag>();
  let linked = 0;
  for (const node of copy.findAllWithCriteria({ types: ["TEXT"] })) {
    const bound = node.boundVariables?.characters?.id;
    if (!bound) continue;
    const s = bundle.strings.find((x) => x.figmaVariableId && matchesVariable(bound, x.figmaVariableId));
    if (!s) continue;
    linked++;
    nodesByKey.set(s.key, [...(nodesByKey.get(s.key) ?? []), node.id]);
    if (!(await loadFonts(node))) {
      flags.set(s.key, worse(flags.get(s.key) ?? null, "font-missing"));
      continue;
    }
    const before = measure(node);
    node.setBoundVariable("characters", null);
    node.characters = s.text;
    const flag = isOverflow(before, measure(node), parentBox(node)) ? "overflow" : null;
    flags.set(s.key, worse(flags.get(s.key) ?? null, flag));
  }
  return { flags, linked };
}

/** Every preview copy this plugin made, on any page it has loaded. */
function removeAllCopies(): void {
  for (const n of figma.currentPage.findAll((x) => x.getPluginData(TAG) !== "")) n.remove();
  nodesByKey.clear();
}

/** The frame being previewed, so selecting more of the same frame doesn't remake its copy. */
let previewSource: string | null = null;

/** The top-level frame a node sits in (the ancestor whose parent is the page or a section), or null. */
function topFrameOf(node: BaseNode): SceneNode | null {
  let n: BaseNode | null = node;
  while (n && n.parent && n.parent.type !== "PAGE" && n.parent.type !== "SECTION" && n.parent.type !== "DOCUMENT") n = n.parent;
  // Only containers (frames, components, instances, groups) can be previewed; a lone layer keeps the current preview.
  return n && n.parent && n.type !== "PAGE" && n.type !== "DOCUMENT" && "clone" in n && "findAllWithCriteria" in n ? (n as SceneNode) : null;
}

function inPreview(node: BaseNode): boolean {
  for (let n: BaseNode | null = node; n && n.type !== "PAGE"; n = n.parent) if (n.getPluginData(TAG) !== "") return true;
  return false;
}

/** Shows one preview: a copy of `frameId` next to it with the drafts in place; every other copy goes. */
async function previewFrame(frameId: string): Promise<void> {
  const bundle = state.bundle;
  if (!bundle) return;
  removeAllCopies();
  const source = (await figma.getNodeByIdAsync(frameId)) as (SceneNode & ChildrenMixin) | null;
  if (!source || !("clone" in source) || !("findAllWithCriteria" in source)) {
    previewSource = null;
    state = { ...state, preview: undefined, rows: state.rows.map((r) => ({ ...r, found: false, flag: null })) };
    return save();
  }
  const copy = source.clone() as SceneNode & ChildrenMixin;
  const place = copyPlacement({ x: source.x, y: source.y, width: source.width, abs: boxOf(source), parentType: source.parent?.type ?? "PAGE" });
  if (place.into === "parent" && source.parent) (source.parent as ChildrenMixin).appendChild(copy);
  else figma.currentPage.appendChild(copy);
  copy.x = place.x;
  copy.y = place.y;
  copy.name = `${source.name} · Preview ${bundle.locale}`;
  copy.setPluginData(TAG, bundle.locale);
  copy.setPluginData(SOURCE, source.id);
  const textLayers = source.findAllWithCriteria({ types: ["TEXT"] }).length;
  const { flags, linked } = await fill(copy, bundle);
  previewSource = source.id;
  state = {
    ...state,
    preview: { frameName: source.name, textLayers, linked },
    rows: state.rows.map((r) => ({ ...r, found: flags.has(r.key), flag: flags.get(r.key) ?? null })),
  };
  await save();
}

/** Follows the selection: previews its frame after a short pause, so clicking around makes one copy. */
let pending: ReturnType<typeof setTimeout> | null = null;
function followSelection(force = false): void {
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    if (!state.bundle) return;
    const selection: SelectedNode[] = figma.currentPage.selection.map((n) => ({
      id: n.id,
      topFrameId: topFrameOf(n)?.id ?? null,
      inPreview: inPreview(n),
    }));
    const target = frameToPreview(selection);
    const frame = target === "keep" ? (force ? previewSource : null) : target;
    if (!frame || (frame === previewSource && !force)) return;
    void previewFrame(frame).catch((err) => send({ type: "error", message: err instanceof Error ? err.message : String(err) }));
  }, 300);
}

async function focus(key: string): Promise<void> {
  for (const id of nodesByKey.get(key) ?? []) {
    const node = await figma.getNodeByIdAsync(id);
    if (node && node.type === "TEXT") {
      figma.viewport.scrollAndZoomIntoView([node]);
      return;
    }
  }
}

figma.ui.onmessage = async (msg: ToCode) => {
  try {
    if (msg.type === "bundle") {
      state = { bundle: msg.bundle, fileName: msg.fileName, ...(msg.projectId ? { projectId: msg.projectId } : {}), rows: rowsFor(msg.bundle, state) };
      await save();
      // New drafts (or another language): preview the selected frame, or the one already previewed.
      followSelection(true);
    } else if (msg.type === "verdict") {
      state = {
        ...state,
        rows: state.rows.map((r) => (r.key !== msg.key ? r : { ...r, verdict: msg.verdict, ...(msg.note !== undefined ? { note: msg.note } : {}) })),
      };
      await save();
    } else if (msg.type === "mark-rest-fits") {
      state = { ...state, rows: markRestFits(state.rows) };
      await save();
    } else if (msg.type === "focus") await focus(msg.key);
    else if (msg.type === "token") {
      token = msg.token;
      if (token) await figma.clientStorage.setAsync("retransToken", token);
      else await figma.clientStorage.deleteAsync("retransToken");
      publish();
    }
  } catch (err) {
    send({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};

figma.on("selectionchange", () => {
  publish();
  followSelection();
});

// The preview is temporary: it never outlives the plugin window.
figma.on("close", removeAllCopies);

(async () => {
  // Copies left behind by a crash or an older version go first.
  removeAllCopies();
  const stored = (await figma.clientStorage.getAsync(storageKey)) as PluginState | undefined;
  if (stored?.bundle) state = { ...stored, preview: undefined, rows: stored.rows.map((r) => ({ ...r, found: false, flag: null })) };
  const t = await figma.clientStorage.getAsync("retransToken");
  token = typeof t === "string" ? t : null;
  publish();
})();
