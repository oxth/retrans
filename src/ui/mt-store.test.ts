import { beforeEach, describe, expect, it, vi } from "vitest";

const prefs = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: async (k: string) => prefs.get(k),
    set: async (k: string, v: unknown) => void prefs.set(k, v),
    save: async () => {},
  })),
}));
const native = vi.hoisted(() => ({
  modelsDir: vi.fn(),
  status: vi.fn(),
  startDownload: vi.fn(),
  pause: vi.fn(),
  cancel: vi.fn(),
  deleteModel: vi.fn(),
  unload: vi.fn(),
  onDownload: vi.fn(),
}));
const fsExists = vi.hoisted(() => vi.fn());
vi.mock("../platform/mt", () => ({ mtNative: native, tauriEngine: { generate: vi.fn(), cancel: vi.fn() }, pickGgufFile: vi.fn() }));
vi.mock("../platform/tauri-fs", () => ({ tauriFs: { exists: fsExists } }));

import { findModel } from "../mt/catalog";
import { activeModel, spaceUsed, useMt } from "./mt-store";

const GEMMA = "translategemma-4b-it-Q4_K_M.gguf";
let emit: (e: unknown) => void;
const initial = useMt.getState();

beforeEach(() => {
  prefs.clear();
  Object.values(native).forEach((f) => f.mockReset());
  fsExists.mockReset();
  native.modelsDir.mockResolvedValue("/data/models");
  native.status.mockResolvedValue([]);
  native.startDownload.mockResolvedValue(undefined);
  native.unload.mockResolvedValue(undefined);
  native.deleteModel.mockResolvedValue(undefined);
  native.onDownload.mockImplementation(async (cb) => {
    emit = cb;
    return () => {};
  });
  useMt.setState({ ...initial, initialized: false }, true);
});

const gemmaStatus = [{ file: GEMMA, size: 2489909312, complete: true }];

describe("useMt", () => {
  it("is off by default and has no active model", async () => {
    await useMt.getState().init();
    expect(useMt.getState().settings.enabled).toBe(false);
    expect(activeModel(useMt.getState())).toBeNull();
  });

  it("init never throws when native calls fail", async () => {
    native.modelsDir.mockRejectedValue(new Error("no tauri"));
    native.status.mockRejectedValue(new Error("no tauri"));
    native.onDownload.mockRejectedValue(new Error("no tauri"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(useMt.getState().init()).resolves.toBeUndefined();
    expect(useMt.getState().settings.enabled).toBe(false);
    warn.mockRestore();
  });

  it("active model needs enabled + selected + complete file", async () => {
    native.status.mockResolvedValue(gemmaStatus);
    await useMt.getState().init();
    await useMt.getState().setEnabled(true);
    await useMt.getState().selectModel("translategemma-4b");
    expect(activeModel(useMt.getState())).toEqual({ path: `/data/models/${GEMMA}`, template: "translategemma" });
    expect(spaceUsed(useMt.getState())).toBe(2489909312);
    native.status.mockResolvedValue([{ file: GEMMA, size: 100, complete: false }]);
    await useMt.getState().refresh();
    expect(activeModel(useMt.getState())).toBeNull();
  });

  it("persists settings and unloads when turned off", async () => {
    await useMt.getState().init();
    await useMt.getState().setEnabled(true);
    expect((prefs.get("mt") as { enabled: boolean }).enabled).toBe(true);
    await useMt.getState().setEnabled(false);
    expect(native.unload).toHaveBeenCalled();
    expect((prefs.get("mt") as { enabled: boolean }).enabled).toBe(false);
  });

  it("Gemma download requires accepting the license", async () => {
    await useMt.getState().init();
    await useMt.getState().download("translategemma-4b");
    expect(native.startDownload).not.toHaveBeenCalled();
    expect(useMt.getState().downloads["translategemma-4b"]).toMatchObject({ state: "error", message: "Accept the license first." });
    await useMt.getState().acceptLicense("translategemma-4b");
    await useMt.getState().download("translategemma-4b");
    expect(native.startDownload).toHaveBeenCalledWith(findModel("translategemma-4b"));
  });

  it("download events update progress and refresh files when done", async () => {
    await useMt.getState().init();
    emit({ id: "x", state: "progress", received: 5, total: 10 });
    expect(useMt.getState().downloads.x).toMatchObject({ state: "progress", received: 5, total: 10 });
    native.status.mockResolvedValue(gemmaStatus);
    emit({ id: "x", state: "done", received: 10, total: 10 });
    await vi.waitFor(() => expect(useMt.getState().files[GEMMA]).toEqual({ size: 2489909312, complete: true }));
  });

  it("missing custom file is not active", async () => {
    prefs.set("mt", { enabled: true, modelId: "custom", custom: { path: "/x/m.gguf", template: "qwen3" }, accepted: [] });
    fsExists.mockResolvedValue(false);
    await useMt.getState().init();
    expect(useMt.getState().customMissing).toBe(true);
    expect(activeModel(useMt.getState())).toBeNull();
    fsExists.mockResolvedValue(true);
    await useMt.getState().setCustom("/x/m.gguf", "qwen3");
    expect(activeModel(useMt.getState())).toEqual({ path: "/x/m.gguf", template: "qwen3" });
  });

  it("deleting the selected model refreshes status and clears activeModel", async () => {
    native.status.mockResolvedValue(gemmaStatus);
    await useMt.getState().init();
    await useMt.getState().setEnabled(true);
    await useMt.getState().selectModel("translategemma-4b");
    native.status.mockResolvedValue([]);
    await useMt.getState().deleteModel("translategemma-4b");
    expect(native.deleteModel).toHaveBeenCalledWith(GEMMA);
    expect(activeModel(useMt.getState())).toBeNull();
  });
});
