#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-run
// Copyright 2026 conanhazelnut — SPDX-License-Identifier: Apache-2.0
/**
 * supa — cross-platform manager for local Supabase stacks (one per project).
 *
 * Single TypeScript source, compiled to native binaries with `deno compile`
 * (see build.sh): `supa` (macOS/Linux) and `supa.exe` (Windows). No runtime
 * dependency for the person running it — Docker + the Supabase CLI aside, which
 * every mode needs because supa is a thin coordinator, not a container runtime.
 *
 * Config lives in SUPA_HOME (default ~/.config/supa, or %APPDATA%\supa on
 * Windows): `supa.registry` (name|path per project) and `supa.config`
 * (max_active). Everything else — docker label, live ports — is derived from
 * each project's supabase/config.toml, so nothing here can drift.
 *
 * Full guide: SUPA.md
 */

const OS = Deno.build.os; // "darwin" | "linux" | "windows"
const VERSION = "0.1.0"; // keep in sync with deno.json + CHANGELOG

// ---------- path & fs helpers (forward slashes work on every OS in Deno) ------
function home(): string {
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
function isFile(p: string): boolean {
  try {
    return Deno.statSync(p).isFile;
  } catch {
    return false;
  }
}
function isDir(p: string): boolean {
  try {
    return Deno.statSync(p).isDirectory;
  } catch {
    return false;
  }
}

function die(msg: string): never {
  console.error(`supa: ${msg}`);
  Deno.exit(1);
}

// ---------- config locations --------------------------------------------------
function configDir(): string {
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
function registryPath(): string {
  return Deno.env.get("SUPA_REGISTRY") || join(configDir(), "supa.registry");
}
function configPath(): string {
  return Deno.env.get("SUPA_CONFIG") || join(configDir(), "supa.config");
}

// ---------- registry (name -> project root) -----------------------------------
interface Project {
  name: string;
  root: string;
}

// Pure: parse registry text into projects (skips comments/blank/malformed lines,
// expands a leading ~). Exported for tests.
export function parseRegistry(text: string): Project[] {
  const out: Project[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const i = line.indexOf("|");
    if (i < 1) continue; // no pipe, or empty name -> malformed, skip
    const name = line.slice(0, i).trim();
    if (name === "") continue;
    out.push({ name, root: expandTilde(line.slice(i + 1).trim()) });
  }
  return out;
}
function readRegistry(): Project[] {
  const path = registryPath();
  if (!isFile(path)) {
    die(
      `registry not found: ${path}\n` +
        `  create it (one "name|~/path/to/repo" per line), or set SUPA_HOME / SUPA_REGISTRY. See SUPA.md`,
    );
  }
  return parseRegistry(Deno.readTextFileSync(path));
}
function names(): string[] {
  return readRegistry().map((p) => p.name);
}
function rootOf(name: string): string | null {
  return readRegistry().find((p) => p.name === name)?.root ?? null;
}

// ---------- config.toml resolution (root, or apps/<x>/, or examples/<x>/) ------
function cfgDir(name: string): string | null {
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
function cfgFile(name: string): string | null {
  const wd = cfgDir(name);
  return wd ? join(wd, "supabase", "config.toml") : null;
}
// Pure: read project_id from config.toml text. Exported for tests.
export function parseLabel(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*project_id\s*=\s*"?([^"\s]+)"?/);
    if (m) return m[1];
  }
  return null;
}
// Escape a string for safe interpolation into a RegExp.
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
// Pure: read the host `port` under `[section]` from config.toml text. Tests.
export function parsePort(text: string, section: string): string | null {
  const secRe = new RegExp(`^\\s*\\[${escapeRegExp(section)}\\]`);
  let inSection = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) inSection = secRe.test(line);
    else if (inSection) {
      const m = line.match(/^\s*port\s*=\s*(\d+)/);
      if (m) return m[1];
    }
  }
  return null;
}
function labelOf(name: string): string | null {
  const f = cfgFile(name);
  if (!f || !isFile(f)) return null;
  return parseLabel(Deno.readTextFileSync(f));
}
function portOf(name: string, section: string): string | null {
  const f = cfgFile(name);
  if (!f || !isFile(f)) return null;
  return parsePort(Deno.readTextFileSync(f), section);
}

// ---------- persisted config (key = value store) ------------------------------
function readConfigKV(): Record<string, string> {
  const kv: Record<string, string> = {};
  const path = configPath();
  if (isFile(path)) {
    for (const line of Deno.readTextFileSync(path).split(/\r?\n/)) {
      if (line.trim().startsWith("#")) continue;
      const m = line.match(/^\s*([a-z_]+)\s*=\s*(.*?)\s*$/);
      if (m) kv[m[1]] = m[2];
    }
  }
  return kv;
}
function setConfigKey(key: string, val: string): void {
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
    "# Per-shell overrides: SUPA_MAX_ACTIVE, SUPA_RAM_BUDGET, SUPA_ALLOW_MULTI=1.",
  ];
  for (const [k, v] of Object.entries(kv)) lines.push(`${k} = ${v}`);
  Deno.writeTextFileSync(path, lines.join("\n") + "\n");
  console.log(`supa: set ${key} = ${val}  (${path})`);
}

