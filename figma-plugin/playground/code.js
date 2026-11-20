// One-off development plugin: builds the Retrans Preview playground in the current Figma file and
// writes the matching sample preview file. Run it once in an empty file (Figma desktop app:
// Plugins → Development → Import plugin from manifest… → figma-plugin/playground/manifest.json).
// Not published; only the playground file it makes is.

const STRINGS = [
  { name: "product.title", en: "Linen shirt", de: "Leinenhemd" },
  { name: "cart.add", en: "Add to cart", de: "In den Warenkorb legen" },
  { name: "nav.home", en: "Home", de: "Startseite" },
  { name: "checkout.pay", en: "Pay now", de: "Jetzt kostenpflichtig bestellen" },
];

const INDIGO = { r: 0.31, g: 0.275, b: 0.898 };
const INK = { r: 0.078, g: 0.086, b: 0.122 };
const MUTED = { r: 0.357, g: 0.376, b: 0.439 };
const LINE = { r: 0.812, g: 0.827, b: 0.875 };
const SOFT = { r: 0.925, g: 0.933, b: 0.957 };
const WHITE = { r: 1, g: 1, b: 1 };

figma.showUI(__html__, { width: 400, height: 300, themeColors: true });

function frame(parent, name, x, y, w, h, fill, radius) {
  const f = figma.createFrame();
  f.name = name;
  f.x = x;
  f.y = y;
  f.resize(w, h);
  f.fills = fill ? [{ type: "SOLID", color: fill }] : [];
  f.cornerRadius = radius || 0;
  parent.appendChild(f);
  return f;
}

function rect(parent, x, y, w, h, color, radius) {
  const r = figma.createRectangle();
  r.x = x;
  r.y = y;
  r.resize(w, h);
  r.fills = [{ type: "SOLID", color }];
  r.cornerRadius = radius || 0;
  parent.appendChild(r);
  return r;
}

/** A text layer; `fixed` gives it a fixed size, so text that doesn't fit is what the plugin flags. */
function text(parent, characters, opts) {
  const t = figma.createText();
  t.fontName = { family: "Inter", style: opts.bold ? "Bold" : "Regular" };
  t.fontSize = opts.size;
  t.characters = characters;
  t.fills = [{ type: "SOLID", color: opts.color }];
  parent.appendChild(t);
  t.x = opts.x;
  t.y = opts.y;
  if (opts.fixed) {
    t.textAutoResize = "NONE";
    t.resize(opts.w, opts.h);
  } else if (opts.w) {
    t.textAutoResize = "HEIGHT";
    t.resize(opts.w, t.height);
  } else {
    t.textAutoResize = "WIDTH_AND_HEIGHT";
  }
  if (opts.center) {
    t.textAlignHorizontal = "CENTER";
    t.textAlignVertical = "CENTER";
  }
  if (opts.variable) t.setBoundVariable("characters", opts.variable);
  return t;
}

/** A fixed-size button whose label is bound to `variable`. */
function button(parent, x, y, variable, en) {
  const b = frame(parent, "Button", x, y, 248, 56, INDIGO, 14);
  text(b, en, { x: 16, y: 14, w: 216, h: 28, size: 18, bold: true, color: WHITE, fixed: true, center: true, variable });
  return b;
}

async function build() {
  await Promise.all([
    figma.loadFontAsync({ family: "Inter", style: "Regular" }),
    figma.loadFontAsync({ family: "Inter", style: "Bold" }),
  ]);

  const collection = figma.variables.createVariableCollection("Playground");
  const modeId = collection.modes[0].modeId;
  collection.renameMode(modeId, "EN");
  const vars = {};
  for (const s of STRINGS) {
    // Figma names can't contain dots; "/" makes a group, which Retrans reads back as "cart.add".
    const v = figma.variables.createVariable(s.name.replace(/\./g, "/"), collection, "STRING");
    v.setValueForMode(modeId, s.en);
    vars[s.name] = v;
  }

  const page = figma.currentPage;
  const en = (name) => STRINGS.find((s) => s.name === name).en;

  // Product card: the title can grow, the button can't.
  const card = frame(page, "Product card", 0, 0, 312, 400, WHITE, 20);
  rect(card, 24, 24, 264, 150, SOFT, 12);
  text(card, en("product.title"), { x: 24, y: 194, w: 264, size: 22, bold: true, color: INK, variable: vars["product.title"] });
  text(card, "Soft, breathable linen for warm days.", { x: 24, y: 230, w: 264, size: 15, color: MUTED });
  rect(card, 24, 290, 120, 12, LINE, 6);
  button(card, 32, 320, vars["cart.add"], en("cart.add"));

  // Checkout: a short link that fits and a long button label that doesn't.
  const checkout = frame(page, "Checkout", 360, 0, 312, 400, WHITE, 20);
  text(checkout, en("nav.home"), { x: 24, y: 24, size: 15, bold: true, color: INDIGO, variable: vars["nav.home"] });
  text(checkout, "Checkout", { x: 24, y: 56, size: 26, bold: true, color: INK });
  rect(checkout, 24, 112, 264, 48, SOFT, 10);
  rect(checkout, 24, 172, 264, 48, SOFT, 10);
  rect(checkout, 24, 240, 180, 12, LINE, 6);
  button(checkout, 32, 320, vars["checkout.pay"], en("checkout.pay"));

  const note = frame(page, "Try Retrans Preview", 0, 440, 672, 200, SOFT, 20);
  text(note, "Try Retrans Preview", { x: 24, y: 24, size: 20, bold: true, color: INK });
  text(
    note,
    "1. Plugins → Retrans Preview → Load preview file… → pick playground-de.retrans-preview.json\n" +
      "2. Select both frames → Make preview copies\n" +
      "3. The long German strings get ⚠ may overflow. Mark each one Fits or Too long.",
    { x: 24, y: 64, w: 624, size: 15, color: INK },
  );

  figma.currentPage.selection = [card, checkout];
  figma.viewport.scrollAndZoomIntoView([card, checkout, note]);

  // The sample preview file: German drafts for these exact variables. The UI adds the hashes.
  const bundle = {
    retransPreview: 1,
    sourceProjectId: "retrans-preview-playground",
    exportedAt: new Date().toISOString(),
    baseLocale: "en",
    locale: "de",
    strings: STRINGS.map((s) => ({
      key: `figma-Playground::${s.name}`,
      figmaVariableId: vars[s.name].id,
      base: s.en,
      text: s.de,
      hash: "",
      status: "translated",
      machine: true,
    })),
  };
  figma.ui.postMessage({ type: "done", bundle });
}

figma.ui.onmessage = (msg) => {
  if (msg.type === "build") {
    build().catch((err) => figma.ui.postMessage({ type: "error", message: String(err && err.message ? err.message : err) }));
  }
};
