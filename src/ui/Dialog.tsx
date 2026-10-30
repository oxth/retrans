import type { ReactNode } from "react";

/** Minimal modal: backdrop + labelled dialog. Escape closes via the onClose handler. */
export function Dialog({ title, onClose, children, wide }: { title: string; onClose?: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div
      role="dialog"
      aria-label={title}
      aria-modal="true"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/30"
      onKeyDown={(e) => {
        if (e.key === "Escape" && onClose) onClose();
      }}
    >
      <div className={`max-h-[90vh] overflow-auto rounded-xl bg-white p-6 shadow-xl ${wide ? "w-[40rem]" : "w-96"}`}>
        <h2 className="mb-3 text-base font-semibold">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export const btnPrimary = "rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50";
export const btnGhost = "rounded-md px-3 py-1.5 text-sm hover:bg-gray-100";
export const inputCls = "w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm";