function readMaxActive(): { value: number; source: string } {
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
function readRamBudget(): number | null {
  const env = Deno.env.get("SUPA_RAM_BUDGET");
  if (env) {
    const n = Number(env);
    if (n > 0) return n;
  }
  const n = Number(readConfigKV().ram_budget_gb);
  return n > 0 ? n : null;
}

// ---------- RAM parsing (docker MemUsage "<used> / <limit>") -------------------
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

// ---------- external tools ----------------------------------------------------
function which(cmd: string): string | null {
  const pathEnv = Deno.env.get("PATH") ?? "";
  const sep = OS === "windows" ? ";" : ":";
  const cands = OS === "windows" ? [`${cmd}.exe`, `${cmd}.cmd`, cmd] : [cmd];
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    for (const c of cands) {
      const full = join(dir.replace(/\\/g, "/"), c);
      if (isFile(full)) return full;
    }
  }
  return null;
}
const SUPABASE_MISSING =
  "Supabase CLI not found on PATH — install it: https://supabase.com/docs/guides/local-development";
function supabaseCmd(): string {
  const onPath = which("supabase");
  if (onPath) return onPath;
  const fb = join(home(), ".local", "bin", "supabase");
  return isFile(fb) ? fb : "supabase";
}

async function runCapture(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  try {
    const { code, stdout } = await new Deno.Command(cmd, {
      args,
      stdout: "piped",
      stderr: "null",
    }).output();
    return { code, out: new TextDecoder().decode(stdout) };
  } catch {
    return { code: 127, out: "" };
  }
}
async function runInherit(cmd: string, args: string[]): Promise<number> {
  try {
    const { code } = await new Deno.Command(cmd, {
      args,
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    }).output();
    return code;
  } catch {
    return 127;
  }
}

async function runningLabels(): Promise<string[]> {
  const { code, out } = await runCapture("docker", [
    "ps",
    "--format",
    '{{.Label "com.supabase.cli.project"}}',
  ]);
  if (code !== 0) return [];
  const set = new Set<string>();
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim();
    if (t) set.add(t);
  }
  return [...set].sort();
}
function nameForLabel(label: string): string | null {
  for (const n of names()) if (labelOf(n) === label) return n;
  return null;
}
async function pinNoRestart(label: string): Promise<void> {
  const { code, out } = await runCapture("docker", [
    "ps",
    "-aq",
    "--filter",
    `label=com.supabase.cli.project=${label}`,
  ]);
  if (code !== 0) return;
  const ids = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (ids.length) await runCapture("docker", ["update", "--restart", "no", ...ids]);
}

// ---------- lifecycle ---------------------------------------------------------
async function startStack(name: string): Promise<void> {
  const wd = cfgDir(name);
  if (!wd) die(`no supabase/config.toml under '${rootOf(name)}' for '${name}'`);
  console.log(`>> starting ${name}  (${wd})`);
  const code = await runInherit(supabaseCmd(), ["--workdir", wd, "start"]);
  if (code === 127) die(SUPABASE_MISSING);
  if (code !== 0) die(`supabase start failed for '${name}' (exit ${code})`);
  const lbl = labelOf(name);
  if (lbl) await pinNoRestart(lbl);
}
async function stopStack(name: string): Promise<void> {
  const wd = cfgDir(name);
  if (!wd) die(`unresolvable project '${name}'`);
  console.log(`== stopping ${name}`);
  const code = await runInherit(supabaseCmd(), ["--workdir", wd, "stop"]);
  if (code === 127) die(SUPABASE_MISSING);
  if (code !== 0) die(`supabase stop failed for '${name}' (exit ${code})`);
}

// Refuse to start `name` when that would exceed the max-active limit.
async function guard(name: string): Promise<void> {
  const { value: max, source } = readMaxActive();
  if (max === Infinity) return;
  const target = labelOf(name);
  const running = await runningLabels();
  if (target && running.includes(target)) return; // already up — re-up is fine
  const others = running.filter((l) => l !== target);
  if (others.length < max) return;

  const from = source === "default" ? "" : `, from ${source}`;
  console.error(`supa: max-active limit reached (${max}${from}) — already running:`);
  for (const l of others) console.error(`  - ${nameForLabel(l) ?? l} (${l})`);
  console.error("");
  console.error(`  free a slot:       supa down <name>`);
  console.error(`  swap to '${name}':   supa switch ${name}   (stops others, runs only this)`);
  console.error(`  raise the limit:   supa config max-active ${others.length + 1}`);
  console.error(`  or one-off:        SUPA_MAX_ACTIVE=${others.length + 1} supa up ${name}`);
  Deno.exit(1);
}

