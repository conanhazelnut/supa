// supa's own state: config-dir resolution, the registry (name -> path), the
// key=value config (max_active / ram_budget), and deriving a project's docker
// label + ports + free slot from its supabase/config.toml.
import {
  die,
  DOCS_URL,
  expandTilde,
  home,
  isDir,
  isFile,
  join,
  OS,
  parentDir,
  readTextFile,
} from "./util.ts";
import {
  type Hooks,
  type Limits,
  parseEnvMap,
  parseHooks,
  parseLabel,
  parseLimits,
  parsePort,
  parseRegistry,
  type Project,
  rebandText,
} from "./parse.ts";

export type { Hooks, Limits, Project };

// ---------- config-dir resolution ---------------------------------------------
export function configDir(): string {
  const explicit = Deno.env.get("SUPA_HOME");
  if (explicit) return explicit;
  const xdg = Deno.env.get("XDG_CONFIG_HOME");
  if (xdg) return join(xdg, "supa");
  if (OS === "windows") {
    const appdata = Deno.env.get("APPDATA");
    if (appdata) return join(appdata, "supa");
  }
  return join(home(), ".config", "supa");
}
export function registryPath(): string {
  return Deno.env.get("SUPA_REGISTRY") || join(configDir(), "supa.registry");
}
export function configPath(): string {
  return Deno.env.get("SUPA_CONFIG") || join(configDir(), "supa.config");
}

// ---------- registry ----------------------------------------------------------
// Explicit entries (`name|path`) are listed as-is. A parked line (`*|dir`) is
// opt-in auto-discovery: every immediate subdir of `dir` that contains a
// supabase/config.toml becomes a project named after the subdir. Explicit
// entries always win over discovered ones; non-Supabase subdirs are ignored.
export function readRegistry(): Project[] {
  const path = registryPath();
  if (!isFile(path)) {
    die(
      `registry not found: ${path}\n` +
        `  create it (one "name|~/path/to/repo" per line), or set SUPA_HOME / SUPA_REGISTRY.\n` +
        `  guide: ${DOCS_URL}/SUPA.md`,
    );
  }
  const entries = parseRegistry(readTextFile(path));
  const out = entries.filter((e) => e.name !== "*");
  const seen = new Set(out.map((e) => e.name));
  for (const e of entries) {
    if (e.name !== "*") continue;
    let subs: Deno.DirEntry[];
    try {
      subs = [...Deno.readDirSync(e.root)];
    } catch {
      continue;
    }
    subs.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const s of subs) {
      if (!s.isDirectory || seen.has(s.name) || !/^[A-Za-z0-9._-]+$/.test(s.name)) continue;
      const root = join(e.root, s.name);
      if (!isFile(join(root, "supabase", "config.toml"))) continue;
      seen.add(s.name);
      out.push({ name: s.name, root });
    }
  }
  return out;
}
// Parked directories (`*|dir` lines) as written in the registry.
export function parkedDirs(): string[] {
  const path = registryPath();
  if (!isFile(path)) return [];
  return parseRegistry(readTextFile(path)).filter((e) => e.name === "*").map((e) => e.root);
}
export function names(): string[] {
  return readRegistry().map((p) => p.name);
}
export function rootOf(name: string): string | null {
  return readRegistry().find((p) => p.name === name)?.root ?? null;
}

// ---------- config.toml resolution (root, or apps/<x>/, or examples/<x>/) ------
export function cfgDir(name: string): string | null {
  const root = rootOf(name);
  if (!root) return null;
  if (isFile(join(root, "supabase", "config.toml"))) return root;
  for (const sub of ["apps", "examples"]) {
    const base = join(root, sub);
    if (!isDir(base)) continue;
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(base)];
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1)); // deterministic first-match
    for (const e of entries) {
      if (!e.isDirectory) continue;
      const d = join(base, e.name);
      if (isFile(join(d, "supabase", "config.toml"))) return d;
    }
  }
  return null;
}
export function cfgFile(name: string): string | null {
  const wd = cfgDir(name);
  return wd ? join(wd, "supabase", "config.toml") : null;
}
export function labelOf(name: string): string | null {
  const f = cfgFile(name);
  if (!f || !isFile(f)) return null;
  return parseLabel(readTextFile(f));
}
export function portOf(name: string, section: string): string | null {
  const f = cfgFile(name);
  if (!f || !isFile(f)) return null;
  return parsePort(readTextFile(f), section);
}

