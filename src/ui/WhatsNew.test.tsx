import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "0.5.0") }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: async () => undefined, set: async () => {}, save: async () => {} })),
}));

import { openUrl } from "@tauri-apps/plugin-opener";
import { parseChangelog, RELEASES } from "./changelog";
import { useApp } from "./store";
import { CHANGELOG_URL, WhatsNew } from "./WhatsNew";

afterEach(cleanup);

const MD = `# Changelog

Intro text.

## [Unreleased]

- Not out yet

## [1.1.0] - 2026-11-13

### What's new

- **Big thing.** Does stuff, see [docs](https://example.com).
- Uses \`code\`

### Note

A plain paragraph.

## [1.0.0] - 2026-11-01

First release.

- Bullet without a heading

[1.1.0]: https://example.com/1.1.0
[1.0.0]: https://example.com/1.0.0
`;

describe("parseChangelog", () => {
  it("reads released versions newest first, skipping Unreleased and the link list", () => {
    const r = parseChangelog(MD);
    expect(r.map((x) => [x.version, x.date])).toEqual([["1.1.0", "2026-11-13"], ["1.0.0", "2026-11-01"]]);
    expect(r[0].sections).toEqual([
      { title: "What's new", items: ["**Big thing.** Does stuff, see [docs](https://example.com).", "Uses `code`"], paragraphs: [] },
      { title: "Note", items: [], paragraphs: ["A plain paragraph."] },
    ]);
    expect(r[1].intro).toEqual(["First release."]);
    expect(r[1].sections).toEqual([{ title: "What's new", items: ["Bullet without a heading"], paragraphs: [] }]);
  });

  it("the bundled CHANGELOG.md has releases with notes", () => {
    expect(RELEASES.length).toBeGreaterThan(0);
    for (const r of RELEASES) expect(r.sections.length + r.intro.length, r.version).toBeGreaterThan(0);
  });
});

describe("WhatsNew", () => {
  const setup = () => {
    act(() => useApp.getState().openWhatsNew());
    render(<WhatsNew />);
  };

  it("opens on the installed version, marked Installed", async () => {
    setup();
    expect(await screen.findByText("Installed")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("What's new in Retrans 0.5.0");
    const nav = screen.getByRole("navigation", { name: "Versions" });
    expect(within(nav).getByRole("button", { name: /0\.5\.0/ })).toHaveAttribute("aria-current", "true");
  });

  it("picking another version shows its notes", async () => {
    setup();
    await screen.findByText("Installed");
    await userEvent.click(within(screen.getByRole("navigation", { name: "Versions" })).getByRole("button", { name: /^0\.4\.1/ }));
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("What's new in Retrans 0.4.1");
    expect(screen.getByText("Intel Macs.")).toBeInTheDocument();
  });

  it("opens on the version it was asked for (the update toast)", async () => {
    act(() => useApp.getState().openWhatsNew("0.4.1"));
    render(<WhatsNew />);
    await screen.findByText("Installed");
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("What's new in Retrans 0.4.1");
  });

  it("links to the web changelog, and closes with Escape", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: /Changelog on the web/ }));
    expect(openUrl).toHaveBeenCalledWith(CHANGELOG_URL);
    await userEvent.keyboard("{Escape}");
    expect(useApp.getState().whatsNewOpen).toBe(false);
  });
});
