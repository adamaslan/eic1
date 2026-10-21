// Platform-neutral design tokens. Web reads these via Tailwind classes in
// app/app.css; Expo will import this object directly.

export const color = {
  face: "#c0c0c0",
  shade: "#808080",
  ink: "#0a0a0a",
  hilite: "#dfdfdf",
  white: "#ffffff",
  navy: "#000080",
  blue2: "#1084d0",
  desk: "#008080",
  lime: "#b6f24e",
  link: "#0000cc",
} as const;

export const font = {
  ui: ["Tahoma", "MS Sans Serif", "Verdana", "sans-serif"],
  mono: ["Courier New", "monospace"],
} as const;

export const space = { 0: 0, 0.5: 2, 1: 4, 1.5: 6, 2: 8, 3: 12, 4: 16 } as const;

// A Win95 bevel is two nested 1px frames. "out" raises the surface, "in" sinks it.
export const bevel = {
  out: {
    outerTL: color.white,
    outerBR: color.ink,
    innerTL: color.hilite,
    innerBR: color.shade,
  },
  in: {
    outerTL: color.ink,
    outerBR: color.white,
    innerTL: color.shade,
    innerBR: color.hilite,
  },
} as const;

export type BevelVariant = keyof typeof bevel;
