/**
 * Design tokens — mirrors the Railglide website (src/app/globals.css).
 *
 * Light, warm and restrained: off-white base, ink text, one confident coral
 * accent, ink primary buttons. Every screen reads from here, so this file is
 * the single source of the app's look.
 */
export const theme = {
  colors: {
    // surfaces
    bg: "#F8F6F1", // warm off-white
    bgSoft: "#F1EEE7",
    surface: "#FFFFFF", // elevated cards
    sunk: "#EEEAE1",

    // text
    text: "#14120E", // ink
    textSoft: "#2D2A22",
    muted: "#6E6A5E",
    faint: "#989385",

    // one accent — warm coral
    accent: "#D9694A",
    accentFg: "#FFFFFF",
    accentSoft: "rgba(217, 105, 74, 0.10)",
    accentLine: "rgba(217, 105, 74, 0.30)",

    // hairlines
    border: "rgba(20, 18, 14, 0.10)",
    border2: "rgba(20, 18, 14, 0.16)",

    // primary button — confident dark ink
    btnBg: "#14120E",
    btnFg: "#F8F6F1",

    // status — desaturated
    ok: "#2F7A4F",
    okSoft: "rgba(47, 122, 79, 0.10)",
    pend: "#B26A1A",
    err: "#B23A2A",
    errSoft: "rgba(178, 58, 42, 0.10)",
  },
  // The Buy/Sell redesign's palette — the same values as the website's
  // Tailwind @theme (apps/web/src/app/globals.css). Used by components/kit.tsx.
  flow: {
    page: "#F5F3EE",
    card: "#FFFFFF",
    edge: "#E6E2D9",
    edgeSoft: "#EFEBE3",
    muted: "#5F5C55",
    ink: "#17171A",
    inkSoft: "#4A4842",
    success: "#1F8A55",
    successBg: "#EEF6F1",
    successEdge: "#BFDCCB",
    successInk: "#134A30",
    danger: "#B42318",
    warnBg: "#FFF4E5",
    warnInk: "#5A3A0A",
    warnStrong: "#3D2706",
    pill: "#F7F5F0",
    subtle: "#FBFAF7",
    chip: "#F1EDE4",
    stepLine: "#DCD7CC",
    stepRing: "#CFC9BD",
    disabled: "#E7E3DA",
    placeholder: "#B3AEA4",
  },
  radius: {
    input: 10,
    card: 16,
    cardLg: 20,
    button: 16,
    field: 14,
    pill: 999,
  },
  // One soft elevation, as the website's tokens prescribe.
  shadow: {
    shadowColor: "#14120E",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.06,
    shadowRadius: 20,
    elevation: 2,
  },
  /** Editorial display face — loaded in App.tsx (Instrument Serif, the site's). */
  serif: "InstrumentSerif_400Regular",
  spacing: (n: number) => n * 8,
} as const;

/**
 * One knob for the size of the Buy/Sell screens (text, fields, buttons, gaps).
 * 1 = the website's sizes; 0.8 = 20% smaller. Change it here to try others.
 */
export const FLOW_ZOOM = 0.8;

/** A size scaled by FLOW_ZOOM. */
export const z = (n: number) => Math.round(n * FLOW_ZOOM * 2) / 2;

/** A font size scaled by FLOW_ZOOM, never below 11 so text stays readable. */
export const zf = (n: number) => Math.max(11, Math.round(n * FLOW_ZOOM));
