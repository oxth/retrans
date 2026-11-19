import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: async () => undefined, set: async () => {}, save: async () => {} })),
}));

import { useApp } from "./store";
import { Welcome } from "./Welcome";

beforeEach(() => useApp.setState({ welcomeOpen: true, prefsOpen: false, prefsSection: null, uiRequest: null }));
afterEach(cleanup);

const heading = () => screen.getByRole("heading", { level: 2 }).textContent;
const toLast = async () => {
  render(<Welcome />);
  for (let i = 0; i < 2; i++) await userEvent.click(screen.getByRole("button", { name: "Next" }));
};

describe("Welcome", () => {
  it("walks through every step with Next and Back", async () => {
    render(<Welcome />);
    expect(heading()).toBe("Welcome to Retrans");
    expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(heading()).toBe("Bring your translations");
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(heading()).toBe("Welcome to Retrans");
    cleanup();
    await toLast();
    expect(heading()).toBe("Learn by doing");
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
  });

  it("arrow keys move between steps", async () => {
    render(<Welcome />);
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(heading()).toBe("Learn by doing");
    await userEvent.keyboard("{ArrowLeft}");
    expect(heading()).toBe("Bring your translations");
  });

  it("Skip tour, Maybe later and Escape close it", async () => {
    render(<Welcome />);
    await userEvent.click(screen.getByRole("button", { name: "Skip tour" }));
    expect(useApp.getState().welcomeOpen).toBe(false);
    useApp.setState({ welcomeOpen: true });
    await userEvent.keyboard("{Escape}");
    expect(useApp.getState().welcomeOpen).toBe(false);
    cleanup();
    useApp.setState({ welcomeOpen: true });
    await toLast();
    await userEvent.click(screen.getByRole("button", { name: "Maybe later" }));
    expect(useApp.getState().welcomeOpen).toBe(false);
  });

  it("the last step opens the sample project, a project of yours or AI settings", async () => {
    await toLast();
    await userEvent.click(screen.getByRole("button", { name: /Try the sample project/ }));
    expect(useApp.getState()).toMatchObject({ welcomeOpen: false, uiRequest: { kind: "open-sample" } });

    cleanup();
    useApp.setState({ welcomeOpen: true });
    await toLast();
    await userEvent.click(screen.getByRole("button", { name: /Open my own project/ }));
    expect(useApp.getState()).toMatchObject({ welcomeOpen: false, uiRequest: { kind: "open-project" } });

    cleanup();
    useApp.setState({ welcomeOpen: true });
    await toLast();
    await userEvent.click(screen.getByRole("button", { name: /Set up AI translation/ }));
    expect(useApp.getState()).toMatchObject({ welcomeOpen: false, prefsOpen: true, prefsSection: "mt" });
  });
});
