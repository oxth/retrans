import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prefs = vi.hoisted(() => new Map<string, unknown>());
const version = vi.hoisted(() => ({ current: "0.5.1" }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => version.current) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: async (k: string) => prefs.get(k),
    set: async (k: string, v: unknown) => void prefs.set(k, v),
    save: async () => {},
  })),
}));

import { recordLaunchedVersion } from "../platform/prefs";
import { compareVersions, parseChangelog, shouldAnnounceUpdate } from "./changelog";
import { useApp } from "./store";
import { UpdateToast, useAnnounceUpdate } from "./UpdateToast";

beforeEach(() => {
  prefs.clear();
  useApp.setState({ updatedTo: null, whatsNewOpen: false, whatsNewVersion: null });
});
afterEach(cleanup);

const releases = parseChangelog("## [1.2.0] - 2026-11-13\n\n- New\n\n## [1.1.0] - 2026-11-01\n\n- Old\n");

describe("shouldAnnounceUpdate", () => {
  it("only after an upgrade to a version with notes", () => {
    expect(shouldAnnounceUpdate("1.1.0", "1.2.0", releases)).toBe(true);
    expect(shouldAnnounceUpdate("", "1.2.0", releases)).toBe(true); // existing user, version not recorded yet
    expect(shouldAnnounceUpdate(null, "1.2.0", releases)).toBe(false); // first launch
    expect(shouldAnnounceUpdate("1.2.0", "1.2.0", releases)).toBe(false); // ordinary restart
    expect(shouldAnnounceUpdate("1.2.0", "1.1.0", releases)).toBe(false); // downgrade
    expect(shouldAnnounceUpdate("1.1.0", "1.3.0", releases)).toBe(false); // no notes for it
  });

  it("compares versions numerically", () => {
    expect(compareVersions("1.2.10", "1.10.0")).toBeLessThan(0);
    expect(compareVersions("0.5.1", "0.5.1")).toBe(0);
  });
});

describe("recordLaunchedVersion", () => {
  it("returns the previous launch's version and records this one", async () => {
    expect(await recordLaunchedVersion("1.1.0")).toBeNull();
    expect(await recordLaunchedVersion("1.2.0")).toBe("1.1.0");
    expect(prefs.get("lastVersion")).toBe("1.2.0");
  });

  it("treats a user with recent projects but no record as updating from an older version", async () => {
    prefs.set("recent", [{ root: "/p", name: "p", format: "next-i18next" }]);
    expect(await recordLaunchedVersion("1.2.0")).toBe("");
  });
});

function Harness() {
  useAnnounceUpdate();
  return <UpdateToast />;
}

describe("UpdateToast", () => {
  it("appears on the first launch after an update and opens What's new on that version", async () => {
    prefs.set("lastVersion", "0.5.0");
    version.current = "0.5.1";
    render(<Harness />);
    expect(await screen.findByRole("status")).toHaveTextContent("Updated to Retrans 0.5.1");
    await userEvent.click(screen.getByRole("button", { name: "See what's new" }));
    expect(useApp.getState()).toMatchObject({ whatsNewOpen: true, whatsNewVersion: "0.5.1", updatedTo: null });
  });

  it("does not appear on an ordinary restart", async () => {
    prefs.set("lastVersion", "0.5.1");
    version.current = "0.5.1";
    render(<Harness />);
    await waitFor(() => expect(prefs.get("lastVersion")).toBe("0.5.1"));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("Dismiss hides it", async () => {
    act(() => useApp.setState({ updatedTo: "0.5.1" }));
    render(<UpdateToast />);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
