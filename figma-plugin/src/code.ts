// Spike: log the variable bound to each text layer in the selection.
figma.showUI(__html__, { width: 360, height: 520, themeColors: true });

function logBound(node: SceneNode): void {
  if (node.type === "TEXT") console.log("[retrans]", node.name, node.boundVariables?.characters?.id ?? "(none)");
  if ("children" in node) for (const c of node.children) logBound(c);
}

figma.ui.onmessage = (msg: { type: string }) => {
  if (msg.type === "make-copies") for (const n of figma.currentPage.selection) logBound(n);
};
