// Small cross-platform path / fs / format helpers. Leaf module — no supa imports.
// Forward slashes work on every OS in Deno.

export const OS = Deno.build.os; // "darwin" | "linux" | "windows"

export function home(): string {
  return Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
}
export function join(...parts: string[]): string {
  return parts.filter((p) => p.length > 0).join("/").replace(/\/{2,}/g, "/");
}
export function parentDir(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i <= 0 ? "." : norm.slice(0, i);
}
export function expandTilde(p: string): string {
  if (p === "~") return home();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(home(), p.slice(2));
  return p;
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
