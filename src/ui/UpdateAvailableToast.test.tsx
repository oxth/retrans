import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const updates = vi.hoisted(() => ({ checkForUpdate: vi.fn() }));
const prefs = vi.hoisted(() => ({ getAutoCheckUpdates: vi.fn(), setAutoCheckUpdates: vi.fn() }));
vi.mock("../platform/updates", () => updates);
vi.mock("../platform/prefs", () => prefs);

import type { ProjectSession } from "../core/session";
import { useApp } from "./store";
import { UnsavedPrompt } from "./UnsavedPrompt";
import { CHECK_EVERY_MS, RECHECK_AFTER_MS, UpdateAvailableToast, UpdateSettings } from "./UpdateAvailableToast";

const install = vi.fn();
const found = () => ({ version: "1.2.3", install });
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  updates.checkForUpdate.mockReset();
  install.mockReset();
  prefs.getAutoCheckUpdates.mockReset().mockResolvedValue(true);
  prefs.setAutoCheckUpdates.mockReset().mockResolvedValue(undefined);
  useApp.setState({ update: null, updateSeen: null }); // shared by the toast, About and the gear's dot
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  warn.mockRestore();
});

describe("UpdateAvailableToast", () => {
  it("shows the banner with the version", async () => {
    updates.checkForUpdate.mockResolvedValue(found());
    render(<UpdateAvailableToast />);
    expect(await screen.findByText("Retrans 1.2.3 is available.")).toBeInTheDocument();
    expect(updates.checkForUpdate).toHaveBeenCalledTimes(1);
  });

  it("hides on Later", async () => {
    updates.checkForUpdate.mockResolvedValue(found());
    render(<UpdateAvailableToast />);
    await userEvent.click(await screen.findByRole("button", { name: "Later" }));
    expect(screen.queryByText("Retrans 1.2.3 is available.")).toBeNull();
  });

  it("installs and shows progress", async () => {
    updates.checkForUpdate.mockResolvedValue(found());
    install.mockImplementation(async (cb: (d: number, t: number) => void) => {
      cb(50, 100);
      await new Promise(() => {});
    });
    render(<UpdateAvailableToast />);
    await userEvent.click(await screen.findByRole("button", { name: "Install and restart" }));
    expect(install).toHaveBeenCalled();
    expect(await screen.findByText("Downloading… 50%")).toBeInTheDocument();
  });

  it("shows a failure message when install fails", async () => {
    updates.checkForUpdate.mockResolvedValue(found());
    install.mockRejectedValue(new Error("boom"));
    render(<UpdateAvailableToast />);
    await userEvent.click(await screen.findByRole("button", { name: "Install and restart" }));
    expect(await screen.findByText("Update failed. Try again later.")).toBeInTheDocument();
  });

  it("renders nothing when the check rejects", async () => {
    updates.checkForUpdate.mockRejectedValue(new Error("offline"));
    const { container } = render(<UpdateAvailableToast />);
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("does not check when auto-check is off", async () => {
    prefs.getAutoCheckUpdates.mockResolvedValue(false);
    const { container } = render(<UpdateAvailableToast />);
    await waitFor(() => expect(prefs.getAutoCheckUpdates).toHaveBeenCalled());
    await Promise.resolve();
    expect(updates.checkForUpdate).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });
});

describe("Install and restart with unsaved edits", () => {
  const dirty = { isDirty: () => true } as unknown as ProjectSession;
  const real = useApp.getState().save;
  afterEach(() => useApp.setState({ session: null, closePrompt: null, save: real }));

  async function banner() {
    updates.checkForUpdate.mockResolvedValue(found());
    install.mockResolvedValue(undefined);
    useApp.setState({ session: dirty });
    render(<><UpdateAvailableToast /><UnsavedPrompt /></>);
    await userEvent.click(await screen.findByRole("button", { name: "Install and restart" }));
    return screen.findByRole("dialog", { name: "Unsaved changes" });
  }

  it("asks first; Cancel installs nothing", async () => {
    const d = await banner();
    expect(d).toHaveTextContent("Save them before updating?");
    expect(install).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(install).not.toHaveBeenCalled();
  });

  it("Save installs only after a successful save", async () => {
    const save = vi.fn(async () => false);
    useApp.setState({ save });
    await banner();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(install).not.toHaveBeenCalled();
    save.mockResolvedValue(true);
    await userEvent.click(screen.getByRole("button", { name: "Install and restart" }));
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(install).toHaveBeenCalled());
  });

  it("Discard installs", async () => {
    await banner();
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(install).toHaveBeenCalled());
  });

  it("Settings asks too", async () => {
    updates.checkForUpdate.mockResolvedValue(found());
    useApp.setState({ session: dirty });
    render(<><UpdateSettings /><UnsavedPrompt /></>);
    await userEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await userEvent.click(await screen.findByRole("button", { name: "Install and restart" }));
    expect(await screen.findByRole("dialog", { name: "Unsaved changes" })).toBeTruthy();
    expect(install).not.toHaveBeenCalled();
  });
});