// ---------- commands ----------------------------------------------------------
async function cmdUp(rest: string[]): Promise<void> {
  if (rest.length < 1) die("usage: supa up <project...>");
  for (const p of rest) {
    if (rootOf(p) === null) die(`unknown project '${p}' (known: ${names().join(" ")})`);
  }
  for (const p of rest) {
    await guard(p);
    await startStack(p);
  }
}
async function cmdDown(rest: string[]): Promise<void> {
  if (rest.length < 1) die("usage: supa down <project...> | supa down --all");
  const list = rest[0] === "--all" ? names() : rest;
  for (const p of list) await stopStack(p);
}
async function cmdSwitch(rest: string[]): Promise<void> {
  if (rest.length !== 1) die("usage: supa switch <project>");
  const target = rest[0];
  if (rootOf(target) === null) die(`unknown project '${target}' (known: ${names().join(" ")})`);
  const tgt = labelOf(target);
  for (const l of await runningLabels()) {
    if (l === tgt) continue;
    const nm = nameForLabel(l);
    if (nm) await stopStack(nm);
    else console.error(`! running stack '${l}' not in registry — leaving it up`);
  }
  await startStack(target);
}
async function cmdEnv(rest: string[]): Promise<void> {
  const write = rest.includes("--write") || rest.includes("-w");
  const args = rest.filter((a) => a !== "--write" && a !== "-w");
  if (args.length < 1 || args.length > 2) die("usage: supa env <project> [--write [file]]");
  const p = args[0];
  const wd = cfgDir(p);
  if (!wd) die(`unresolvable project '${p}'`);
  if (!write) {
    const code = await runInherit(supabaseCmd(), ["--workdir", wd, "status", "-o", "env"]);
    if (code !== 0) Deno.exit(code);
    return;
  }
  const { code, out } = await runCapture(supabaseCmd(), ["--workdir", wd, "status", "-o", "env"]);
  if (code !== 0 || out.trim() === "") {
    die(`could not read env for '${p}' — is it up? try 'supa up ${p}'`);
  }
  const target = args[1] ?? join(wd, ".env.local");
  const envMap = readEnvMap(wd);
  let incoming = out;
  if (envMap.length) {
    const applied = applyEnvMap(out, envMap);
    incoming = applied.incoming;
    if (applied.missing.length) {
      console.error(
        `  warning: supa.env.map references keys not in supabase output: ${
          applied.missing.join(", ")
        }`,
      );
    }
  }
  const existing = isFile(target) ? Deno.readTextFileSync(target) : "";
  const { text, keys, map } = mergeDotenv(existing, incoming);
  Deno.writeTextFileSync(target, text);
  console.log(`supa: wrote ${keys.length} keys to ${target}`);
  for (const k of keys) console.log(`  ${k}=${maskSecret(k, map[k])}`);
  console.log(
    envMap.length
      ? `  mapped via ${join(wd, "supa.env.map")}`
      : `  note: native Supabase key names — add a supa.env.map to rename them.`,
  );
}
async function cmdLs(): Promise<void> {
  const running = new Set(await runningLabels());
  const widths = [8, 9, 7, 7, 7, 7];
  const row = (c: string[]) => {
    let s = "";
    for (let i = 0; i < widths.length; i++) s += c[i].padEnd(widths[i]) + " ";
    console.log(s + c[widths.length]);
  };
  row(["NAME", "LABEL", "API", "DB", "STUDIO", "STATUS", "ROOT"]);
  for (const p of readRegistry().sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const lbl = labelOf(p.name) ?? "?";
    row([
      p.name,
      lbl,
      portOf(p.name, "api") ?? "",
      portOf(p.name, "db") ?? "",
      portOf(p.name, "studio") ?? "",
      running.has(lbl) ? "UP" : "down",
      p.root,
    ]);
  }
}
async function cmdStatus(): Promise<void> {
  const { code, out } = await runCapture("docker", [
    "ps",
    "--filter",
    "label=com.supabase.cli.project",
    "--format",
    'table {{.Label "com.supabase.cli.project"}}\\t{{.Names}}\\t{{.Status}}',
  ]);
  if (code !== 0) die("docker not available");
  const lines = out.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return;
  console.log(lines[0]);
  const rest = lines.slice(1).sort();
  if (rest.length) console.log(rest.join("\n"));
}
function cmdConfig(rest: string[]): void {
  if (rest.length === 0) {
    const { value, source } = readMaxActive();
    const budget = readRamBudget();
    const reg = registryPath();
    const cfg = configPath();
    console.log("supa configuration");
    console.log(`  os:          ${OS}`);
    console.log(`  SUPA_HOME:   ${Deno.env.get("SUPA_HOME") ?? `(unset → ${configDir()})`}`);
    console.log(`  registry:    ${reg}${isFile(reg) ? "" : "   (MISSING)"}`);
    console.log(`  config file: ${cfg}${isFile(cfg) ? "" : "   (none yet)"}`);
    console.log(`  max_active:  ${value === Infinity ? "unlimited" : value}   (from ${source})`);
    console.log(`  ram_budget:  ${budget ? `${budget} GiB` : "(unset)"}`);
    return;
  }
  if (rest[0] === "max-active") {
    if (rest.length !== 2) die("usage: supa config max-active <n>");
    const raw = rest[1].trim();
    if (!/^\d+$/.test(raw) || Number(raw) < 1) {
      die(`max-active must be an integer >= 1 (got '${rest[1]}')`);
    }
    setConfigKey("max_active", raw);
    return;
  }
  if (rest[0] === "ram-budget") {
    if (rest.length !== 2) die("usage: supa config ram-budget <gb>");
    const raw = rest[1].trim();
    if (!/^\d+(\.\d+)?$/.test(raw) || Number(raw) <= 0) {
      die(`ram-budget must be a positive number of GiB (got '${rest[1]}')`);
    }
    setConfigKey("ram_budget_gb", raw);
    return;
  }
  die(`unknown config key '${rest[0]}' (try: supa config [max-active <n> | ram-budget <gb>])`);
}
// ---------- helpers for the extended commands ---------------------------------
function requireProject(p: string): void {
  if (rootOf(p) === null) die(`unknown project '${p}' (known: ${names().join(" ")})`);
}
export function maskSecret(key: string, val: string): string {
  if (/KEY|SECRET|TOKEN|PASSWORD|JWT/i.test(key) && val.length > 10) {
    return `${val.slice(0, 4)}…${val.slice(-4)}`;
  }
  return val;
}
// Merge KEY=VALUE lines from `incoming` into `existing` dotenv text: update keys
// in place, keep every other line, append genuinely new keys at the end.
export function mergeDotenv(
  existing: string,
  incoming: string,
): { text: string; keys: string[]; map: Record<string, string> } {
  const map: Record<string, string> = {};
  const keys: string[] = [];
  for (const line of incoming.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) {
      if (!(m[1] in map)) keys.push(m[1]);
      map[m[1]] = m[2];
    }
  }
  const outLines: string[] = [];
  const seen = new Set<string>();
  for (const line of existing.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && m[1] in map) {
      outLines.push(`${m[1]}=${map[m[1]]}`);
      seen.add(m[1]);
    } else outLines.push(line);
  }
  while (outLines.length && outLines[outLines.length - 1].trim() === "") outLines.pop();
  const fresh = keys.filter((k) => !seen.has(k));
  if (fresh.length) {
    if (outLines.length) outLines.push("");
    outLines.push("# supabase local — written by `supa env --write`");
    for (const k of fresh) outLines.push(`${k}=${map[k]}`);
  }
  return { text: outLines.join("\n") + "\n", keys, map };
}
// Optional per-project rename map at <cfgDir>/supa.env.map: "APP_NAME = NATIVE"
// per line (# comments ok). One native may map to several app names.
export function parseEnvMap(text: string): Array<{ app: string; native: string }> {
  const out: Array<{ app: string; native: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(
      /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:#.*)?$/,
    );
    if (m) out.push({ app: m[1], native: m[2] });
  }
  return out;
}
// Pure: rename `supabase status -o env` output via a map, one native -> many
// app names. Returns the mapped KEY=VALUE lines + any natives not in the output.
export function applyEnvMap(
  nativeEnvText: string,
  envMap: Array<{ app: string; native: string }>,
): { incoming: string; missing: string[] } {
  const native: Record<string, string> = {};
  for (const line of nativeEnvText.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) native[m[1]] = m[2];
  }
  const lines: string[] = [];
  const missing = new Set<string>();
  for (const { app, native: nat } of envMap) {
    if (nat in native) lines.push(`${app}=${native[nat]}`);
    else missing.add(nat);
  }
  return { incoming: lines.join("\n"), missing: [...missing] };
}
function readEnvMap(cfgDirPath: string): Array<{ app: string; native: string }> {
  const mapPath = join(cfgDirPath, "supa.env.map");
  if (!isFile(mapPath)) return [];
  return parseEnvMap(Deno.readTextFileSync(mapPath));
}
async function readLine(prompt: string): Promise<string> {
  await Deno.stdout.write(new TextEncoder().encode(prompt));
  const buf = new Uint8Array(256);
  const n = await Deno.stdin.read(buf);
  return n === null ? "" : new TextDecoder().decode(buf.subarray(0, n)).trim();
}
function slotOf(name: string): string | null {
  const m = (portOf(name, "api") ?? "").match(/^543(\d)\d$/);
  return m ? m[1] : null;
}
function nextFreeSlot(): string | null {
  const used = new Set(names().map(slotOf).filter((s): s is string => s !== null));
  for (let d = 1; d <= 9; d++) if (!used.has(String(d))) return String(d);
  return null;
}