// ---------- persisted config (key = value store) ------------------------------
export function readConfigKV(): Record<string, string> {
  const kv: Record<string, string> = {};
  const path = configPath();
  if (isFile(path)) {
    for (const line of readTextFile(path).split(/\r?\n/)) {
      if (line.trim().startsWith("#")) continue;
      const m = line.match(/^\s*([a-z_]+)\s*=\s*(.*?)\s*$/);
      if (m) kv[m[1]] = m[2];
    }
  }
  return kv;
}
export function setConfigKey(key: string, val: string): void {
  const kv = readConfigKV();
  kv[key] = val;
  const path = configPath();
  try {
    Deno.mkdirSync(parentDir(path), { recursive: true });
  } catch { /* exists */ }
  const lines = [
    "# supa config — written by `supa config`",
    "# max_active: how many stacks may run at once (default 1).",
    "# ram_budget_gb: warn when total running-stack RAM exceeds this (optional).",
    "# backup_dir: where `supa backup` writes dumps (default <project>/backups/).",
    "# Per-shell overrides: SUPA_MAX_ACTIVE, SUPA_RAM_BUDGET, SUPA_BACKUP_DIR, SUPA_ALLOW_MULTI=1.",
  ];
  for (const [k, v] of Object.entries(kv)) lines.push(`${k} = ${v}`);
  Deno.writeTextFileSync(path, lines.join("\n") + "\n");
  console.log(`supa: set ${key} = ${val}  (${path})`);
}
export function readMaxActive(): { value: number; source: string } {
  if (Deno.env.get("SUPA_ALLOW_MULTI") === "1") {
    return { value: Infinity, source: "SUPA_ALLOW_MULTI=1" };
  }
  const env = Deno.env.get("SUPA_MAX_ACTIVE");
  if (env !== undefined && env !== "") {
    const n = Number(env);
    if (Number.isInteger(n) && n >= 1) return { value: n, source: "SUPA_MAX_ACTIVE env" };
    die(`invalid SUPA_MAX_ACTIVE='${env}' (must be an integer >= 1)`);
  }
  const n = Number(readConfigKV().max_active);
  if (Number.isInteger(n) && n >= 1) return { value: n, source: "supa.config" };
  return { value: 1, source: "default" };
}
export function readRamBudget(): number | null {
  const env = Deno.env.get("SUPA_RAM_BUDGET");
  if (env) {
    const n = Number(env);
    if (n > 0) return n;
  }
  const n = Number(readConfigKV().ram_budget_gb);
  return n > 0 ? n : null;
}
export function readBackupDir(): string | null {
  const env = Deno.env.get("SUPA_BACKUP_DIR");
  if (env && env.trim() !== "") return expandTilde(env.trim());
  const cfg = readConfigKV().backup_dir;
  return cfg && cfg.trim() !== "" ? expandTilde(cfg.trim()) : null;
}

// ---------- slots / port re-banding -------------------------------------------
export function slotOf(name: string): string | null {
  const m = (portOf(name, "api") ?? "").match(/^543(\d)\d$/);
  return m ? m[1] : null;
}
export function nextFreeSlot(): string | null {
  const used = new Set(names().map(slotOf).filter((s): s is string => s !== null));
  for (let d = 1; d <= 9; d++) if (!used.has(String(d))) return String(d);
  return null;
}
export function readEnvMap(cfgDirPath: string): Array<{ app: string; native: string }> {
  const mapPath = join(cfgDirPath, "supa.env.map");
  if (!isFile(mapPath)) return [];
  return parseEnvMap(readTextFile(mapPath));
}
export function readHooks(cfgDirPath: string): Hooks {
  const p = join(cfgDirPath, "supa.hooks");
  return isFile(p) ? parseHooks(readTextFile(p)) : {};
}
export function readLimits(cfgDirPath: string): Limits {
  const p = join(cfgDirPath, "supa.limits");
  return isFile(p) ? parseLimits(readTextFile(p)) : {};
}
export function rebandConfig(f: string, slot: string): string[] {
  const src = readTextFile(f);
  const { text, changes } = rebandText(src, slot);
  if (changes.length) {
    Deno.writeTextFileSync(`${f}.bak`, src);
    Deno.writeTextFileSync(f, text);
  }
  return changes;
}