describe("UpdateSettings", () => {
  it("toggles auto-check", async () => {
    render(<UpdateSettings />);
    const box = await screen.findByRole("checkbox", { name: "Check for updates automatically" });
    await waitFor(() => expect(box).toBeChecked());
    await userEvent.click(box);
    expect(prefs.setAutoCheckUpdates).toHaveBeenCalledWith(false);
  });

  it("reports up to date", async () => {
    updates.checkForUpdate.mockResolvedValue(null);
    render(<UpdateSettings />);
    await userEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("You're up to date.")).toBeInTheDocument();
  });

  it("reports an available update with install", async () => {
    updates.checkForUpdate.mockResolvedValue(found());
    install.mockResolvedValue(undefined);
    render(<UpdateSettings />);
    await userEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("Retrans 1.2.3 is available.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Install and restart" }));
    expect(install).toHaveBeenCalled();
  });

  it("reports a failed check", async () => {
    updates.checkForUpdate.mockRejectedValue(new Error("offline"));
    render(<UpdateSettings />);
    await userEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("Couldn't check for updates.")).toBeInTheDocument();
  });
});

describe("UpdateAvailableToast while Retrans stays open", () => {
  // Only the clock is fake (faking setInterval would stall testing-library's waitFor). The banner's
  // 6-hour timer is captured and fired by hand.
  let every: (() => void) | undefined;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    every = undefined;
    const real = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms?: number) => {
      if (ms !== CHECK_EVERY_MS) return real(fn, ms); // testing-library's own polling
      every = fn;
      return real(() => {}, 1 << 30);
    }) as typeof setInterval);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(globalThis.setInterval).mockRestore();
  });
  const hours = (h: number) =>
    act(() => {
      for (let i = 0; i < Math.floor((h * 3_600_000) / CHECK_EVERY_MS); i++) {
        vi.setSystemTime(Date.now() + CHECK_EVERY_MS);
        every!();
      }
    });
  const comeBack = () => act(() => void fireEvent.focus(window));

  it("looks again every few hours and shows a version released meanwhile", async () => {
    updates.checkForUpdate.mockResolvedValue(null);
    render(<UpdateAvailableToast />);
    await waitFor(() => expect(updates.checkForUpdate).toHaveBeenCalledTimes(1));
    updates.checkForUpdate.mockResolvedValue(found());
    await hours(CHECK_EVERY_MS / 3_600_000);
    expect(await screen.findByText("Retrans 1.2.3 is available.")).toBeInTheDocument();
    expect(updates.checkForUpdate).toHaveBeenCalledTimes(2);
  });

  it("coming back to the window looks again only if the last look is an hour old", async () => {
    updates.checkForUpdate.mockResolvedValue(null);
    render(<UpdateAvailableToast />);
    await waitFor(() => expect(updates.checkForUpdate).toHaveBeenCalledTimes(1));
    await comeBack(); // just checked
    expect(updates.checkForUpdate).toHaveBeenCalledTimes(1);
    await act(() => vi.setSystemTime(Date.now() + RECHECK_AFTER_MS));
    await comeBack();
    await waitFor(() => expect(updates.checkForUpdate).toHaveBeenCalledTimes(2));
  });

  it("Later hides that version for this run, but a newer one shows", async () => {
    updates.checkForUpdate.mockResolvedValue(found());
    render(<UpdateAvailableToast />);
    await userEvent.click(await screen.findByRole("button", { name: "Later" }));
    await hours(6);
    await waitFor(() => expect(updates.checkForUpdate).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/is available/)).toBeNull();
    updates.checkForUpdate.mockResolvedValue({ version: "1.2.4", install });
    await hours(6);
    expect(await screen.findByText("Retrans 1.2.4 is available.")).toBeInTheDocument();
  });

  it("turning automatic checks off stops the later looks too", async () => {
    updates.checkForUpdate.mockResolvedValue(null);
    render(<UpdateAvailableToast />);
    await waitFor(() => expect(updates.checkForUpdate).toHaveBeenCalledTimes(1));
    prefs.getAutoCheckUpdates.mockResolvedValue(false);
    await hours(6);
    await waitFor(() => expect(prefs.getAutoCheckUpdates).toHaveBeenCalledTimes(2));
    expect(updates.checkForUpdate).toHaveBeenCalledTimes(1);
  });
});

describe("the update in Settings → About", () => {
  it("shows an update found automatically, ready to install, and marks it seen", async () => {
    act(() => useApp.setState({ update: found(), updateSeen: null }));
    render(<UpdateSettings />);
    expect(screen.getByText("Retrans 1.2.3 is available.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install and restart" })).toBeInTheDocument();
    await waitFor(() => expect(useApp.getState().updateSeen).toBe("1.2.3"));
  });

  it("an update found by the toast's check is shared with About", async () => {
    updates.checkForUpdate.mockResolvedValue(found());
    render(<UpdateAvailableToast />);
    await screen.findByText("Retrans 1.2.3 is available.");
    expect(useApp.getState().update?.version).toBe("1.2.3");
    expect(useApp.getState().updateSeen).toBeNull(); // the toast alone doesn't clear the gear's dot
  });
});