// ---------- extended commands -------------------------------------------------
async function cmdRestart(rest: string[]): Promise<void> {
  if (rest.length < 1) die("usage: supa restart <project...>");
  for (const p of rest) requireProject(p);
  const running = await runningLabels();
  for (const p of rest) {
    const lbl = labelOf(p);
    const wasRunning = !!lbl && running.includes(lbl);
    if (wasRunning) await stopStack(p);
    else await guard(p); // restarting a running stack is net-zero; starting a stopped one counts
    await startStack(p);
  }
}

async function cmdLogs(rest: string[]): Promise<void> {
  if (rest.length < 1) die("usage: supa logs <project> [service] [-f]");
  const p = rest[0];
  requireProject(p);
  const lbl = labelOf(p);
  if (!lbl) die(`cannot resolve docker label for '${p}'`);
  const follow = rest.includes("-f") || rest.includes("--follow");
  const svc = rest.slice(1).find((a) => a !== "-f" && a !== "--follow");
  const { out } = await runCapture("docker", [
    "ps",
    "--filter",
    `label=com.supabase.cli.project=${lbl}`,
    "--format",
    "{{.Names}}",
  ]);
  const containers = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (containers.length === 0) die(`no running containers for '${p}' — is it up? 'supa up ${p}'`);
  const svcOf = (c: string) =>
    c.replace(/^supabase_/, "").replace(new RegExp(`_${escapeRegExp(lbl)}$`), "");
  if (!svc) {
    console.log(`services for '${p}':`);
    for (const c of containers.sort()) console.log(`  ${svcOf(c)}`);
    console.log(`\nusage: supa logs ${p} <service> [-f]`);
    return;
  }
  const match = containers.find((c) => svcOf(c) === svc) ??
    containers.find((c) => c.includes(`_${svc}`));
  if (!match) {
    die(`no service '${svc}' in '${p}' (have: ${containers.map(svcOf).sort().join(", ")})`);
  }
  const args = ["logs", "--tail", "200"];
  if (follow) args.push("-f");
  args.push(match);
  await runInherit("docker", args);
}

