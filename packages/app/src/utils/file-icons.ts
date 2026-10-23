import { toPosixPath } from "@codent/core";
import { fromPath, icons } from "@m234/nerd-fonts";

import { COLORS } from "../theme/colors.js";

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".svg",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".bz2",
  ".7z",
  ".rar",
  ".mp3",
  ".mp4",
  ".wav",
  ".woff",
  ".woff2",
  ".ttf",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".wasm",
]);

/** Seti / VS Code–inspired colors for text-badge fallback. */
const EXT_STYLES: Record<string, { glyph: string; color: string }> = {
  ts: { glyph: "TS", color: "#3178C6" },
  tsx: { glyph: "TS", color: "#3178C6" },
  mts: { glyph: "TS", color: "#3178C6" },
  cts: { glyph: "TS", color: "#3178C6" },
  js: { glyph: "JS", color: "#F1E05A" },
  jsx: { glyph: "JS", color: "#F1E05A" },
  mjs: { glyph: "JS", color: "#F1E05A" },
  cjs: { glyph: "JS", color: "#F1E05A" },
  json: { glyph: "{}", color: "#CBCB41" },
  jsonc: { glyph: "{}", color: "#CBCB41" },
  md: { glyph: "MD", color: "#519ABA" },
  mdx: { glyph: "MD", color: "#519ABA" },
  css: { glyph: "CSS", color: "#563D7C" },
  scss: { glyph: "SCSS", color: "#C6538C" },
  sass: { glyph: "SASS", color: "#C6538C" },
  less: { glyph: "LESS", color: "#563D7C" },
  html: { glyph: "HTML", color: "#E34C26" },
  htm: { glyph: "HTML", color: "#E34C26" },
  vue: { glyph: "VUE", color: "#41B883" },
  svelte: { glyph: "SVEL", color: "#FF3E00" },
  yaml: { glyph: "YAML", color: "#854F9C" },
  yml: { glyph: "YAML", color: "#854F9C" },
  toml: { glyph: "TOML", color: "#854F9C" },
  py: { glyph: "PY", color: "#3572A5" },
  rs: { glyph: "RS", color: "#DEA584" },
  go: { glyph: "GO", color: "#00ADD8" },
  java: { glyph: "JAVA", color: "#B07219" },
  kt: { glyph: "KT", color: "#A97BFF" },
  rb: { glyph: "RB", color: "#701516" },
  php: { glyph: "PHP", color: "#4F5D95" },
  sh: { glyph: "SH", color: "#89E051" },
  bash: { glyph: "SH", color: "#89E051" },
  zsh: { glyph: "SH", color: "#89E051" },
  sql: { glyph: "SQL", color: "#E38C00" },
  xml: { glyph: "XML", color: "#E37933" },
  svg: { glyph: "SVG", color: "#FFB13B" },
  png: { glyph: "IMG", color: "#A074C4" },
  jpg: { glyph: "IMG", color: "#A074C4" },
  jpeg: { glyph: "IMG", color: "#A074C4" },
  gif: { glyph: "IMG", color: "#A074C4" },
  webp: { glyph: "IMG", color: "#A074C4" },
  pdf: { glyph: "PDF", color: "#E44D26" },
  lock: { glyph: "LOCK", color: COLORS.muted },
  env: { glyph: "ENV", color: "#ECD53F" },
  gitignore: { glyph: "GIT", color: "#F05032" },
  dockerfile: { glyph: "DKR", color: "#2496ED" },
};

const BASENAME_STYLES: Record<string, { glyph: string; color: string }> = {
  "package.json": { glyph: "PKG", color: "#CB3837" },
  "pnpm-lock.yaml": { glyph: "LOCK", color: "#F69220" },
  "package-lock.json": { glyph: "LOCK", color: "#CB3837" },
  dockerfile: { glyph: "DKR", color: "#2496ED" },
  makefile: { glyph: "MK", color: "#6D8086" },
  "readme.md": { glyph: "MD", color: "#519ABA" },
  "agents.md": { glyph: "MD", color: "#519ABA" },
  "claude.md": { glyph: "MD", color: "#519ABA" },
  ".gitignore": { glyph: "GIT", color: "#F05032" },
  ".env": { glyph: "ENV", color: "#ECD53F" },
  ".env.example": { glyph: "ENV", color: "#ECD53F" },
  "tsconfig.json": { glyph: "TS", color: "#3178C6" },
  "eslint.config.cjs": { glyph: "LINT", color: "#4B32C3" },
  "eslint.config.js": { glyph: "LINT", color: "#4B32C3" },
};

export type FileIconStyle = {
  glyph: string;
  color: string;
  /** True when glyph is a Seti nerd-font character (single column). */
  nerd?: boolean;
};

export type FolderIconStyle = {
  chevron: string;
  glyph: string;
  color: string;
  /** True when glyph is a nerd-font character (single column). */
  nerd?: boolean;
};

export type FileIconOptions = {
  /** Override `MY_AGENT_NERD_ICONS` for this lookup. */
  nerdIcons?: boolean;
};

let nerdIconsOverride: boolean | undefined;

/** Test hook — reset with `undefined` after tests. */
export function setNerdIconsEnabledForTesting(enabled: boolean | undefined): void {
  nerdIconsOverride = enabled;
}

