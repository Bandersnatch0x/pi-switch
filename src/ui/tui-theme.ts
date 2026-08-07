/**
 * Shared TUI theme tokens and ANSI helpers for pi-switch UI surfaces.
 *
 * Keep this file dependency-light: it may be imported by UI modules that run
 * inside custom TUI renderers as well as plain notify/report formatters.
 */

export const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",

  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",

  brightBlack: "\x1b[90m",
  brightRed: "\x1b[91m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightBlue: "\x1b[94m",
  brightMagenta: "\x1b[95m",
  brightCyan: "\x1b[96m",
  brightWhite: "\x1b[97m",
} as const;

export type AnsiKey = keyof typeof ANSI;

/** Semantic glyphs used across pickers and reports. */
export const GLYPH = {
  cursor: "›",
  cursorHeavy: "❯",
  pin: "★",
  override: "⚙",
  active: "●",
  blocked: "✕",
  fix: "→",
  info: "→",
  bullet: "·",
  arrow: "›",
} as const;

/** Wrap text with an ANSI sequence and auto-reset. */
export function paint(key: AnsiKey, text: string): string {
  return `${ANSI[key]}${text}${ANSI.reset}`;
}

export function bold(text: string): string {
  return paint("bold", text);
}

export function dim(text: string): string {
  return paint("dim", text);
}

/** Status colors aligned with the design system ramps. */
export const STATUS_COLOR = {
  pass: "green" as AnsiKey,
  warn: "yellow" as AnsiKey,
  fail: "red" as AnsiKey,
  info: "blue" as AnsiKey,
};

export type StatusKey = "pass" | "warn" | "fail" | "info";

/** Render a filled-badge style label like [PASS] with semantic color. */
export function statusBadge(status: StatusKey, text?: string): string {
  const label = text ?? status.toUpperCase();
  return paint(STATUS_COLOR[status], `[${label}]`);
}

/** Render a compact status dot/label pair. */
export function statusLabel(status: StatusKey, label?: string): string {
  const word = label ?? status.toUpperCase();
  const color = STATUS_COLOR[status];
  return `${paint(color, "●")} ${paint(color, word)}`;
}

/** Highlight the "currently active" item using the accent slot. */
export function activeHighlight(text: string, accentColor: AnsiKey = "cyan"): string {
  return paint(accentColor, `${GLYPH.active} ${text}`);
}

/** Format a key hint consistently with the rest of the TUI. */
export function keyHint(key: string, description: string): string {
  return `${dim(key)} ${dim(description)}`;
}

/** Re-export legacy yellow helper so existing callers keep compiling. */
export function yellowHighlight(text: string): string {
  return paint("yellow", text);
}