async function cmdDestroy(rest: string[]): Promise<void> {
  const yes = rest.includes("--yes") || rest.includes("-y");
  const targets = rest.filter((a) => a !== "--yes" && a !== "-y");
  if (targets.length !== 1) {
    die("usage: supa destroy <project> [--yes]   (one at a time — this deletes data)");
  }
  const p = targets[0];
  const wd = cfgDir(p);
  if (!wd) die(`unresolvable project '${p}'`);
  const lbl = labelOf(p) ?? p;
  console.error(`⚠ destroy '${p}' — STOPS the stack and DELETES its local data`);
  console.error(`  (containers + volumes for docker label '${lbl}'). This cannot be undone.`);
  if (!yes) {
    const ans = await readLine(`  type '${p}' to confirm: `);
    if (ans !== p) die("aborted (confirmation did not match)");
  }
  console.log(`== destroying ${p}`);
  const code = await runInherit(supabaseCmd(), ["--workdir", wd, "stop", "--no-backup"]);
  if (code !== 0) die(`'supabase stop --no-backup' failed for '${p}' (exit ${code})`);
  const { out } = await runCapture("docker", [
    "volume",
    "ls",
    "-q",
    "--filter",
    `label=com.supabase.cli.project=${lbl}`,
  ]);
  const vols = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (vols.length) {
    await runCapture("docker", ["volume", "rm", ...vols]);
    console.log(`  removed ${vols.length} volume(s)`);
  }
  console.log(`✓ destroyed ${p}`);
}

async function cmdAdd(rest: string[]): Promise<void> {
  const pos: string[] = [];
  let init = false;
  let slot: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--init") init = true;
    else if (rest[i] === "--slot") slot = rest[++i];
    else pos.push(rest[i]);
  }
  if (pos.length !== 2) die("usage: supa add <name> <path> [--init] [--slot 0-9]");
  if (slot !== undefined && !/^\d$/.test(slot)) die("--slot must be a single digit 0-9");
  const [name, path] = pos;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) die(`invalid name '${name}' (use letters/digits/._-)`);
  if (names().includes(name)) die(`'${name}' is already registered`);
  const abs = expandTilde(path);
  if (!isDir(abs)) console.error(`  warning: '${abs}' is not a directory (registering anyway)`);
  const reg = registryPath();
  const prev = isFile(reg) ? Deno.readTextFileSync(reg) : "";
  const sep = prev.length && !prev.endsWith("\n") ? "\n" : "";
  Deno.writeTextFileSync(reg, `${prev}${sep}${name}|${path}\n`);
  console.log(`supa: added ${name} -> ${path}`);

  if (init) {
    if (isFile(join(abs, "supabase", "config.toml"))) {
      console.error(`  note: supabase/config.toml already exists — skipping 'supabase init'`);
    } else {
      console.log(`>> supabase init (${abs})`);
      const code = await runInherit(supabaseCmd(), ["--workdir", abs, "init"]);
      if (code !== 0) die(`'supabase init' failed for '${name}' (exit ${code})`);
    }
    const chosen = slot ?? nextFreeSlot() ?? "";
    const f = cfgFile(name);
    if (/^\d$/.test(chosen) && f && isFile(f)) {
      const changes = rebandConfig(f, chosen);
      console.log(
        `  assigned slot ${chosen} — ${changes.length} port(s) re-banded (543${chosen}X)`,
      );
    }
  }
  const wd = cfgDir(name);
  if (wd) console.log(`  config: ${wd}/supabase/config.toml (label: ${labelOf(name) ?? "?"})`);
  else console.error(`  note: no supabase/config.toml found under it yet`);
  if (!init) {
    const s = nextFreeSlot();
    if (s) console.log(`  next free port band: 543${s}X  (apply: supa ports ${name} ${s})`);
  }
}

