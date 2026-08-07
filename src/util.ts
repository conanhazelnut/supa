// Small cross-platform path / fs / format helpers. Leaf module — no supa imports.
// Path building delegates to @std/path so separators are OS-native (a hand-rolled
// forward-slash join worked, but printed mixed separators in every message on
// Windows and broke UNC paths by collapsing the leading "\\").

import { dirname, isAbsolute, join as stdJoin, resolve, SEPARATOR as SEP } from "@std/path";

export const OS = Deno.build.os; // "darwin" | "linux" | "windows"

export const VERSION = "0.1.4"; // keep in sync with deno.json + CHANGELOG
export const REPO = "conanhazelnut/supa";

// User-facing docs live in the repo, which a binary install doesn't have — every
// runtime message must link the full GitHub URL, never a repo-relative path.
export const DOCS_URL = `https://github.com/${REPO}/blob/main/docs`;

export function home(): string {
  return Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
}
export function join(...parts: string[]): string {
  const filled = parts.filter((p) => p.length > 0);
  return filled.length === 0 ? "" : stdJoin(filled[0], ...filled.slice(1));
}
export function parentDir(p: string): string {
  return dirname(p);
}
export function expandTilde(p: string): string {
  if (p === "~") return home();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(home(), p.slice(2));
  return p;
}
// Strip trailing separators except at a filesystem root (`/` or `C:\`).
function stripTrailingSep(p: string): string {
  if (p.length <= 1) return p;
  // Windows drive root: `C:\` must keep its separator.
  if (OS === "windows" && /^[A-Za-z]:[\\/]$/.test(p)) return p;
  let out = p;
  while (out.length > 1 && (out.endsWith("/") || out.endsWith("\\"))) {
    out = out.slice(0, -1);
  }
  return out;
}
// Expand ~ then make absolute against cwd. Registry entries must survive a later
// `supa` invocation from a different working directory. Trailing separators are
// stripped so `park ~/code` and `unpark ~/code/` resolve to the same entry.
export function absolutize(p: string): string {
  const expanded = expandTilde(p);
  if (expanded === "") return expanded;
  const abs = isAbsolute(expanded) ? expanded : join(Deno.cwd(), expanded);
  return stripTrailingSep(abs);
}
// Path identity for registry roots — Windows paths are case-insensitive.
export function pathsEqual(a: string, b: string): boolean {
  return OS === "windows" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
export function pathIsAbsolute(p: string): boolean {
  return isAbsolute(p);
}
// Resolve `relPath` under `baseDir`, refusing absolute/~ paths and any result
// that escapes the base (e.g. `../../.ssh/id_rsa`). Returns null when unsafe.
// Used by `rotate` so a hostile signing_keys_path cannot write outside supabase/.
export function resolveUnder(baseDir: string, relPath: string): string | null {
  const stripped = relPath.replace(/^\.\//, "").replace(/^\.\\/, "");
  if (stripped === "") return null;
  const expanded = expandTilde(stripped);
  if (expanded === "" || isAbsolute(expanded)) return null;
  const base = resolve(baseDir);
  const target = resolve(base, expanded);
  if (target === base) return null;
  const prefix = base.endsWith(SEP) ? base : base + SEP;
  if (!target.startsWith(prefix)) return null;
  return target;
}
// Decode file bytes to text, honouring a UTF-16 BOM. Windows PowerShell 5.1's
// `>` / Out-File write UTF-16LE by default, and decoding that as UTF-8 turns a
// hand-made registry/config into NUL-riddled garbage that parses as nothing.
// UTF-8 (with or without BOM) stays the default everywhere else.
export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  }
  return new TextDecoder().decode(bytes);
}
// Drop-in for Deno.readTextFileSync wherever the file may be user-authored.
export function readTextFile(p: string): string {
  return decodeText(Deno.readFileSync(p));
}
export function isFile(p: string): boolean {
  try {
    return Deno.statSync(p).isFile;
  } catch {
    return false;
  }
}
export function isDir(p: string): boolean {
  try {
    return Deno.statSync(p).isDirectory;
  } catch {
    return false;
  }
}
export function die(msg: string): never {
  console.error(`supa: ${msg}`);
  Deno.exit(1);
}
// Escape a string for safe interpolation into a RegExp.
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
// Parse a docker MemUsage value ("120MiB", "7.6GiB", …) into MiB.
export function memToMiB(s: string): number {
  const m = s.trim().match(/^([\d.]+)\s*([KMGT]?i?B)$/i);
  if (!m) return 0;
  const mult: Record<string, number> = {
    B: 1 / (1024 * 1024),
    KB: 1 / 1024,
    KIB: 1 / 1024,
    MB: 1,
    MIB: 1,
    GB: 1024,
    GIB: 1024,
    TB: 1024 * 1024,
    TIB: 1024 * 1024,
  };
  return parseFloat(m[1]) * (mult[m[2].toUpperCase()] ?? 1);
}
export function fmtMiB(mib: number): string {
  return mib >= 1024 ? `${(mib / 1024).toFixed(1)}GiB` : `${Math.round(mib)}MiB`;
}
export function maskSecret(key: string, val: string): string {
  if (/KEY|SECRET|TOKEN|PASSWORD|JWT/i.test(key) && val.length > 10) {
    return `${val.slice(0, 4)}…${val.slice(-4)}`;
  }
  return val;
}
