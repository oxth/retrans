import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  handlers: [] as Array<(event: { payload: unknown }) => void>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, handler: (event: { payload: unknown }) => void) => {
    state.handlers.push(handler);
    return () => {
      const i = state.handlers.indexOf(handler);
      if (i >= 0) state.handlers.splice(i, 1);
    };
  }),
}));

import { invoke } from "@tauri-apps/api/core";
import { watchDir } from "./watch";

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  invokeMock.mockClear();
  state.handlers.length = 0;
});

describe("watchDir", () => {
  it("delivers only events for its own root", async () => {
    const onA = vi.fn();
    const onB = vi.fn();
    await watchDir("/a", onA);
    await watchDir("/b", onB);

    for (const handler of state.handlers) {
      handler({ payload: { root: "/b", paths: ["/b/x.json"] } });
    }

    expect(onA).not.toHaveBeenCalled();
    expect(onB).toHaveBeenCalledWith(["/b/x.json"]);
  });

  it("stopping one root leaves the other watched", async () => {
    const stopA = await watchDir("/a", vi.fn());
    await watchDir("/b", vi.fn());

    await stopA();

    expect(invokeMock).toHaveBeenCalledWith("unwatch_dir", { root: "/a" });
    expect(invokeMock).not.toHaveBeenCalledWith("unwatch_dir", { root: "/b" });
  });

  it("a superseded watch of the same root never unwatches the newer one", async () => {
    const stop1 = await watchDir("/a", vi.fn());
    await watchDir("/a", vi.fn());
    invokeMock.mockClear();

    await stop1();

    expect(invokeMock).not.toHaveBeenCalledWith("unwatch_dir", { root: "/a" });
  });

  it("an old stop never unwatches a watch started after the root was stopped and re-watched", async () => {
    const stop1 = await watchDir("/c", vi.fn());
    const stop2 = await watchDir("/c", vi.fn());
    await stop2();
    await watchDir("/c", vi.fn());
    invokeMock.mockClear();

    await stop1();

    expect(invokeMock).not.toHaveBeenCalledWith("unwatch_dir", { root: "/c" });
  });
});