function cmdRm(rest: string[]): void {
  if (rest.length !== 1) die("usage: supa rm <name>");
  const name = rest[0];
  if (!names().includes(name)) die(`'${name}' is not in the registry`);
  const reg = registryPath();
  const kept = Deno.readTextFileSync(reg).split(/\r?\n/).filter((line) => {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) return true;
    const i = t.indexOf("|");
    return i < 1 ? true : t.slice(0, i).trim() !== name;
  });
  Deno.writeTextFileSync(reg, kept.join("\n").replace(/\n+$/, "\n"));
  console.log(`supa: removed ${name} from the registry`);
}

// Pure: re-band every 543XX port to `slot` (keep the service digit), and pull the
// edge_runtime inspector_port (default 8083, off-scheme) into 543<slot>8 so it
// can't collide across projects. Returns updated text + changes. Exported for tests.
export function rebandText(text: string, slot: string): { text: string; changes: string[] } {
  const changes: string[] = [];
  let out = text.replace(/(=[ \t]*)543(\d)(\d)(?!\d)/g, (_m, pre, oldSlot, svc) => {
    if (oldSlot !== slot) changes.push(`543${oldSlot}${svc} -> 543${slot}${svc}`);
    return `${pre}543${slot}${svc}`;
  });
  out = out.replace(/^([ \t]*inspector_port[ \t]*=[ \t]*)(\d+)/gm, (_m, pre, old) => {
    const next = `543${slot}8`;
    if (old !== next) changes.push(`inspector_port ${old} -> ${next}`);
    return `${pre}${next}`;
  });
  return { text: out, changes };
}
function rebandConfig(f: string, slot: string): string[] {
  const src = Deno.readTextFileSync(f);
  const { text, changes } = rebandText(src, slot);
  if (changes.length) {
    Deno.writeTextFileSync(`${f}.bak`, src);
    Deno.writeTextFileSync(f, text);
  }
  return changes;
}
function cmdPorts(rest: string[]): void {
  if (rest.length < 1 || rest.length > 2) die("usage: supa ports <name> [slot 0-9]");
  const name = rest[0];
  requireProject(name);
  const f = cfgFile(name);
  if (!f || !isFile(f)) die(`no supabase/config.toml for '${name}'`);
  let slot = rest[1];
  if (slot === undefined) {
    const s = nextFreeSlot();
    if (s === null) die("no free port slot (0-9 all taken)");
    slot = s;
  }
  if (!/^\d$/.test(slot)) die("slot must be a single digit 0-9");
  const changes = rebandConfig(f, slot);
  if (changes.length === 0) {
    console.log(`no re-bandable 543XX ports found (or already on slot ${slot}) in ${f}`);
    return;
  }
  console.log(
    `supa: re-banded ${name} to slot ${slot} — ${changes.length} port(s) (backup: ${f}.bak)`,
  );
  for (const c of changes) console.log(`  ${c}`);
  console.log(`  apply: supa restart ${name}`);
}

async function cmdDoctor(): Promise<void> {
  const ok = (b: boolean) => (b ? "✓" : "✗");
  console.log("supa doctor");
  const dv = await runCapture("docker", ["version", "--format", "{{.Server.Version}}"]);
  const dockerUp = dv.code === 0 && dv.out.trim() !== "";
  console.log(
    `  ${ok(dockerUp)} docker daemon        ${
      dockerUp ? "v" + dv.out.trim() : "not running / not found"
    }`,
  );
  const sv = await runCapture(supabaseCmd(), ["--version"]);
  console.log(
    `  ${ok(sv.code === 0)} supabase CLI         ${
      sv.code === 0 ? sv.out.trim() : "not found on PATH"
    }`,
  );
  const reg = registryPath();
  console.log(`  ${ok(isFile(reg))} registry             ${reg}`);
  if (!isFile(reg)) return;
  const projs = readRegistry();
  console.log(`  ${ok(projs.length > 0)} projects registered  ${projs.length}`);
  let allCfg = true;
  for (const p of projs) {
    if (!cfgDir(p.name)) {
      allCfg = false;
      console.log(`     ✗ ${p.name}: no config.toml under ${p.root}`);
    }
  }
  if (allCfg && projs.length) console.log(`  ✓ all config.toml resolve`);
  const seen: Record<string, string> = {};
  let collision = false;
  for (const p of projs) {
    for (const sec of ["api", "db", "studio"]) {
      const port = portOf(p.name, sec);
      if (!port) continue;
      if (seen[port]) {
        collision = true;
        console.log(`     ✗ port ${port}: ${seen[port]} vs ${p.name}.${sec}`);
      } else seen[port] = `${p.name}.${sec}`;
    }
  }
  console.log(`  ${ok(!collision)} no port collisions`);
  const { value, source } = readMaxActive();
  console.log(`  · max_active = ${value === Infinity ? "unlimited" : value} (${source})`);
}

