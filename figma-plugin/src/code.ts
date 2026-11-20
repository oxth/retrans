/**
 * Retrans Preview, plugin side. Makes copies of the selected frames with the drafts of a preview
 * file in place, flags text that spills, and keeps the designer's verdicts. Only nodes this plugin
 * made (tagged "retransPreview") are ever changed or removed.
 */
import type { PreviewBundle, PreviewFlag } from "../../src/preview/format";
import { type Box, copyPlacement, isOverflow, markRestFits, matchesVariable, planCopies, type PluginState, type TextShape } from "./logic";
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

/** Puts the drafts into one copy; returns the flag per key for the strings found in it. */
async function fill(copy: SceneNode & ChildrenMixin, bundle: PreviewBundle): Promise<Map<string, PreviewFlag>> {
  const found = new Map<string, PreviewFlag>();
  for (const node of copy.findAllWithCriteria({ types: ["TEXT"] })) {
    const bound = node.boundVariables?.characters?.id;
    if (!bound) continue;
    const s = bundle.strings.find((x) => x.figmaVariableId && matchesVariable(bound, x.figmaVariableId));
    if (!s) continue;
    nodesByKey.set(s.key, [...(nodesByKey.get(s.key) ?? []), node.id]);
    if (!(await loadFonts(node))) {
      found.set(s.key, worse(found.get(s.key) ?? null, "font-missing"));
      continue;
    }
    const before = measure(node);
    node.setBoundVariable("characters", null);
    node.characters = s.text;
    const flag = isOverflow(before, measure(node), parentBox(node)) ? "overflow" : null;
    found.set(s.key, worse(found.get(s.key) ?? null, flag));
  }
  return found;
}

function existingCopies(): Array<{ copyId: string; sourceId: string; locale: string; node: SceneNode }> {
  return figma.currentPage
    .findAll((n) => n.getPluginData(TAG) !== "")
    .map((n) => ({ copyId: n.id, sourceId: n.getPluginData(SOURCE), locale: n.getPluginData(TAG), node: n }));
}

async function makeCopies(): Promise<void> {
  const bundle = state.bundle;
  if (!bundle) return send({ type: "error", message: "Load a preview file first." });
  const selected = figma.currentPage.selection.filter((n) => "clone" in n && n.type !== "TEXT");
  if (!selected.length) return send({ type: "error", message: "Select one or more frames to preview." });
  const existing = existingCopies();
  const plan = planCopies(selected.map((n) => n.id), existing, bundle.locale);
  for (const e of existing) if (plan.remove.includes(e.copyId)) e.node.remove();

  nodesByKey.clear();
  const flags = new Map<string, PreviewFlag>();
  const made: SceneNode[] = [];
  for (const id of plan.copy) {
    const source = (await figma.getNodeByIdAsync(id)) as (SceneNode & ChildrenMixin) | null;
    if (!source || !("clone" in source)) continue;
    const copy = source.clone() as SceneNode & ChildrenMixin;
    const place = copyPlacement({ x: source.x, y: source.y, width: source.width, abs: boxOf(source), parentType: source.parent?.type ?? "PAGE" });
    if (place.into === "parent" && source.parent) (source.parent as ChildrenMixin).appendChild(copy);
    else figma.currentPage.appendChild(copy);
    copy.x = place.x;
    copy.y = place.y;
    copy.name = `${source.name} · Preview ${bundle.locale}`;
    copy.setPluginData(TAG, bundle.locale);
    copy.setPluginData(SOURCE, source.id);
    for (const [k, f] of await fill(copy, bundle)) flags.set(k, worse(flags.get(k) ?? null, f));
    made.push(copy);
  }
  state = { ...state, copiesMade: made.length, rows: state.rows.map((r) => ({ ...r, found: flags.has(r.key), flag: flags.get(r.key) ?? null })) };
  figma.currentPage.selection = made;
  if (made.length) figma.viewport.scrollAndZoomIntoView(made);
  await save();
}

async function removeCopies(): Promise<void> {
  for (const e of existingCopies()) e.node.remove();
  nodesByKey.clear();
  state = { ...state, copiesMade: undefined, rows: state.rows.map((r) => ({ ...r, found: false, flag: null })) };
  await save();
}

async function focus(key: string): Promise<void> {
  for (const id of nodesByKey.get(key) ?? []) {
    const node = await figma.getNodeByIdAsync(id);
    if (node && node.type === "TEXT") {
      figma.currentPage.selection = [node];
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
    } else if (msg.type === "make-copies") await makeCopies();
    else if (msg.type === "remove-copies") await removeCopies();
    else if (msg.type === "verdict") {
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

figma.on("selectionchange", publish);

(async () => {
  const stored = (await figma.clientStorage.getAsync(storageKey)) as PluginState | undefined;
  if (stored?.bundle) state = stored;
  const t = await figma.clientStorage.getAsync("retransToken");
  token = typeof t === "string" ? t : null;
  publish();
})();
