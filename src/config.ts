// supa's own state: config-dir resolution, the registry (name -> path), the
// key=value config (max_active / ram_budget), and deriving a project's docker
// label + ports + free slot from its supabase/config.toml.
import {
  absolutize,
  die,
  DOCS_URL,
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
  SAFE_NAME,
} from "./parse.ts";

export type { Hooks, Limits, Project };

// ---------- config-dir resolution ---------------------------------------------
// Env overrides are absolutized (incl. ~) so a quoted `SUPA_HOME='~/…'` is not
// taken literally. Relative env values still resolve against *this* process's
// cwd (prefer an absolute or ~/ path if you need a stable location).
export function configDir(): string {
  const explicit = Deno.env.get("SUPA_HOME");
  if (explicit) return absolutize(explicit);
  const xdg = Deno.env.get("XDG_CONFIG_HOME");
  if (xdg) return join(absolutize(xdg), "supa");
  if (OS === "windows") {
    const appdata = Deno.env.get("APPDATA");
    if (appdata) return join(absolutize(appdata), "supa");
  }
  return join(home(), ".config", "supa");
}
export function registryPath(): string {
  const env = Deno.env.get("SUPA_REGISTRY");
  return env ? absolutize(env) : join(configDir(), "supa.registry");
}
export function configPath(): string {
  const env = Deno.env.get("SUPA_CONFIG");
  return env ? absolutize(env) : join(configDir(), "supa.config");
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
  // Explicit entries: first occurrence wins (duplicate hand-edited lines ignored).
  const out: Project[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (e.name === "*") continue;
    if (seen.has(e.name)) continue;
    seen.add(e.name);
    out.push(e);
  }
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
      if (!s.isDirectory || seen.has(s.name) || !SAFE_NAME.test(s.name)) continue;
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
// True when an explicit `name|path` line exists (park discoveries do not count).
export function hasExplicitEntry(name: string): boolean {
  const path = registryPath();
  if (!isFile(path)) return false;
  return parseRegistry(readTextFile(path)).some((e) => e.name === name);
}
export function rootOf(name: string): string | null {
  return readRegistry().find((p) => p.name === name)?.root ?? null;
}

// ---------- config.toml resolution (root, or apps/<x>/, or examples/<x>/) ------
// Every supabase/config.toml under a project root that cfgDir could pick. Root
// wins; otherwise apps/* then examples/*, alphabetical within each. Multiple
// hits mean silent wrong-stack binding risk — doctor warns.
export function cfgCandidates(root: string): string[] {
  const out: string[] = [];
  if (isFile(join(root, "supabase", "config.toml"))) out.push(root);
  for (const sub of ["apps", "examples"]) {
    const base = join(root, sub);
    if (!isDir(base)) continue;
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(base)];
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      if (!e.isDirectory) continue;
      const d = join(base, e.name);
      if (isFile(join(d, "supabase", "config.toml"))) out.push(d);
    }
  }
  return out;
}
export function cfgDir(name: string): string | null {
  const root = rootOf(name);
  if (!root) return null;
  return cfgCandidates(root)[0] ?? null;
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
      if (m) {
        // Strip an unquoted trailing `# comment` so `max_active = 2 # twin`
        // does not become Number("2 # twin") → NaN → silent default.
        kv[m[1]] = m[2].replace(/\s+#.*$/, "").trim();
      }
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
  if (env && env.trim() !== "") return absolutize(env.trim());
  const cfg = readConfigKV().backup_dir;
  return cfg && cfg.trim() !== "" ? absolutize(cfg.trim()) : null;
}

// ---------- slots / port re-banding -------------------------------------------
export function slotOf(name: string): string | null {
  const m = (portOf(name, "api") ?? "").match(/^543(\d)\d$/);
  return m ? m[1] : null;
}
// alsoTaken: bands held by containers outside supa (see foreignSlots) — a project
// put there would fight another service for the port.
// exceptName: when re-banding / auto-picking for one project, ignore its current
// slot so `supa ports web` can keep an exclusive band (and not false-refuse when
// 1–9 are otherwise full).
export function nextFreeSlot(
  alsoTaken: Set<string> = new Set(),
  exceptName?: string,
): string | null {
  const used = new Set(
    names()
      .filter((n) => n !== exceptName)
      .map(slotOf)
      .filter((s): s is string => s !== null),
  );
  // Prefer the project's current band when it is free of foreign/other clash.
  if (exceptName) {
    const cur = slotOf(exceptName);
    if (cur && cur !== "0" && !used.has(cur) && !alsoTaken.has(cur)) return cur;
  }
  for (let d = 1; d <= 9; d++) {
    const s = String(d);
    if (!used.has(s) && !alsoTaken.has(s)) return s;
  }
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