export function isNerdIconsEnabled(): boolean {
  if (nerdIconsOverride !== undefined) return nerdIconsOverride;

  const env = typeof process !== "undefined" ? process.env.MY_AGENT_NERD_ICONS : undefined;
  if (env === "0" || env === "false") return false;
  if (env === "1" || env === "true") return true;
  return true;
}

export function isLikelyBinaryPath(filePath: string): boolean {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return false;
  return BINARY_EXTENSIONS.has(filePath.slice(dot).toLowerCase());
}

/**
 * Extensions the workspace preview can actually decode.
 *
 * Deliberately narrower than {@link BINARY_EXTENSIONS}: attempting a preview on bytes the host's
 * decoder cannot read costs a file read and, worse, renders as "no preview" for no visible reason.
 * `sharp` reads these five (an animated GIF yields its first frame). `.ico` is excluded on purpose
 * (no `sharp` support) and `.svg` because it is text a diff can still show.
 */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

export function isImagePath(filePath: string): boolean {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return false;
  return IMAGE_EXTENSIONS.has(filePath.slice(dot).toLowerCase());
}

function extensionOf(filePath: string): string {
  const base = filePath.split("/").pop() || filePath;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

function basenameOf(filePath: string): string {
  return pathBase(filePath).toLowerCase();
}

/** Last path segment with original casing (Seti base map keys are case-sensitive). */
function pathBase(filePath: string): string {
  const normalized = toPosixPath(filePath);
  return normalized.split("/").pop() || normalized;
}

/**
 * ParsedPath-shaped value so {@link fromPath} never calls `node:path.parse`.
 * Vite externalizes `node:path` in browser extension builds.
 */
function toNerdPathArg(filePath: string): { root: string; dir: string; base: string; name: string; ext: string } {
  const base = pathBase(filePath);
  const dot = base.includes(".") ? base.lastIndexOf(".") : -1;
  const ext = dot > 0 ? base.slice(dot) : "";
  const name = dot > 0 ? base.slice(0, dot) : base;
  return { root: "", dir: "", base, name, ext };
}

function getTextBadgeStyle(filePath: string): FileIconStyle {
  const base = basenameOf(filePath);
  const byName = BASENAME_STYLES[base];
  if (byName) return byName;

  const ext = extensionOf(filePath);
  if (ext) {
    const byExt = EXT_STYLES[ext];
    if (byExt) return byExt;
    return {
      glyph: ext.slice(0, 4).toUpperCase(),
      color: COLORS.muted,
    };
  }

  return { glyph: "FILE", color: COLORS.muted };
}

function getNerdFileIconStyle(filePath: string): FileIconStyle | null {
  try {
    const icon = fromPath(toNerdPathArg(filePath), "seti");
    if (!icon.value) return null;

    const fallback = getTextBadgeStyle(filePath);
    return {
      glyph: icon.value,
      color: icon.color ?? fallback.color,
      nerd: true,
    };
  } catch {
    return null;
  }
}

/** Seti nerd-font icon when enabled, otherwise colored text badge fallback. */
export function getFileIconStyle(filePath: string, options?: FileIconOptions): FileIconStyle {
  const useNerd = options?.nerdIcons ?? isNerdIconsEnabled();
  if (useNerd) {
    const nerd = getNerdFileIconStyle(filePath);
    if (nerd) return nerd;
  }
  return getTextBadgeStyle(filePath);
}

/** Layout helper: nerd glyphs are single-width; badges use a fixed 4-column field. */
export function formatIconGlyph(style: FileIconStyle): string {
  return style.nerd ? `${style.glyph} ` : style.glyph.padEnd(4);
}

const FOLDER_CLOSED_COLOR = "#CBCB41";
const FOLDER_OPEN_COLOR = COLORS.primary;

function getTextFolderStyle(expanded: boolean): FolderIconStyle {
  return {
    chevron: expanded ? "▾" : "▸",
    glyph: expanded ? "DIR-" : "DIR+",
    color: expanded ? FOLDER_OPEN_COLOR : COLORS.muted,
  };
}

function getNerdFolderStyle(name: string, expanded: boolean): FolderIconStyle {
  let icon = expanded ? icons["nf-md-folder_open"] : icons["nf-md-folder"];
  let color = expanded ? FOLDER_OPEN_COLOR : FOLDER_CLOSED_COLOR;

  if (name === ".git") {
    icon = icons["nf-seti-git_folder"];
    color = "#F05032";
  } else if (name === "node_modules") {
    color = COLORS.muted;
  }

  return {
    chevron: expanded ? "▾" : "▸",
    glyph: icon.value,
    color,
    nerd: true,
  };
}

/** Chevron + folder icon for tree directories (open/closed variants). */
export function getFolderIconStyle(expanded: boolean, folderName = "", options?: FileIconOptions): FolderIconStyle {
  const useNerd = options?.nerdIcons ?? isNerdIconsEnabled();
  if (useNerd) return getNerdFolderStyle(folderName, expanded);
  return getTextFolderStyle(expanded);
}

/** Layout helper for directory rows: chevron plus icon field aligned with file badges. */
export function formatFolderGlyph(style: FolderIconStyle): string {
  return style.nerd ? `${style.glyph} ` : style.glyph.padEnd(4);
}

/** @deprecated Use {@link getFileIconStyle} for colored badges. */
export function getFileIcon(filePath: string): string {
  return getFileIconStyle(filePath).glyph;
}