async function cmdStats(): Promise<void> {
  const { code, out } = await runCapture("docker", [
    "ps",
    "--filter",
    "label=com.supabase.cli.project",
    "--format",
    '{{.Names}}\t{{.Label "com.supabase.cli.project"}}',
  ]);
  if (code !== 0) die("docker not available");
  const labelByName: Record<string, string> = {};
  const containers: string[] = [];
  for (const l of out.split(/\r?\n/)) {
    const [name, lbl] = l.split("\t");
    if (name?.trim()) {
      containers.push(name.trim());
      labelByName[name.trim()] = (lbl ?? "").trim();
    }
  }
  if (containers.length === 0) {
    console.log("no supabase containers running");
    return;
  }
  const st = await runCapture("docker", [
    "stats",
    "--no-stream",
    "--format",
    "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}",
    ...containers,
  ]);
  if (st.code !== 0) die("docker stats failed");
  const rows = st.out.split(/\r?\n/).filter(Boolean).map((l) => l.split("\t"));
  rows.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const w = [10, 12, 9];
  const line = (c: string[]) =>
    console.log(c[0].padEnd(w[0]) + " " + c[1].padEnd(w[1]) + " " + c[2].padEnd(w[2]) + " " + c[3]);
  line(["PROJECT", "SERVICE", "CPU%", "MEM"]);
  const perProject: Record<string, number> = {};
  let grand = 0;
  for (const [name, cpu, mem] of rows) {
    const label = labelByName[name] || (name.split("_").pop() ?? "");
    const svc = name.replace(/^supabase_/, "").replace(new RegExp(`_${escapeRegExp(label)}$`), "");
    line([label, svc, cpu, mem]);
    const used = memToMiB((mem ?? "").split("/")[0]);
    perProject[label] = (perProject[label] ?? 0) + used;
    grand += used;
  }
  console.log("");
  for (const [label, mib] of Object.entries(perProject).sort()) {
    line([label, "(total)", "", fmtMiB(mib)]);
  }
  line(["ALL", "(total)", "", fmtMiB(grand)]);
  const budget = readRamBudget();
  if (budget) {
    const usedGiB = grand / 1024;
    const pct = Math.round((usedGiB / budget) * 100);
    const flag = usedGiB > budget ? "   ⚠ OVER BUDGET" : "";
    console.log(`budget: ${usedGiB.toFixed(1)} / ${budget} GiB (${pct}%)${flag}`);
    const stacks = Object.keys(perProject).length;
    if (stacks >= 1 && grand > 0) {
      const avg = grand / stacks;
      const fit = Math.max(1, Math.floor((budget * 1024) / avg));
      console.log(
        `suggest: ~${fit} stack(s) fit (avg ${fmtMiB(avg)}/stack) → supa config max-active ${fit}`,
      );
    }
  }
}

// Pure: normalize `supabase gen signing-key` output (a single JWK object, or an
// array, possibly multi-line or with a stray notice) into the JSON *array* text
// that Supabase's signing_keys file requires. Throws on unparseable input.
export function signingKeyArray(genOutput: string): string {
  const starts = [genOutput.indexOf("{"), genOutput.indexOf("[")].filter((i) => i >= 0);
  if (!starts.length) throw new Error("could not parse signing key JSON");
  const start = Math.min(...starts);
  // Try progressively shorter slices from the end so a trailing CLI notice —
  // even one that itself contains brackets — is stripped before parsing.
  let parsed: unknown;
  for (let end = genOutput.length; end > start; end--) {
    const c = genOutput[end - 1];
    if (c !== "}" && c !== "]") continue;
    try {
      parsed = JSON.parse(genOutput.slice(start, end));
      break;
    } catch { /* keep shrinking */ }
  }
  if (parsed === undefined) throw new Error("could not parse signing key JSON");
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  return JSON.stringify(arr, null, 2) + "\n";
}
// Ensure config.toml has an active signing_keys_path; return updated text + path.
export function ensureSigningKeysPath(text: string): { text: string; relPath: string } {
  const active = text.match(/^\s*signing_keys_path\s*=\s*"([^"]+)"/m);
  if (active) return { text, relPath: active[1] };
  const commented = /^([ \t]*)#\s*signing_keys_path\s*=\s*"([^"]+)"/m;
  const cm = text.match(commented);
  if (cm) {
    return { text: text.replace(commented, `$1signing_keys_path = "${cm[2]}"`), relPath: cm[2] };
  }
  const rel = "./signing_keys.json";
  if (/^[ \t]*\[auth\][ \t]*$/m.test(text)) {
    return {
      text: text.replace(/^([ \t]*\[auth\][ \t]*)$/m, `$1\nsigning_keys_path = "${rel}"`),
      relPath: rel,
    };
  }
  return {
    text: `${text.replace(/\n*$/, "")}\n\n[auth]\nsigning_keys_path = "${rel}"\n`,
    relPath: rel,
  };
}

