import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { Dialog } from "./Dialog";

afterEach(cleanup);

describe("Dialog focus", () => {
  it("Tab wraps from the last control to the first, and Shift+Tab back", async () => {
    render(
      <>
        <button>Behind</button>
        <Dialog title="Rename" onClose={() => {}}>
          <input aria-label="Name" />
          <button>Cancel</button>
          <button>Save</button>
        </Dialog>
      </>,
    );
    screen.getByRole("button", { name: "Save" }).focus();
    await userEvent.tab();
    expect(screen.getByLabelText("Name")).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Save" })).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus(); // in between: the usual order
  });

  it("Shift+Tab from the dialog itself goes to its last control, never the page behind", async () => {
    render(
      <>
        <button>Behind</button>
        <Dialog title="Rename" onClose={() => {}}>
          <button>Cancel</button>
          <button>Save</button>
        </Dialog>
      </>,
    );
    // On open the dialog's panel has focus.
    await userEvent.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Save" })).toHaveFocus();
  });

  it("a dialog opened over another keeps Tab to itself", async () => {
    render(
      <Dialog title="Outer" onClose={() => {}}>
        <button>Outer button</button>
        <Dialog title="Inner" onClose={() => {}}>
          <button>Keep</button>
          <button>Discard</button>
        </Dialog>
      </Dialog>,
    );
    screen.getByRole("button", { name: "Discard" }).focus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Keep" })).toHaveFocus();
  });
});