async function cmdRotate(rest: string[]): Promise<void> {
  const yes = rest.includes("--yes") || rest.includes("-y");
  const targets = rest.filter((a) => a !== "--yes" && a !== "-y");
  if (targets.length !== 1) die("usage: supa rotate <project> [--yes]");
  const p = targets[0];
  const wd = cfgDir(p);
  if (!wd) die(`unresolvable project '${p}'`);
  const f = cfgFile(p);
  if (!f) die(`no supabase/config.toml for '${p}'`);
  console.error(`⚠ rotate '${p}' — generates a NEW JWT signing key and restarts the stack.`);
  console.error(`  existing tokens/sessions become invalid; anon/service keys change.`);
  if (!yes) {
    const ans = await readLine(`  type '${p}' to confirm: `);
    if (ans !== p) die("aborted (confirmation did not match)");
  }
  const gen = await runCapture(
    supabaseCmd(),
    ["--workdir", wd, "gen", "signing-key", "--algorithm", "ES256"],
  );
  if (gen.code !== 0 || gen.out.trim() === "") die(`'supabase gen signing-key' failed for '${p}'`);
  const cfgText = Deno.readTextFileSync(f);
  const { text: newCfg, relPath } = ensureSigningKeysPath(cfgText);
  // Supabase resolves signing_keys_path relative to the supabase/ directory
  // (where config.toml lives), and the file must be a JSON *array* of JWKs.
  const keyFile = join(wd, "supabase", relPath.replace(/^\.\//, ""));
  let keyArrayText: string;
  try {
    keyArrayText = signingKeyArray(gen.out);
  } catch (e) {
    die(`bad signing key from the Supabase CLI: ${e instanceof Error ? e.message : e}`);
  }
  Deno.writeTextFileSync(keyFile, keyArrayText);
  console.log(`  wrote new signing key -> ${keyFile}`);
  if (newCfg !== cfgText) {
    Deno.writeTextFileSync(`${f}.bak`, cfgText);
    Deno.writeTextFileSync(f, newCfg);
    console.log(`  set signing_keys_path = "${relPath}" (backup: ${f}.bak)`);
  }
  console.error(`  reminder: gitignore ${relPath} — it holds the private signing key.`);
  const running = await runningLabels();
  const lbl = labelOf(p);
  if (lbl && running.includes(lbl)) {
    await stopStack(p);
    await startStack(p);
  } else {
    console.log(`  '${p}' isn't running — start it to apply: supa up ${p}`);
  }
  console.log(`✓ rotated ${p}`);
}

function cmdHelp(): void {
  const defHome = OS === "windows" ? "%APPDATA%\\supa" : "~/.config/supa";
  console.log(
    `supa — run local Supabase stacks (CLI-backed, cross-platform, no compose)

  supa ls                       list projects, docker label, live ports, status
  supa up <p...>                start stack(s) — refuses past the max-active limit *
  supa down <p...> | --all      stop one/more stacks (or every registered one)
  supa restart <p...>           stop + start a stack
  supa switch <p>               stop all others, run only <p>
  supa destroy <p> [--yes]      stop + DELETE a stack's data (containers + volumes)
  supa rotate <p> [--yes]       new JWT signing key + restart (invalidates tokens)
  supa status                   raw docker view, grouped by project
  supa stats                    CPU/MEM per container + per-stack & total RAM
  supa logs <p> [svc] [-f]      tail a stack's container logs
  supa env <p> [--write [f]]    print keys/URLs, or merge them into a .env file
  supa add <name> <path> [--init] [--slot N]   register (--init: init + assign ports)
  supa rm <name>                unregister a project
  supa ports <name> [slot]      re-band that project's 543XX ports to a free slot
  supa doctor                   preflight: docker, CLI, registry, ports, config
  supa config [max-active <n> | ram-budget <gb>]    show or set limits
  supa version                  print the supa version
  supa help                     this

* max-active defaults to 1. Raise it: 'supa config max-active 2', or one-off
  'SUPA_MAX_ACTIVE=2 supa up <p>'. 'SUPA_ALLOW_MULTI=1' means unlimited.

Config lives in SUPA_HOME (default ${defHome}): supa.registry (name|path) +
supa.config. Override with SUPA_HOME / SUPA_REGISTRY / SUPA_CONFIG.
Full guide: SUPA.md   Ports: PORTS.md`,
  );
}

// ---------- dispatch ----------------------------------------------------------
async function main(): Promise<void> {
  const [cmd = "help", ...rest] = Deno.args;
  switch (cmd) {
    case "ls":
    case "list":
      await cmdLs();
      break;
    case "up":
    case "start":
      await cmdUp(rest);
      break;
    case "down":
    case "stop":
      await cmdDown(rest);
      break;
    case "restart":
      await cmdRestart(rest);
      break;
    case "switch":
    case "only":
      await cmdSwitch(rest);
      break;
    case "destroy":
      await cmdDestroy(rest);
      break;
    case "rotate":
      await cmdRotate(rest);
      break;
    case "status":
    case "ps":
      await cmdStatus();
      break;
    case "stats":
      await cmdStats();
      break;
    case "logs":
      await cmdLogs(rest);
      break;
    case "env":
      await cmdEnv(rest);
      break;
    case "add":
      await cmdAdd(rest);
      break;
    case "rm":
    case "remove":
      cmdRm(rest);
      break;
    case "ports":
      cmdPorts(rest);
      break;
    case "doctor":
      await cmdDoctor();
      break;
    case "config":
      cmdConfig(rest);
      break;
    case "version":
    case "--version":
    case "-V":
      console.log(`supa ${VERSION}`);
      break;
    case "help":
    case "-h":
    case "--help":
      cmdHelp();
      break;
    default:
      die(`unknown command '${cmd}' (try: supa help)`);
  }
}

if (import.meta.main) await main();
