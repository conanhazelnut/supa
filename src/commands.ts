// The command handlers. Each maps `supa <verb> …` to Supabase-CLI + docker calls,
// deriving everything from the registry and each project's config.toml.
import { fromFileUrl } from "@std/path";
import {
  absolutize,
  CommandFailed,
  die,
  DOCS_URL,
  escapeRegExp,
  expandTilde,
  fmtMiB,
  isDir,
  isFile,
  join,
  maskSecret,
  memToMiB,
  OS,
  parentDir,
  pathsEqual,
  readTextFile,
  REPO,
  resolveUnder,
  VERSION,
} from "./util.ts";
import {
  applyEnvMap,
  attributeUntagged,
  backupFileName,
  type BackupType,
  DEFAULT_ENV_MAP,
  droppedRegistryNames,
  ensureSigningKeysPath,
  imageInUse,
  isReleaseTag,
  isSupabaseRepo,
  latestBackup,
  mergeDotenv,
  parseImageRows,
  parseMajorVersion,
  relativeRegistryEntries,
  releaseAsset,
  resolveBackupDir,
  SAFE_NAME,
  semverNewer,
  setMajorVersion,
  shaFor,
  signingKeyArray,
  tsStamp,
  uniqueNames,
} from "./parse.ts";
import {
  cfgCandidates,
  cfgDir,
  cfgFile,
  configDir,
  configPath,
  hasExplicitEntry,
  labelOf,
  names,
  parkedDirs,
  portOverlay,
  readBackupDir,
  readEnvMap,
  readHooks,
  readLimits,
  readMaxActive,
  readProjectSlot,
  readRamBudget,
  readRegistry,
  registryPath,
  rootOf,
  setConfigKey,
  slotKey,
  slotsPath,
  syncPortEnvFile,
  writeProjectSlot,
} from "./config.ts";
import { handleMcpMessage, type McpMessage } from "./mcp.ts";
import {
  effectivePorts,
  envForPorts,
  firstFreeSlot,
  fixedKeys,
  type FoundPort,
  type HostKey,
  parsePublishedPorts,
  readHostPorts,
  SLOT_MAX,
} from "./ports.ts";
import { ramDecision } from "./ram.ts";
import {
  applyLimits,
  copyDbVolume,
  dbContainer,
  dbImage,
  guardMany,
  nameForLabel,
  runCapture,
  runHook,
  runInherit,
  runningLabels,
  runStdinFile,
  startStack,
  stopStack,
  SUPABASE_MISSING,
  supabaseCmd,
  volumeExists,
} from "./supabase.ts";

function requireProject(p: string): void {
  if (rootOf(p) === null) die(`unknown project '${p}' (known: ${names().join(" ")})`);
}
// Registered is not enough — start/stop need a resolvable config.toml (same as switch).
function requireCfg(p: string): void {
  if (!cfgDir(p)) die(`no supabase/config.toml under '${rootOf(p)}' for '${p}'`);
}
function foundPorts(name: string): FoundPort[] | null {
  const f = cfgFile(name);
  if (!f || !isFile(f)) return null;
  return readHostPorts(readTextFile(f));
}
function shownPort(name: string, key: HostKey, slot: number | null = null): string {
  const found = foundPorts(name);
  if (!found) return "";
  const saved = slot === null ? readProjectSlot(name) : slot;
  const use = typeof saved === "number" ? saved : null;
  const value = effectivePorts(found, use)[key];
  return value === undefined ? "" : String(value);
}
function hasAutoPort(found: FoundPort[]): boolean {
  const fixed = fixedKeys(found);
  return Object.keys(effectivePorts(found, 0)).some((key) => !fixed.has(key as HostKey));
}
async function portHolders(except?: string): Promise<Map<number, string>> {
  const holders = new Map<number, string>();
  for (const n of names()) {
    if (n === except) continue;
    const found = foundPorts(n);
    if (!found) continue;
    const saved = readProjectSlot(n);
    const slot = typeof saved === "number" ? saved : null;
    for (const port of Object.values(effectivePorts(found, slot))) holders.set(port, n);
  }
  const ps = await runCapture("docker", [
    "ps",
    "--format",
    '{{.Names}}\t{{.Ports}}\t{{.Label "com.supabase.cli.project"}}',
  ]);
  if (ps.code !== 0) return holders;
  const own = except ? labelOf(except) : null;
  for (const row of parsePublishedPorts(ps.out)) {
    if (own && row.label === own) continue;
    const who = row.label ? (nameForLabel(row.label) ?? row.name) : row.name;
    for (const port of row.ports) holders.set(port, who);
  }
  return holders;
}
function slotAutosFree(
  name: string,
  found: FoundPort[],
  slot: number,
  holders: Map<number, string>,
): boolean {
  const fixed = fixedKeys(found);
  for (const [key, port] of Object.entries(effectivePorts(found, slot))) {
    if (fixed.has(key as HostKey)) continue;
    const who = holders.get(port);
    if (who && who !== name) return false;
  }
  return true;
}
function refuseFixedPorts(name: string, found: FoundPort[], holders: Map<number, string>): void {
  const fixed = fixedKeys(found);
  for (const [key, port] of Object.entries(effectivePorts(found, null))) {
    if (!fixed.has(key as HostKey)) continue;
    const who = holders.get(port);
    if (!who || who === name) continue;
    die(
      `port ${port} (${key}) is set in config.toml and is held by ${who}.\n` +
        `  That port was not moved.`,
    );
  }
}
/** Pick a free slot for this machine. Reuse the remembered one only while it is still free. */
async function prepareSlot(name: string, prefer?: number): Promise<number | null> {
  const wd = cfgDir(name);
  const found = foundPorts(name);
  const key = slotKey(name);
  if (!wd || !found || !key) return null;
  const holders = await portHolders(name);
  refuseFixedPorts(name, found, holders);
  if (!hasAutoPort(found)) return null;
  const saved = readProjectSlot(name);
  if (saved === "invalid") die(`invalid remembered slot for '${name}' (want 0-${SLOT_MAX})`);
  let slot: number | null = null;
  if (prefer !== undefined) {
    if (prefer < 0 || prefer > SLOT_MAX) die(`slot must be 0-${SLOT_MAX}`);
    if (!slotAutosFree(name, found, prefer, holders)) {
      die(`slot ${prefer} is not free on this machine.`);
    }
    slot = prefer;
  } else if (typeof saved === "number" && slotAutosFree(name, found, saved, holders)) {
    slot = saved;
  } else {
    slot = firstFreeSlot(new Set(holders.keys()), found);
    if (slot === null) die(`no free port slot (0-${SLOT_MAX}) on this machine`);
  }
  writeProjectSlot(key, slot);
  syncPortEnvFile(wd, envForPorts(effectivePorts(found, slot), found));
  return slot;
}
async function measureStacks(): Promise<
  {
    ok: true;
    total: number;
    unmanagedMiB: number;
    runningMiB: number[];
    managed: string[];
    unmanaged: string[];
  } | { ok: false; error: string }
> {
  const ps = await runCapture("docker", [
    "ps",
    "--filter",
    "label=com.supabase.cli.project",
    "--format",
    '{{.Names}}\t{{.Label "com.supabase.cli.project"}}',
  ]);
  if (ps.code !== 0) return { ok: false, error: ps.err.trim() || "docker ps failed" };
  const containers: string[] = [];
  const labelOfContainer: Record<string, string> = {};
  for (const line of ps.out.split(/\r?\n/)) {
    const [container, lbl] = line.split("\t");
    if (!container?.trim() || !lbl?.trim()) continue;
    containers.push(container.trim());
    labelOfContainer[container.trim()] = lbl.trim();
  }
  const empty = {
    ok: true as const,
    total: 0,
    unmanagedMiB: 0,
    runningMiB: [],
    managed: [],
    unmanaged: [],
  };
  if (containers.length === 0) return empty;
  const st = await runCapture("docker", [
    "stats",
    "--no-stream",
    "--format",
    "{{.Name}}\t{{.MemUsage}}",
    ...containers,
  ]);
  if (st.code !== 0) return { ok: false, error: st.err.trim() || "docker stats failed" };
  const perLabel: Record<string, number> = {};
  for (const line of st.out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [container, mem] = line.split("\t");
    const lbl = labelOfContainer[container?.trim() ?? ""];
    if (!lbl) continue;
    perLabel[lbl] = (perLabel[lbl] ?? 0) + memToMiB((mem ?? "").split("/")[0]);
  }
  const managed: string[] = [];
  const unmanaged: string[] = [];
  let unmanagedMiB = 0;
  for (const [lbl, mib] of Object.entries(perLabel)) {
    const name = nameForLabel(lbl);
    if (name) managed.push(name);
    else {
      unmanaged.push(lbl);
      unmanagedMiB += mib;
    }
  }
  const runningMiB = Object.values(perLabel);
  return {
    ok: true,
    total: runningMiB.reduce((a, b) => a + b, 0),
    unmanagedMiB,
    runningMiB,
    managed: managed.sort(),
    unmanaged: unmanaged.sort(),
  };
}
function refuseRam(
  decision: { predictedMiB: number; assumed: boolean },
  budget: number,
  managed: string[],
  unmanaged: string[],
): never {
  const assumed = decision.assumed ? " (assuming 1.8 GiB for a stack that is not running)" : "";
  const lines = [
    `ram_budget would be exceeded${assumed}: ${
      (decision.predictedMiB / 1024).toFixed(1)
    } GiB > ${budget} GiB.`,
  ];
  if (managed.length) lines.push(`  down: ${managed.join(", ")}`);
  if (unmanaged.length) {
    lines.push(`  not registered, supa will not stop: ${unmanaged.join(", ")}`);
  }
  if (!managed.length && !unmanaged.length) lines.push("  no stack is up to down");
  die(lines.join("\n"));
}
async function guardRam(
  toStart: string[],
  opts?: { stopOthersFirst?: boolean },
): Promise<void> {
  const budget = readRamBudget();
  if (budget === null) return;
  const running = new Set(await runningLabels());
  const measured = await measureStacks();
  if (!measured.ok) {
    die(`docker stats failed — not starting while ram_budget is set\n  ${measured.error}`);
  }
  const extras = toStart.filter((n) => {
    const lbl = labelOf(n);
    return !(lbl && running.has(lbl));
  }).length;
  const decision = ramDecision({
    budgetGiB: budget,
    currentMiB: opts?.stopOthersFirst ? measured.unmanagedMiB : measured.total,
    runningMiB: measured.runningMiB,
    extras,
  });
  if (!decision.ok) {
    refuseRam(
      decision,
      budget,
      opts?.stopOthersFirst ? [] : measured.managed,
      measured.unmanaged,
    );
  }
}
function refuseSharedProjectId(name: string): void {
  const lbl = labelOf(name);
  if (!lbl) return;
  const others = names().filter((n) => n !== name && labelOf(n) === lbl);
  if (others.length === 0) return;
  const rows = [name, ...others].map((n) => `${n} (${rootOf(n) ?? "?"})`);
  die(`project_id '${lbl}' is registered on more than one path:\n  ${rows.join("\n  ")}`);
}
async function stopOrDie(name: string): Promise<void> {
  try {
    await stopStack(name);
  } catch (e) {
    if (e instanceof CommandFailed) die(e.message);
    throw e;
  }
}
async function startOrDie(
  name: string,
  opts?: { failHint?: string; failHintAfterStart?: string; exclude?: string; json?: boolean },
): Promise<void> {
  try {
    await startStack(name, opts);
  } catch (e) {
    if (e instanceof CommandFailed) die(e.message);
    throw e;
  }
}
function requireArg(rest: string[], i: number, usage: string): string {
  const v = rest[i];
  if (v === undefined || v.startsWith("-")) die(usage);
  return v;
}
// First-run bootstrap: mkdir SUPA_HOME and create an empty registry so `add` /
// `park` work without an install-seeded file (install.sh curl can fail closed).
function ensureRegistry(): void {
  const reg = registryPath();
  try {
    Deno.mkdirSync(parentDir(reg), { recursive: true });
  } catch { /* exists */ }
  if (!isFile(reg)) Deno.writeTextFileSync(reg, "");
}
// Append a captured stderr tail to a failure message, so the underlying tool's
// own error (docker daemon down, CLI update notice, …) isn't swallowed.
function withStderr(msg: string, err: string): string {
  const t = err.trim();
  return t === "" ? msg : `${msg}\n  ${t.split(/\r?\n/).slice(-3).join("\n  ")}`;
}
async function readLine(prompt: string): Promise<string> {
  await Deno.stdout.write(new TextEncoder().encode(prompt));
  const buf = new Uint8Array(256);
  const n = await Deno.stdin.read(buf);
  return n === null ? "" : new TextDecoder().decode(buf.subarray(0, n)).trim();
}

const UP_USAGE = "usage: supa up <project...> [--exclude <containers>] [--json]";

// `--exclude` / `-x` is this invocation only. It is not written to config.toml;
// the next `up` without the flag starts whatever `[section] enabled` says.
function parseUpArgs(rest: string[]): { names: string[]; exclude: string | null; json: boolean } {
  const names: string[] = [];
  const parts: string[] = [];
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--json") {
      json = true;
      continue;
    }
    if (a === "--exclude" || a === "-x") {
      const v = rest[++i];
      if (v === undefined || v.startsWith("-")) die(UP_USAGE);
      if (v.trim() === "") die(UP_USAGE);
      parts.push(v);
      continue;
    }
    names.push(a);
  }
  if (names.length < 1) die(UP_USAGE);
  return { names, exclude: parts.length ? parts.join(",") : null, json };
}

export async function cmdUp(rest: string[]): Promise<void> {
  const { names: raw, exclude, json } = parseUpArgs(rest);
  // Validate every name + the max-active budget BEFORE starting anyone, so a
  // later failure can't leave earlier stacks up under a broken partial run.
  // Deduplicate so `supa up web web` is one start, not a false max-active hit.
  const list = uniqueNames(raw);
  for (const p of list) {
    requireProject(p);
    requireCfg(p);
    refuseSharedProjectId(p);
  }
  await guardMany(list);
  for (const p of list) await prepareSlot(p);
  await guardRam(list);
  const projects: Array<
    { name: string; ok: boolean; ports?: { api: string; db: string; studio: string } }
  > = [];
  for (const p of list) {
    try {
      await startStack(p, exclude ? { exclude, json } : { json });
      projects.push({
        name: p,
        ok: true,
        ports: { api: shownPort(p, "api"), db: shownPort(p, "db"), studio: shownPort(p, "studio") },
      });
    } catch (e) {
      if (!(e instanceof CommandFailed)) throw e;
      projects.push({ name: p, ok: false });
      if (json) console.log(JSON.stringify({ projects }, null, 2));
      die(e.message);
    }
  }
  if (json) console.log(JSON.stringify({ projects }, null, 2));
}
export async function cmdDown(rest: string[]): Promise<void> {
  if (rest.length < 1) die("usage: supa down <project...> | supa down --all");
  // --all: stop every *stoppable* registered stack. A broken registry row
  // (no config.toml) is warned + skipped so one bad entry cannot block an
  // emergency "stop everything". Named lists stay strict (refuse the whole
  // batch) so `down a b` never stops A then dies on B.
  if (rest[0] === "--all") {
    const list: string[] = [];
    for (const p of names()) {
      if (!cfgDir(p)) {
        console.error(
          `  warning: skipping '${p}' — no supabase/config.toml under '${rootOf(p)}'`,
        );
        continue;
      }
      list.push(p);
    }
    const failures: string[] = [];
    for (const p of list) {
      try {
        await stopStack(p);
      } catch (e) {
        if (!(e instanceof CommandFailed)) throw e;
        failures.push(`${p}: ${e.message}`);
      }
    }
    if (failures.length) {
      console.error("supa: down --all did not stop every project:");
      for (const f of failures) console.error(`  ${f}`);
      Deno.exit(1);
    }
    return;
  }
  // Deduplicate like up/restart — `down web web` must not stop then fail.
  const list = uniqueNames(rest);
  for (const p of list) {
    requireProject(p);
    requireCfg(p);
  }
  for (const p of list) await stopOrDie(p);
}
export async function cmdSwitch(rest: string[]): Promise<void> {
  if (rest.length !== 1) die("usage: supa switch <project>");
  const target = rest[0];
  if (rootOf(target) === null) die(`unknown project '${target}' (known: ${names().join(" ")})`);
  // Resolve the target BEFORE mutating anyone, so an unresolvable project doesn't
  // tear down every running stack and then fail.
  if (!cfgDir(target)) die(`no supabase/config.toml under '${rootOf(target)}' for '${target}'`);
  const tgt = labelOf(target);
  if (!tgt) die(`cannot resolve project_id for '${target}'`);
  refuseSharedProjectId(target);
  const running = await runningLabels();
  const alreadyUp = running.includes(tgt);
  const { value: max } = readMaxActive();
  const hasRoom = alreadyUp || max === Infinity || running.length + 1 <= max;
  if (!alreadyUp) {
    await prepareSlot(target);
    await guardRam([target], { stopOthersFirst: !hasRoom });
  }
  if (alreadyUp || hasRoom) {
    const startedHere = !alreadyUp;
    if (startedHere) await startOrDie(target);
    const stopped: string[] = [];
    for (const l of await runningLabels()) {
      if (l === tgt) continue;
      const nm = nameForLabel(l);
      if (!nm) {
        console.error(`! running stack '${l}' not in registry — leaving it up`);
        continue;
      }
      try {
        await stopStack(nm);
        stopped.push(nm);
      } catch (e) {
        if (!(e instanceof CommandFailed)) throw e;
        await undoPartialSwitch(target, startedHere, stopped);
        die(`could not stop '${nm}' during switch: ${e.message}`);
      }
    }
    return;
  }
  const stopped: string[] = [];
  for (const l of running) {
    if (l === tgt) continue;
    const nm = nameForLabel(l);
    if (!nm) {
      console.error(`! running stack '${l}' not in registry — leaving it up`);
      continue;
    }
    try {
      await stopStack(nm);
      stopped.push(nm);
    } catch (e) {
      if (!(e instanceof CommandFailed)) throw e;
      await restoreStopped(stopped);
      die(`could not stop '${nm}' before switch: ${e.message}`);
    }
  }
  try {
    await startStack(target);
  } catch (e) {
    if (!(e instanceof CommandFailed)) throw e;
    const stillDown = await restoreStopped(stopped);
    const extra = stillDown.length ? `\n  still down: ${stillDown.join(", ")}` : "";
    die(`${e.message}${extra}`);
  }
}
async function undoPartialSwitch(
  target: string,
  startedHere: boolean,
  stopped: string[],
): Promise<void> {
  if (startedHere) {
    try {
      await stopStack(target);
    } catch (e) {
      if (e instanceof CommandFailed) {
        console.error(`supa: could not stop '${target}' after the switch failed: ${e.message}`);
      } else throw e;
    }
  }
  const stillDown = await restoreStopped(stopped);
  if (stillDown.length) console.error(`supa: still down: ${stillDown.join(", ")}`);
}
async function restoreStopped(namesToUp: string[]): Promise<string[]> {
  const failed: string[] = [];
  for (const n of namesToUp) {
    try {
      await startStack(n);
    } catch {
      failed.push(n);
    }
  }
  return failed;
}
export async function cmdRestart(rest: string[]): Promise<void> {
  if (rest.length < 1) die("usage: supa restart <project...>");
  const list = uniqueNames(rest);
  for (const p of list) {
    requireProject(p);
    requireCfg(p);
    refuseSharedProjectId(p);
  }
  // Same preflight as up: starting every currently-down name in this list must
  // fit under max-active (already-up ones are net-zero). Refuse the whole batch
  // before stopping/starting anyone.
  await guardMany(list);
  for (const p of list) await prepareSlot(p);
  await guardRam(list);
  const running = await runningLabels();
  for (const p of list) {
    const lbl = labelOf(p);
    const wasRunning = !!lbl && running.includes(lbl);
    if (wasRunning) await stopOrDie(p);
    await startOrDie(p, {
      failHint: wasRunning
        ? `'${p}' is stopped. Its volumes were kept. Retry: supa up ${p}`
        : undefined,
    });
  }
}
export async function cmdEnv(rest: string[]): Promise<void> {
  const write = rest.includes("--write") || rest.includes("-w");
  const json = rest.includes("--json");
  const args = rest.filter((a) => a !== "--write" && a !== "-w" && a !== "--json");
  if (json && write) die("usage: supa env <project> [--json] | supa env <project> --write [file]");
  if (args.length < 1 || args.length > 2) {
    die("usage: supa env <project> [--json] [--write [file]]");
  }
  const p = args[0];
  const wd = cfgDir(p);
  if (!wd) die(`unresolvable project '${p}'`);
  const overlay = portOverlay(p);
  if (!write) {
    if (!json) {
      const code = await runInherit(
        supabaseCmd(),
        ["--workdir", wd, "status", "-o", "env"],
        overlay,
      );
      if (code === 127) die(SUPABASE_MISSING);
      if (code !== 0) Deno.exit(code);
      return;
    }
    const got = await runCapture(supabaseCmd(), ["--workdir", wd, "status", "-o", "env"], overlay);
    if (got.code === 127) die(SUPABASE_MISSING);
    if (got.code !== 0) die(withStderr(`could not read env for '${p}'`, got.err));
    const env: Record<string, string> = {};
    for (const line of got.out.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m) env[m[1]] = m[2];
    }
    console.log(JSON.stringify({ project: p, env }, null, 2));
    return;
  }
  const { code, out, err } = await runCapture(supabaseCmd(), [
    "--workdir",
    wd,
    "status",
    "-o",
    "env",
  ], overlay);
  if (code === 127) die(SUPABASE_MISSING);
  if (code !== 0 || out.trim() === "") {
    die(withStderr(`could not read env for '${p}' — is it up? try 'supa up ${p}'`, err));
  }
  const target = args[1] ?? join(wd, ".env.local");
  const fileMap = readEnvMap(wd);
  const envMap = fileMap.length ? fileMap : DEFAULT_ENV_MAP;
  let incoming = out;
  const applied = applyEnvMap(out, envMap);
  incoming = applied.incoming;
  if (applied.missing.length) {
    console.error(
      `  warning: ${
        fileMap.length ? "supa.env.map" : "default env map"
      } references keys not in supabase output: ${applied.missing.join(", ")}`,
    );
  }
  const existing = isFile(target) ? readTextFile(target) : "";
  const { text, keys, map } = mergeDotenv(existing, incoming);
  // Holds service keys — owner-only, tightening an existing file's perms too.
  Deno.writeTextFileSync(target, text, { mode: 0o600 });
  console.log(`supa: wrote ${keys.length} keys to ${target}`);
  for (const k of keys) console.log(`  ${k}=${maskSecret(k, map[k])}`);
  console.log(
    fileMap.length
      ? `  mapped via ${join(wd, "supa.env.map")}`
      : `  mapped via the default rename table (anon/service_role and publishable/secret)`,
  );
}
function unmanagedLabels(running: Set<string>): string[] {
  const known = new Set<string>();
  for (const n of names()) {
    const lbl = labelOf(n);
    if (lbl) known.add(lbl);
  }
  return [...running].filter((l) => !known.has(l)).sort();
}
async function planSlots(): Promise<Map<string, number>> {
  const base = await portHolders();
  const taken = new Set(base.keys());
  const plan = new Map<string, number>();
  for (const n of [...names()].sort()) {
    const found = foundPorts(n);
    if (!found || !hasAutoPort(found)) continue;
    const saved = readProjectSlot(n);
    const remembered = typeof saved === "number" && slotAutosFree(n, found, saved, base)
      ? saved
      : null;
    const slot = remembered ?? firstFreeSlot(taken, found);
    if (slot === null) continue;
    plan.set(n, slot);
    for (const port of Object.values(effectivePorts(found, slot))) taken.add(port);
  }
  return plan;
}
export async function cmdLs(rest: string[] = []): Promise<void> {
  const running = new Set(await runningLabels());
  const projects = readRegistry().sort((a, b) => (a.name < b.name ? -1 : 1));
  const unmanaged = unmanagedLabels(running);
  const plan = await planSlots();
  const port = (name: string, key: HostKey) => shownPort(name, key, plan.get(name) ?? null);
  if (rest.includes("--json")) {
    const out = {
      projects: projects.map((p) => {
        const lbl = labelOf(p.name);
        return {
          name: p.name,
          label: lbl,
          api: port(p.name, "api"),
          db: port(p.name, "db"),
          studio: port(p.name, "studio"),
          status: lbl && running.has(lbl) ? "up" : "down",
          root: p.root,
          managed: true,
        };
      }),
      unmanaged: unmanaged.map((label) => ({ label, managed: false })),
    };
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  const widths = [8, 9, 7, 7, 7, 7];
  const row = (c: string[]) => {
    let s = "";
    for (let i = 0; i < widths.length; i++) s += c[i].padEnd(widths[i]) + " ";
    console.log(s + c[widths.length]);
  };
  row(["NAME", "LABEL", "API", "DB", "STUDIO", "STATUS", "ROOT"]);
  for (const p of projects) {
    const lbl = labelOf(p.name) ?? "?";
    row([
      p.name,
      lbl,
      port(p.name, "api"),
      port(p.name, "db"),
      port(p.name, "studio"),
      running.has(lbl) ? "UP" : "down",
      p.root,
    ]);
  }
  if (unmanaged.length) {
    console.log("");
    console.log("not managed by supa (running, not in the registry):");
    for (const label of unmanaged) console.log(`  ${label}`);
  }
}
export async function cmdStatus(rest: string[] = []): Promise<void> {
  const json = rest.includes("--json");
  const fmt = '{{.Label "com.supabase.cli.project"}}\\t{{.Names}}\\t{{.Status}}';
  const { code, out, err } = await runCapture("docker", [
    "ps",
    "--filter",
    "label=com.supabase.cli.project",
    "--format",
    json ? fmt : `table ${fmt}`,
  ]);
  if (code !== 0) die(withStderr("docker not available", err));
  const lines = out.split(/\r?\n/).filter((l) => l.length > 0);
  if (json) {
    const rows = lines.map((l) => {
      const [project, container, status] = l.split("\t");
      return { project: project ?? "", container: container ?? "", status: status ?? "" };
    }).sort((a, b) => (a.container < b.container ? -1 : 1));
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (lines.length === 0) return;
  console.log(lines[0]);
  const body = lines.slice(1).sort();
  if (body.length) console.log(body.join("\n"));
}
export function cmdConfig(rest: string[]): void {
  if (rest[0] === "--json") {
    const { value, source } = readMaxActive();
    console.log(JSON.stringify(
      {
        version: VERSION,
        os: OS,
        supaHome: Deno.env.get("SUPA_HOME") ?? null,
        configDir: configDir(),
        registry: registryPath(),
        registryExists: isFile(registryPath()),
        configFile: configPath(),
        configFileExists: isFile(configPath()),
        maxActive: value === Infinity ? null : value,
        maxActiveSource: source,
        ramBudgetGb: readRamBudget(),
        backupDir: readBackupDir(),
        parked: parkedDirs(),
      },
      null,
      2,
    ));
    return;
  }
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
    console.log(`  backup_dir:  ${readBackupDir() ?? "(unset → <project>/backups/)"}`);
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
  if (rest[0] === "backup-dir") {
    if (rest.length !== 2) die("usage: supa config backup-dir <path>");
    setConfigKey("backup_dir", absolutize(rest[1].trim()));
    return;
  }
  die(
    `unknown config key '${rest[0]}' ` +
      `(try: supa config [max-active <n> | ram-budget <gb> | backup-dir <path>])`,
  );
}
export async function cmdLogs(rest: string[]): Promise<void> {
  if (rest.length < 1) die("usage: supa logs <project> [service] [--since <time>] [-f]");
  const p = rest[0];
  requireProject(p);
  const lbl = labelOf(p);
  if (!lbl) die(`cannot resolve docker label for '${p}'`);
  let follow = false;
  let since: string | undefined;
  let svc: string | undefined;
  for (let i = 1; i < rest.length; i++) {
    const a = rest[i];
    if (a === "-f" || a === "--follow") {
      follow = true;
      continue;
    }
    if (a === "--since") {
      since = requireArg(rest, ++i, "usage: supa logs <project> [service] [--since <time>] [-f]");
      continue;
    }
    if (a.startsWith("-")) die(`unknown flag '${a}'`);
    if (svc) die("usage: supa logs <project> [service] [--since <time>] [-f]");
    svc = a;
  }
  const { out } = await runCapture("docker", [
    "ps",
    "-a",
    "--filter",
    `label=com.supabase.cli.project=${lbl}`,
    "--format",
    "{{.Names}}\t{{.Status}}",
  ]);
  const rows = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map((line) => {
    const [name, status = ""] = line.split("\t");
    return { name, status };
  });
  if (rows.length === 0) die(`no containers for '${p}' — destroyed stacks have no logs`);
  const svcOf = (c: string) =>
    c.replace(/^supabase_/, "").replace(new RegExp(`_${escapeRegExp(lbl)}$`), "");
  if (!svc) {
    console.log(`services for '${p}':`);
    for (const c of rows.map((r) => r.name).sort()) console.log(`  ${svcOf(c)}`);
    console.log(`\nusage: supa logs ${p} <service> [--since <time>] [-f]`);
    return;
  }
  const match = rows.find((r) => svcOf(r.name) === svc);
  if (!match) {
    die(
      `no service '${svc}' in '${p}' (have: ${rows.map((r) => svcOf(r.name)).sort().join(", ")})`,
    );
  }
  const running = /^up\b/i.test(match.status);
  const args = ["logs", "--tail", "200"];
  if (since) args.push("--since", since);
  if (follow && running) args.push("-f");
  if (follow && !running) {
    console.error(`supa: '${svc}' is stopped — printing logs without --follow`);
  }
  args.push(match.name);
  await runInherit("docker", args);
}
export async function cmdDestroy(rest: string[]): Promise<void> {
  const yes = rest.includes("--yes") || rest.includes("-y");
  const targets = rest.filter((a) => a !== "--yes" && a !== "-y");
  if (targets.length !== 1) {
    die("usage: supa destroy <project> [--yes]   (one at a time — this deletes data)");
  }
  const p = targets[0];
  const wd = cfgDir(p);
  if (!wd) die(`unresolvable project '${p}'`);
  const lbl = labelOf(p);
  if (!lbl) die(`cannot resolve project_id for '${p}'`);
  console.error(`⚠ destroy '${p}' — STOPS the stack and DELETES its local data`);
  console.error(`  (containers + volumes for docker label '${lbl}'). This cannot be undone.`);
  if (!yes) {
    const ans = await readLine(`  type '${p}' to confirm: `);
    if (ans !== p) die("aborted (confirmation did not match)");
  }
  console.log(`== destroying ${p}`);
  const code = await runInherit(supabaseCmd(), ["--workdir", wd, "stop", "--no-backup"]);
  if (code === 127) die(SUPABASE_MISSING);
  if (code !== 0) die(`'supabase stop --no-backup' failed for '${p}' (exit ${code})`);
  const volsLs = await runCapture("docker", [
    "volume",
    "ls",
    "-q",
    "--filter",
    `label=com.supabase.cli.project=${lbl}`,
  ]);
  if (volsLs.code !== 0) {
    die(
      withStderr(
        `stopped '${p}' but could not list its volumes — data may still be on disk`,
        volsLs.err,
      ),
    );
  }
  const vols = volsLs.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (vols.length) {
    const rm = await runCapture("docker", ["volume", "rm", ...vols]);
    if (rm.code !== 0) {
      die(
        withStderr(
          `destroyed containers for '${p}' but failed to remove ${vols.length} volume(s):\n` +
            `  ${vols.join(" ")}\n` +
            `  retry: docker volume rm ${vols.join(" ")}`,
          rm.err,
        ),
      );
    }
    console.log(`  removed ${vols.length} volume(s)`);
  }
  console.log(`✓ destroyed ${p}`);
}
export async function cmdAdd(rest: string[]): Promise<void> {
  const pos: string[] = [];
  let init = false;
  let slot: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--init") init = true;
    else if (rest[i] === "--slot") {
      slot = requireArg(rest, ++i, `usage: supa add <name> <path> [--init] [--slot 0-${SLOT_MAX}]`);
    } else pos.push(rest[i]);
  }
  if (pos.length !== 2) die(`usage: supa add <name> <path> [--init] [--slot 0-${SLOT_MAX}]`);
  if (slot !== undefined && (!/^\d+$/.test(slot) || Number(slot) > SLOT_MAX)) {
    die(`--slot must be 0-${SLOT_MAX}`);
  }
  const [name, path] = pos;
  if (!SAFE_NAME.test(name)) die(`invalid name '${name}' (use letters/digits/._-)`);
  // Create empty registry before names() — readRegistry dies if the file is missing.
  ensureRegistry();
  // Explicit entries only — park-discovered names may be overridden (explicit wins).
  if (hasExplicitEntry(name)) die(`'${name}' is already registered`);
  const overridesPark = names().includes(name);
  // Store absolute — a relative path would break `supa` from another cwd.
  const abs = absolutize(path);
  if (!isDir(abs)) console.error(`  warning: '${abs}' is not a directory (registering anyway)`);

  // A requested slot is checked before the registry write so a clash leaves no row.
  // File-mode configs ignore --slot; their ports stay in config.toml.
  const alreadyConfigured = init && cfgCandidates(abs).length > 0;
  const prefer = slot === undefined ? undefined : Number(slot);
  const existingToml = cfgCandidates(abs)[0];
  const existingFound = existingToml && isFile(join(existingToml, "supabase", "config.toml"))
    ? readHostPorts(readTextFile(join(existingToml, "supabase", "config.toml")))
    : null;
  if (init && prefer !== undefined && existingFound && hasAutoPort(existingFound)) {
    const holders = await portHolders();
    if (!slotAutosFree(name, existingFound, prefer, holders)) {
      die(`slot ${prefer} is not free on this machine.`);
    }
  }

  const reg = registryPath();
  const prev = isFile(reg) ? readTextFile(reg) : "";
  const sep = prev.length && !prev.endsWith("\n") ? "\n" : "";
  Deno.writeTextFileSync(reg, `${prev}${sep}${name}|${abs}\n`);
  console.log(`supa: added ${name} -> ${abs}`);
  if (overridesPark) {
    console.log(`  (overrides park-discovered '${name}' — explicit entry wins)`);
  }

  if (init) {
    // Nested apps/*/examples/* configs count — don't scaffold a root that would
    // shadow them (cfgDir prefers root once it exists).
    if (alreadyConfigured) {
      console.error(`  note: supabase/config.toml already exists — skipping 'supabase init'`);
    } else {
      console.log(`>> supabase init (${abs})`);
      const code = await runInherit(supabaseCmd(), ["--workdir", abs, "init"]);
      if (code === 127 || code !== 0) {
        // Roll back the line we just wrote — leave no half-applied entry.
        try {
          Deno.writeTextFileSync(reg, prev);
        } catch { /* best-effort */ }
        if (code === 127) die(SUPABASE_MISSING);
        die(`'supabase init' failed for '${name}' (exit ${code})`);
      }
    }
    const foundNow = foundPorts(name);
    if (foundNow && !hasAutoPort(foundNow)) {
      console.log(`  every host port is set in config.toml — left as written`);
    } else if (foundNow) {
      const assigned = await prepareSlot(name, prefer);
      if (assigned !== null) {
        console.log(`  this machine will use slot ${assigned} — config.toml was not changed`);
      }
    }
  }
  const wd = cfgDir(name);
  if (wd) {
    console.log(
      `  config: ${join(wd, "supabase", "config.toml")} (label: ${labelOf(name) ?? "?"})`,
    );
  } else console.error(`  note: no supabase/config.toml found under it yet`);
}
export function cmdRm(rest: string[]): void {
  if (rest.length !== 1) die("usage: supa rm <name>");
  const name = rest[0];
  if (!names().includes(name)) die(`'${name}' is not in the registry`);
  const reg = registryPath();
  const lines = readTextFile(reg).split(/\r?\n/);
  let hadExplicit = false;
  const kept = lines.filter((line) => {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) return true;
    const i = t.indexOf("|");
    if (i < 1) return true;
    const n = t.slice(0, i).trim();
    if (n === "*" || n !== name) return true;
    hadExplicit = true;
    return false;
  });
  // Park discoveries live under `*|dir` — rm cannot drop them (use unpark).
  if (!hadExplicit) {
    die(
      `'${name}' is park-discovered, not an explicit registry entry — ` +
        `unpark the parent dir (supa unpark <dir>)`,
    );
  }
  Deno.writeTextFileSync(reg, kept.join("\n").replace(/\n+$/, "\n"));
  // Dropping an explicit override can resurface the same name from a parked dir.
  if (names().includes(name)) {
    console.error(
      `supa: removed the explicit '${name}' override — a parked dir still exposes it ` +
        `(unpark the parent to drop it fully)`,
    );
    return;
  }
  console.log(`supa: removed ${name} from the registry`);
}
// Opt-in auto-discovery: a parked dir's immediate subdirs that contain a
// supabase/config.toml appear as projects (named after the subdir). Projects
// without Supabase are simply never picked up; explicit `add` entries win.
export function cmdPark(rest: string[]): void {
  if (rest.length === 0) {
    const dirs = parkedDirs();
    if (dirs.length === 0) {
      console.log("no parked dirs — park one: supa park <dir>");
      return;
    }
    for (const d of dirs) console.log(d);
    return;
  }
  if (rest.length !== 1) die("usage: supa park [<dir>]");
  const abs = absolutize(rest[0]);
  if (!isDir(abs)) die(`'${abs}' is not a directory`);
  ensureRegistry();
  if (parkedDirs().some((d) => pathsEqual(d, abs))) die(`'${abs}' is already parked`);
  // Capture names already claimed (explicit + earlier parks) BEFORE writing, so
  // we can warn about shadowed subdirs that readRegistry will silently skip.
  const taken = new Set(names());
  const reg = registryPath();
  const prev = isFile(reg) ? readTextFile(reg) : "";
  const sep = prev.length && !prev.endsWith("\n") ? "\n" : "";
  Deno.writeTextFileSync(reg, `${prev}${sep}*|${abs}\n`);
  console.log(`supa: parked ${abs}`);
  const discovered: string[] = [];
  const shadowed: string[] = [];
  for (const s of Deno.readDirSync(abs)) {
    // Same filter as discovery in readRegistry — never announce a name it won't register.
    if (!s.isDirectory || !SAFE_NAME.test(s.name)) continue;
    if (!isFile(join(abs, s.name, "supabase", "config.toml"))) continue;
    if (taken.has(s.name)) shadowed.push(s.name);
    else discovered.push(s.name);
  }
  if (discovered.length) {
    console.log(`  discovered: ${discovered.sort().join(", ")}`);
  } else if (shadowed.length === 0) {
    console.log(
      `  (no supabase projects in it yet — subdirs appear in 'supa ls' as you create them)`,
    );
  }
  if (shadowed.length) {
    console.error(
      `  shadowed (existing entry wins): ${shadowed.sort().join(", ")}`,
    );
  }
}
export function cmdUnpark(rest: string[]): void {
  if (rest.length !== 1) die("usage: supa unpark <dir>");
  const abs = absolutize(rest[0]);
  if (!parkedDirs().some((d) => pathsEqual(d, abs))) {
    die(`'${abs}' is not parked ('supa park' lists parked dirs)`);
  }
  const reg = registryPath();
  const kept = readTextFile(reg).split(/\r?\n/).filter((line) => {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) return true;
    const i = t.indexOf("|");
    if (i < 1) return true;
    // Same shape as parseRegistry — allow "* |/path" spacing.
    if (t.slice(0, i).trim() !== "*") return true;
    return !pathsEqual(absolutize(t.slice(i + 1).trim()), abs);
  });
  Deno.writeTextFileSync(reg, kept.join("\n").replace(/\n+$/, "\n"));
  console.log(`supa: unparked ${abs}  (its projects leave the registry; nothing is stopped)`);
}
// Hidden helper for shell completions: project names, one per line.
export function cmdNames(): void {
  for (const n of names()) console.log(n);
}
export async function cmdPorts(rest: string[]): Promise<void> {
  if (rest.includes("--force") || rest.includes("-f")) {
    die("supa ports no longer rewrites config.toml. Edit a committed port band in the file.");
  }
  if (rest.length < 1 || rest.length > 2) die(`usage: supa ports <name> [slot 0-${SLOT_MAX}]`);
  const name = rest[0];
  requireProject(name);
  const wd = cfgDir(name);
  const found = foundPorts(name);
  if (!wd || !found) die(`no supabase/config.toml for '${name}'`);
  if (!hasAutoPort(found)) {
    die(`'${name}' sets every host port in config.toml. Those values are used as written.`);
  }
  const prefer = rest[1] === undefined ? undefined : Number(rest[1]);
  if (rest[1] !== undefined && !/^\d+$/.test(rest[1])) die(`slot must be 0-${SLOT_MAX}`);
  const slot = await prepareSlot(name, prefer);
  if (slot === null) die(`no free port slot (0-${SLOT_MAX}) on this machine`);
  const ports = effectivePorts(found, slot);
  console.log(
    `supa: ${name} slot ${slot} on this machine — API ${ports.api}  DB ${ports.db}  Studio ${ports.studio}`,
  );
  console.log(`  remembered in ${slotsPath()}. config.toml was not changed.`);
  console.log(`  apply with: supa restart ${name}`);
}
// Oldest CLI verified to support everything supa drives (signing_keys_path, status -o env).
const MIN_SUPABASE_CLI = "2.30.0";

export async function cmdDoctor(rest: string[] = []): Promise<void> {
  const json = rest.includes("--json");
  const report: Record<string, unknown> = {};
  const say = (line: string) => {
    if (!json) console.log(line);
  };
  const ok = (b: boolean) => (b ? "✓" : "✗");
  say("supa doctor");
  const dv = await runCapture("docker", ["version", "--format", "{{.Server.Version}}"]);
  const dockerUp = dv.code === 0 && dv.out.trim() !== "";
  report.docker = { ok: dockerUp, version: dockerUp ? dv.out.trim() : null };
  say(
    `  ${ok(dockerUp)} docker daemon        ${
      dockerUp ? "v" + dv.out.trim() : "not running / not found"
    }`,
  );
  const sv = await runCapture(supabaseCmd(), ["--version"]);
  report.supabase = { ok: sv.code === 0, version: sv.code === 0 ? sv.out.trim() : null };
  say(
    `  ${ok(sv.code === 0)} supabase CLI         ${
      sv.code === 0 ? sv.out.trim() : "not found on PATH"
    }`,
  );
  if (sv.code === 0) {
    const v = sv.out.match(/\d+\.\d+\.\d+/)?.[0];
    if (v && semverNewer(MIN_SUPABASE_CLI, v)) {
      say(
        `     ⚠ rotate/env need supabase CLI >= ${MIN_SUPABASE_CLI} (JWT signing keys)`,
      );
    }
  }
  const reg = registryPath();
  report.registry = reg;
  say(`  ${ok(isFile(reg))} registry             ${reg}`);
  if (!isFile(reg)) {
    if (json) console.log(JSON.stringify(report, null, 2));
    return;
  }
  const projs = readRegistry();
  report.projects = projs.length;
  say(`  ${ok(projs.length > 0)} projects registered  ${projs.length}`);
  // JSON.stringify neutralizes control chars — these names failed the charset
  // rule, so they may contain anything, including terminal escapes.
  const dropped = droppedRegistryNames(readTextFile(reg));
  say(
    `  ${ok(dropped.length === 0)} registry names valid` +
      (dropped.length ? `  (${dropped.length} line(s) ignored)` : ""),
  );
  for (const n of dropped) {
    say(`     ✗ ignored (name must match [A-Za-z0-9._-]): ${JSON.stringify(n)}`);
  }
  // Relative roots still work (absolutized on read against cwd) but drift when
  // you invoke supa elsewhere — flag them so they get rewritten absolute.
  const relRoots = relativeRegistryEntries(readTextFile(reg));
  say(
    `  ${ok(relRoots.length === 0)} registry paths absolute` +
      (relRoots.length ? `  (${relRoots.length} relative)` : ""),
  );
  for (const r of relRoots) {
    say(
      `     ! ${r.name}: relative path ${JSON.stringify(r.path)} — re-add or edit to absolute`,
    );
  }
  let allCfg = true;
  for (const p of projs) {
    if (!cfgDir(p.name)) {
      allCfg = false;
      say(`     ✗ ${p.name}: no config.toml under ${p.root}`);
    }
  }
  if (allCfg && projs.length) say(`  ✓ all config.toml resolve`);
  // Multiple supabase/ trees under one registry root: cfgDir picks the first
  // (root, else alphabetical apps/*, then examples/*) — warn so the wrong stack
  // isn't bound silently.
  for (const p of projs) {
    const cands = cfgCandidates(p.root);
    if (cands.length > 1) {
      say(
        `     ! ${p.name}: ${cands.length} config.toml candidates — using ${cands[0]}`,
      );
      for (const c of cands.slice(1)) say(`       also: ${c}`);
    }
  }
  const seen: Record<string, string> = {};
  let collision = false;
  const collisions: string[] = [];
  for (const p of projs) {
    for (const sec of ["api", "db", "studio"] as const) {
      const port = shownPort(p.name, sec);
      if (!port) continue;
      if (seen[port]) {
        collision = true;
        const note = `port ${port}: ${seen[port]} vs ${p.name}.${sec}`;
        collisions.push(note);
        say(`     ✗ ${note}`);
      } else seen[port] = `${p.name}.${sec}`;
    }
  }
  report.portCollisions = collisions;
  say(`  ${ok(!collision)} no port collisions`);
  // Same docker label on two projects: switch/destroy/status attribute containers
  // to the wrong one. Surfaces here so a duplicated project_id isn't silent.
  const labels: Record<string, string> = {};
  let labelClash = false;
  for (const p of projs) {
    const lbl = labelOf(p.name);
    if (!lbl) continue;
    if (labels[lbl]) {
      labelClash = true;
      say(`     ✗ label '${lbl}': ${labels[lbl]} vs ${p.name}`);
    } else labels[lbl] = p.name;
  }
  report.duplicateProjectIds = labelClash;
  say(`  ${ok(!labelClash)} no duplicate project_id labels`);
  const { value, source } = readMaxActive();
  report.maxActive = value === Infinity ? null : value;
  report.maxActiveSource = source;
  say(`  · max_active = ${value === Infinity ? "unlimited" : value} (${source})`);
  if (json) console.log(JSON.stringify(report, null, 2));
}
export async function cmdStats(rest: string[] = []): Promise<void> {
  const json = rest.includes("--json");
  const { code, out, err } = await runCapture("docker", [
    "ps",
    "--filter",
    "label=com.supabase.cli.project",
    "--format",
    '{{.Names}}\t{{.Label "com.supabase.cli.project"}}',
  ]);
  if (code !== 0) die(withStderr("docker not available", err));
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
    if (json) {
      console.log(JSON.stringify(
        {
          containers: [],
          totalMiB: 0,
          budgetGiB: readRamBudget(),
        },
        null,
        2,
      ));
      return;
    }
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
  if (st.code !== 0) die(withStderr("docker stats failed", st.err));
  const rows = st.out.split(/\r?\n/).filter(Boolean).map((l) => l.split("\t"));
  rows.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const perProject: Record<string, number> = {};
  let grand = 0;
  const jsonRows: Array<
    { project: string; service: string; cpu: string; mem: string; mib: number }
  > = [];
  for (const [name, cpu, mem] of rows) {
    const label = labelByName[name] || (name.split("_").pop() ?? "");
    const svc = name.replace(/^supabase_/, "").replace(new RegExp(`_${escapeRegExp(label)}$`), "");
    const used = memToMiB((mem ?? "").split("/")[0]);
    perProject[label] = (perProject[label] ?? 0) + used;
    grand += used;
    jsonRows.push({ project: label, service: svc, cpu: cpu ?? "", mem: mem ?? "", mib: used });
  }
  const budget = readRamBudget();
  if (json) {
    console.log(JSON.stringify(
      {
        containers: jsonRows,
        totalMiB: grand,
        budgetGiB: budget,
        overBudget: budget !== null && grand / 1024 > budget,
      },
      null,
      2,
    ));
    return;
  }
  const w = [10, 12, 9];
  const line = (c: string[]) =>
    console.log(c[0].padEnd(w[0]) + " " + c[1].padEnd(w[1]) + " " + c[2].padEnd(w[2]) + " " + c[3]);
  line(["PROJECT", "SERVICE", "CPU%", "MEM"]);
  for (const row of jsonRows) line([row.project, row.service, row.cpu, row.mem]);
  console.log("");
  for (const [label, mib] of Object.entries(perProject).sort()) {
    line([label, "(total)", "", fmtMiB(mib)]);
  }
  line(["ALL", "(total)", "", fmtMiB(grand)]);
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
export async function cmdRotate(rest: string[]): Promise<void> {
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
  if (gen.code === 127) die(SUPABASE_MISSING);
  if (gen.code !== 0 || gen.out.trim() === "") {
    die(withStderr(`'supabase gen signing-key' failed for '${p}'`, gen.err));
  }
  const cfgText = readTextFile(f);
  const { text: newCfg, relPath } = ensureSigningKeysPath(cfgText);
  // Supabase resolves signing_keys_path relative to the supabase/ directory
  // (where config.toml lives), and the file must be a JSON *array* of JWKs.
  // Confine the write — a path with `..` or absolute/~ must not escape the
  // project (parked configs must not turn rotate into an arbitrary write).
  const supabaseDir = join(wd, "supabase");
  const keyFile = resolveUnder(supabaseDir, relPath);
  if (!keyFile) {
    die(
      `signing_keys_path ${JSON.stringify(relPath)} escapes ${supabaseDir} ` +
        `(or is absolute) — refuse to write the private key outside the project`,
    );
  }
  let keyArrayText: string;
  try {
    keyArrayText = signingKeyArray(gen.out);
  } catch (e) {
    die(`bad signing key from the Supabase CLI: ${e instanceof Error ? e.message : e}`);
  }
  // Nested signing_keys_path (e.g. ./keys/jwt.json) needs its parent created.
  try {
    Deno.mkdirSync(parentDir(keyFile), { recursive: true });
  } catch { /* exists */ }
  // Private key material: owner-only. Deno applies mode on rewrite too, so a
  // world-readable file from an older supa is tightened here. No-op on Windows.
  Deno.writeTextFileSync(keyFile, keyArrayText, { mode: 0o600 });
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
    await stopOrDie(p);
    await startOrDie(p);
  } else {
    console.log(`  '${p}' isn't running — start it to apply: supa up ${p}`);
  }
  console.log(`✓ rotated ${p}`);
}
// Dump `type` (roles/schema/data, or full) for project p into finalPath, atomically:
// each part → a temp file, streamed into a .partial in restore order, then renamed
// so a failed dump never leaves a usable-looking file. Streams (does not hold the
// whole dump in memory). Throws on failure; callers die. Assumes the target
// directory already exists and the stack is up.
async function performBackup(
  p: string,
  wd: string,
  type: BackupType,
  useCopy: boolean,
  finalPath: string,
): Promise<void> {
  const partial = `${finalPath}.partial`;
  const dataArgs = useCopy ? ["--data-only", "--use-copy"] : ["--data-only"];
  const partsFor: Record<BackupType, Array<{ label: string; args: string[] }>> = {
    roles: [{ label: "roles", args: ["--role-only"] }],
    schema: [{ label: "schema", args: [] }],
    data: [{ label: "data", args: dataArgs }],
    full: [
      { label: "roles", args: ["--role-only"] },
      { label: "schema", args: [] },
      { label: "data", args: dataArgs },
    ],
  };
  const parts = partsFor[type];
  const temps: string[] = [];
  let outFile: Deno.FsFile | null = null;
  try {
    // Dumps hold real data — owner-only; rename carries the mode to finalPath.
    outFile = await Deno.open(partial, {
      write: true,
      create: true,
      truncate: true,
      mode: 0o600,
    });
    const enc = new TextEncoder();
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const tmp = Deno.makeTempFileSync({ prefix: `supa-backup-${p}-`, suffix: ".sql" });
      temps.push(tmp);
      const code = await runInherit(
        supabaseCmd(),
        ["--workdir", wd, "db", "dump", "--local", ...part.args, "-f", tmp],
        portOverlay(p),
      );
      if (code === 127) throw new Error(SUPABASE_MISSING);
      if (code !== 0) {
        throw new Error(`'supabase db dump' (${part.label}) failed for '${p}' (exit ${code})`);
      }
      // Match the old string-join layout: "\n" between parts; a section header when
      // concatenating a multi-part (full) dump.
      if (i > 0) await outFile.write(enc.encode("\n"));
      if (parts.length > 1) {
        await outFile.write(enc.encode(`-- >>> supa backup: ${part.label} <<<\n`));
      }
      using src = await Deno.open(tmp, { read: true });
      const buf = new Uint8Array(64 * 1024);
      while (true) {
        const n = await src.read(buf);
        if (n === null) break;
        await outFile.write(buf.subarray(0, n));
      }
    }
    outFile.close();
    outFile = null;
    Deno.renameSync(partial, finalPath);
  } catch (e) {
    try {
      outFile?.close();
    } catch { /* ignore */ }
    try {
      Deno.removeSync(partial);
    } catch { /* ignore */ }
    throw e;
  } finally {
    for (const t of temps) {
      try {
        Deno.removeSync(t);
      } catch { /* ignore */ }
    }
  }
}
function fmtBytes(bytes: number): string {
  const kib = bytes / 1024;
  return kib >= 1024 ? `${(kib / 1024).toFixed(1)} MiB` : `${Math.max(1, Math.round(kib))} KiB`;
}
// `docker exec` args to feed a dump into a stack's psql. --single-transaction
// (tx) makes the load atomic; ON_ERROR_STOP fails loudly instead of half-applying.
function psqlArgs(container: string, dbName: string, tx: boolean): string[] {
  const a = [
    "exec",
    "-i",
    container,
    "psql",
    "-U",
    "postgres",
    "-d",
    dbName,
    "-v",
    "ON_ERROR_STOP=1",
  ];
  if (tx) a.push("--single-transaction");
  return a;
}
export async function cmdBackup(rest: string[]): Promise<void> {
  const usage =
    "usage: supa backup <project> [--data-only|--schema-only|--roles-only] [--out <dir>] [--use-copy]";
  const knownFlags = new Set([
    "--data-only",
    "--schema-only",
    "--roles-only",
    "--use-copy",
  ]);
  const flags = new Set<string>();
  const pos: string[] = [];
  let out: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--out") out = requireArg(rest, ++i, usage);
    else if (a.startsWith("-")) flags.add(a);
    else pos.push(a);
  }
  for (const f of flags) {
    if (!knownFlags.has(f)) die(`unknown flag '${f}'\n${usage}`);
  }
  if (pos.length !== 1) die(usage);
  const p = pos[0];
  requireProject(p);
  const wd = cfgDir(p);
  if (!wd) die(`unresolvable project '${p}'`);

  // Exactly one part-selector, or none → the project's backup.type hook, else full.
  const picked =
    ([["--data-only", "data"], ["--schema-only", "schema"], ["--roles-only", "roles"]] as const)
      .filter(([f]) => flags.has(f));
  if (picked.length > 1) die("choose only one of --data-only / --schema-only / --roles-only");
  const type: BackupType = picked.length ? picked[0][1] : (readHooks(wd).backupType ?? "full");
  const useCopy = flags.has("--use-copy");

  // A dump reads the live DB, so the stack has to be up.
  const lbl = labelOf(p);
  if (!lbl || !(await runningLabels()).includes(lbl)) {
    die(`'${p}' isn't running — start it first: supa up ${p}`);
  }

  let dir: string;
  try {
    dir = resolveBackupDir({ out, configured: readBackupDir(), projectRoot: rootOf(p) });
  } catch {
    die(`could not resolve a backup directory for '${p}' (pass --out <dir>)`);
  }
  try {
    Deno.mkdirSync(dir, { recursive: true });
  } catch (e) {
    die(`cannot create backup dir ${dir}: ${e instanceof Error ? e.message : e}`);
  }
  const finalPath = join(dir, backupFileName(p, type, tsStamp(new Date())));
  console.log(`>> backup ${p} (${type}) → ${finalPath}`);
  try {
    await performBackup(p, wd, type, useCopy, finalPath);
  } catch (e) {
    die(e instanceof Error ? e.message : String(e));
  }
  console.log(`✓ backed up ${p} → ${finalPath} (${fmtBytes(Deno.statSync(finalPath).size)})`);
}
export async function cmdRestore(rest: string[]): Promise<void> {
  const usage =
    "usage: supa restore <project> (<file>[.gz] | --latest) [--yes] [--db <name>] [--no-tx]";
  const knownFlags = new Set(["--latest", "--yes", "-y", "--no-tx"]);
  const flags = new Set<string>();
  const pos: string[] = [];
  let dbName = "postgres";
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--db") dbName = requireArg(rest, ++i, usage);
    else if (a.startsWith("-")) flags.add(a);
    else pos.push(a);
  }
  for (const f of flags) {
    if (!knownFlags.has(f)) die(`unknown flag '${f}'\n${usage}`);
  }
  const yes = flags.has("--yes") || flags.has("-y");
  if (pos.length < 1) die(usage);
  const p = pos[0];
  requireProject(p);
  const wd = cfgDir(p);
  if (!wd) die(`unresolvable project '${p}'`);
  const lbl = labelOf(p);
  if (!lbl) die(`cannot resolve docker label for '${p}'`);

  const dir = (() => {
    try {
      return resolveBackupDir({ configured: readBackupDir(), projectRoot: rootOf(p) });
    } catch {
      return null;
    }
  })();

  // Resolve the source dump BEFORE the safety pre-dump, so --latest never picks
  // the snapshot we're about to take.
  let file: string;
  if (flags.has("--latest")) {
    if (!dir || !isDir(dir)) die(`no backup dir for '${p}' to search — pass an explicit file`);
    const entries = [...Deno.readDirSync(dir)].filter((e) => e.isFile).map((e) => e.name);
    const pick = latestBackup(entries, p);
    if (!pick) die(`no backups for '${p}' found in ${dir}`);
    file = join(dir, pick);
  } else {
    if (pos.length < 2) die(usage);
    file = expandTilde(pos[1]);
  }
  if (!isFile(file)) die(`backup file not found: ${file}`);

  // The stack must be up (restore writes into the live DB).
  if (!(await runningLabels()).includes(lbl)) {
    die(`'${p}' isn't running — start it first: supa up ${p}`);
  }
  const container = await dbContainer(lbl);
  if (!container) die(`could not find the db container for '${p}' — is it up?`);

  console.error(`⚠ restore '${p}' — loads`);
  console.error(`  ${file}`);
  console.error(
    `  into the LIVE '${dbName}' DB (container ${container}); current data is overwritten.`,
  );
  if (!yes) {
    const ans = await readLine(`  type '${p}' to confirm: `);
    if (ans !== p) die("aborted (confirmation did not match)");
  }

  // Safety pre-dump so a bad restore is always recoverable.
  let safety = "(none — no backup dir resolved)";
  if (dir) {
    try {
      Deno.mkdirSync(dir, { recursive: true });
    } catch { /* exists */ }
    const pre = join(dir, `${p}_pre-restore_${tsStamp(new Date())}.sql`);
    console.log(`>> safety pre-dump → ${pre}`);
    try {
      await performBackup(p, wd, "full", false, pre);
      safety = pre;
    } catch (e) {
      die(
        `safety pre-dump failed — aborting before any change: ${
          e instanceof Error ? e.message : e
        }`,
      );
    }
  }

  const hooks = readHooks(wd);
  if (hooks.restorePre) await runHook("restore.pre", hooks.restorePre, wd);

  // Pipe the dump into the container's psql. --single-transaction (default) makes
  // it atomic — any error rolls the whole restore back, leaving the DB unchanged;
  // ON_ERROR_STOP=1 fails loudly instead of half-applying.
  const tx = !flags.has("--no-tx");
  console.log(`== restoring ${p} from ${file}`);
  const code = await runStdinFile("docker", psqlArgs(container, dbName, tx), file);
  if (code !== 0) {
    die(
      `restore failed (psql exit ${code}).${
        tx ? " The DB was rolled back (single transaction)." : ""
      }\n` +
        `  pre-restore snapshot: ${safety}\n` +
        `  note: a full dump conflicts with an existing schema — restore into a fresh/reset\n` +
        `  stack, or use a --data-only dump. See ${DOCS_URL}/SUPA.md`,
    );
  }
  if (hooks.restorePost) await runHook("restore.post", hooks.restorePost, wd, { soft: true });
  console.log(`✓ restored ${p} from ${file}`);
}
export async function cmdUpgrade(rest: string[]): Promise<void> {
  const usage =
    "usage: supa pg-upgrade <project> --to <major_version> [--yes] [--dry-run] [--allow-downgrade]";
  const knownFlags = new Set(["--yes", "-y", "--dry-run", "--allow-downgrade"]);
  const flags = new Set<string>();
  const pos: string[] = [];
  let to: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--to") to = requireArg(rest, ++i, usage);
    else if (a.startsWith("-")) flags.add(a);
    else pos.push(a);
  }
  for (const f of flags) {
    if (!knownFlags.has(f)) die(`unknown flag '${f}'\n${usage}`);
  }
  if (pos.length !== 1 || !to) die(usage);
  if (!/^\d+$/.test(to)) die(`--to must be a Postgres major version (got '${to}')`);
  const p = pos[0];
  requireProject(p);
  const wd = cfgDir(p);
  if (!wd) die(`unresolvable project '${p}'`);
  const f = cfgFile(p);
  if (!f) die(`no supabase/config.toml for '${p}'`);
  const lbl = labelOf(p);
  if (!lbl) die(`cannot resolve docker label for '${p}'`);

  const cfgText = readTextFile(f);
  const current = parseMajorVersion(cfgText);
  if (current === null) die(`no [db] major_version in ${f} — nothing to upgrade`);
  if (current === to) die(`'${p}' is already on Postgres ${to}`);
  // A lower target is a downgrade — Postgres has no supported downgrade, and a dump
  // from the newer version may not load into the older one. Rolling back a bad
  // upgrade (restore the pre-upgrade snapshot onto the old version) is the safe path.
  const isDowngrade = Number(to) < Number(current);
  if (isDowngrade && !flags.has("--allow-downgrade")) {
    die(
      `--to ${to} is LOWER than the current ${current} — that's a downgrade, which Postgres\n` +
        `  does not support (a ${current} dump may not load into ${to}). To undo a bad upgrade,\n` +
        `  roll back instead: restore the pre-upgrade snapshot onto the old version — see\n` +
        `  ${DOCS_URL}/SUPA.md. If you truly mean to downgrade, re-run with --allow-downgrade.`,
    );
  }

  let dir: string;
  try {
    dir = resolveBackupDir({ configured: readBackupDir(), projectRoot: rootOf(p) });
  } catch {
    die(`could not resolve a backup directory for '${p}' (needed for the data snapshot)`);
  }
  const volume = `supabase_db_${lbl}`;
  const keep = `${volume}_pg${current}`;
  const payload = join(dir, `${p}_upgrade-${current}-to-${to}_${tsStamp(new Date())}.sql`);

  console.log(`supa pg-upgrade '${p}': Postgres ${current} → ${to}`);
  console.log(`  1. data-only snapshot   → ${payload}`);
  console.log(`  2. stop the stack`);
  console.log(`  3. copy DB volume       ${volume} → ${keep}`);
  console.log(`  4. major_version ${current} → ${to} in config.toml (+ .bak)`);
  console.log(`  5. remove ${volume} so Postgres ${to} creates a new one`);
  console.log(`  6. start and restore    (delete ${keep} only after restore succeeds)`);
  if (flags.has("--dry-run")) {
    console.log("(dry run — nothing changed)");
    return;
  }

  console.error(`⚠ this rebuilds the '${p}' DB volume on Postgres ${to}.`);
  console.error(`  The old volume is copied to ${keep} and deleted only after restore succeeds.`);
  if (isDowngrade) {
    console.error(
      `  ⚠ DOWNGRADE ${current} → ${to}: a ${current} dump may not load into ${to} (unsupported by Postgres).`,
    );
  }
  console.error(`  Your data is snapshotted first, but this is a major, destructive operation.`);
  if (!(flags.has("--yes") || flags.has("-y"))) {
    const ans = await readLine(`  type '${p}' to confirm: `);
    if (ans !== p) die("aborted (confirmation did not match)");
  }

  // Snapshot needs the live DB, so the stack has to be up first.
  if (!(await runningLabels()).includes(lbl)) {
    die(`'${p}' isn't running — start it first: supa up ${p}`);
  }

  // 1. data snapshot — the recovery artifact and the restore payload.
  try {
    Deno.mkdirSync(dir, { recursive: true });
  } catch { /* exists */ }
  console.log(`>> [1/6] snapshot → ${payload}`);
  try {
    await performBackup(p, wd, "data", false, payload);
  } catch (e) {
    die(`snapshot failed — aborting before any change: ${e instanceof Error ? e.message : e}`);
  }
  const recovery = `  data snapshot: ${payload}`;

  // 2. stop
  console.log(`>> [2/6] stopping ${p}`);
  await stopOrDie(p);

  console.log(`>> [3/6] copying ${volume} → ${keep}`);
  try {
    if (await volumeExists(keep)) {
      die(
        `volume ${keep} already exists — not touching ${volume} or config.toml.\n` +
          `  Remove that leftover only if you know it is safe: docker volume rm ${keep}`,
      );
    }
    const image = await dbImage(volume);
    await copyDbVolume({ image, from: volume, to: keep });
  } catch (e) {
    if (e instanceof CommandFailed) {
      die(
        `${e.message}\n  ${volume} was not removed and config.toml was not changed.\n${recovery}`,
      );
    }
    throw e;
  }

  // 4. bump major_version (backup config first) only after the copy exists.
  console.log(`>> [4/6] major_version ${current} → ${to}`);
  const { text: bumped, changed } = setMajorVersion(cfgText, to);
  if (!changed) die(`could not update major_version in ${f}\n  old data: ${keep}\n${recovery}`);
  Deno.writeTextFileSync(`${f}.bak`, cfgText);
  Deno.writeTextFileSync(f, bumped);

  console.log(`>> [5/6] removing ${volume} so the new major can create it`);
  const rm = await runCapture("docker", ["volume", "rm", volume]);
  if (rm.code !== 0) {
    die(
      `could not remove ${volume} after copying it to ${keep}.\n` +
        `  revert config: mv ${f}.bak ${f}\n${recovery}`,
    );
  }

  console.log(`>> [6/6] starting ${p} on Postgres ${to}`);
  const preStartHint = `  old data is still in volume ${keep}\n` +
    `  revert config: mv ${f}.bak ${f}\n${recovery}`;
  // After a successful start, do NOT advise reverting major_version — the stack
  // is already on Postgres $to; reload the snapshot instead.
  const postStartHint =
    `  old data is still in volume ${keep}. Stack is on Postgres ${to}.\n${recovery}\n` +
    `  reload: supa restore ${p} ${payload}`;
  await startOrDie(p, { failHint: preStartHint, failHintAfterStart: postStartHint });

  console.log(`>> restoring data`);
  const container = await dbContainer(lbl);
  if (!container) {
    die(`stack up but no db container found — reload manually: supa restore ${p} ${payload}`);
  }
  const hooks = readHooks(wd);
  if (hooks.restorePre) {
    await runHook("restore.pre", hooks.restorePre, wd, { failHint: postStartHint });
  }
  const code = await runStdinFile("docker", psqlArgs(container, "postgres", true), payload);
  if (code !== 0) {
    die(
      `data restore failed (psql exit ${code}). The stack is up on Postgres ${to} but empty.\n` +
        `  old data is still in volume ${keep}. Revert major_version: mv ${f}.bak ${f}\n` +
        `  reload manually: supa restore ${p} ${payload}\n` +
        `  (usually a restore.pre hook to build the schema first is what's missing.)`,
    );
  }
  if (hooks.restorePost) {
    await runHook("restore.post", hooks.restorePost, wd, { soft: true });
  }
  const dropped = await runCapture("docker", ["volume", "rm", keep]);
  if (dropped.code !== 0) {
    console.error(
      `supa: upgraded, but ${keep} is still there. Remove it when you are sure: docker volume rm ${keep}`,
    );
  }
  console.log(`✓ upgraded ${p} to Postgres ${to}  (snapshot kept: ${payload})`);
}
// `supa upgrade` — update supa ITSELF from GitHub Releases (checksum-verified).
// The Postgres major upgrade lives under `supa pg-upgrade`.
export async function cmdSelfUpdate(rest: string[]): Promise<void> {
  const check = rest.includes("--check");
  if (rest.some((a) => a !== "--check")) {
    die("usage: supa upgrade [--check]   (updates supa itself; Postgres: supa pg-upgrade)");
  }
  const self = Deno.execPath();
  const compiled = !/(^|[\\/])deno(\.exe)?$/i.test(self);
  if (!check && !compiled) {
    die("self-update only works for the compiled binary (under deno: git pull + deno task build)");
  }
  const releases = `https://github.com/${REPO}/releases`;
  let tag: string | null = null;
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: "application/vnd.github+json" },
    });
    if (r.status === 404) die(`no published releases yet — ${releases}`);
    if (r.ok) tag = (await r.json())?.tag_name ?? null;
  } catch { /* reported below */ }
  if (!tag) die(`could not reach GitHub to check releases (offline?) — ${releases}`);
  // The tag feeds URL building below — accept only supa's own vX.Y.Z shape.
  if (!isReleaseTag(tag)) die(`unexpected release tag '${tag}' from GitHub — aborting`);
  const newer = semverNewer(tag, VERSION);
  console.log(`supa: current v${VERSION} — latest ${tag}${newer ? "" : "  (up to date)"}`);
  if (check || !newer) {
    if (check && newer) console.log(`  update: supa upgrade`);
    return;
  }
  const asset = releaseAsset(Deno.build.os, Deno.build.arch);
  if (!asset) die(`no prebuilt binary for ${Deno.build.os}/${Deno.build.arch} — build from source`);
  const base = `${releases}/download/${tag}`;
  console.log(`>> downloading ${asset}  (${tag})`);
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    const r = await fetch(`${base}/${asset}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    bytes = new Uint8Array(await r.arrayBuffer());
  } catch (e) {
    die(`download failed: ${e instanceof Error ? e.message : e}`);
  }
  // Same fail-closed rule as the install scripts: no checksum, no install.
  let sums = "";
  try {
    const r = await fetch(`${base}/SHA256SUMS.txt`);
    if (r.ok) sums = await r.text();
  } catch { /* handled below */ }
  const expected = shaFor(sums, asset);
  if (!expected) die("cannot verify the download (no SHA256SUMS entry) — aborting");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const actual = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (actual !== expected) die("checksum mismatch — aborting");
  console.log("  checksum verified");
  // A running exe can't be overwritten on Windows, but it CAN be renamed: shuffle
  // the live binary aside, slide the new one in, best-effort clean the leftover.
  const tmp = `${self}.new`;
  const old = `${self}.old`;
  Deno.writeFileSync(tmp, bytes);
  if (OS !== "windows") Deno.chmodSync(tmp, 0o755);
  try {
    Deno.removeSync(old);
  } catch { /* none, or still locked from a previous update */ }
  Deno.renameSync(self, old);
  try {
    Deno.renameSync(tmp, self);
  } catch (e) {
    Deno.renameSync(old, self); // roll back — the current binary keeps working
    die(`could not install the new binary: ${e instanceof Error ? e.message : e}`);
  }
  try {
    Deno.removeSync(old);
  } catch { /* locked while running — removed on the next update */ }
  console.log(`✓ updated supa v${VERSION} → ${tag}  (${self})`);
}
export async function cmdLimit(rest: string[]): Promise<void> {
  if (rest.length !== 1) {
    die("usage: supa limit <project>   (apply supa.limits to the running stack now)");
  }
  const p = rest[0];
  requireProject(p);
  const wd = cfgDir(p);
  if (!wd) die(`unresolvable project '${p}'`);
  if (Object.keys(readLimits(wd)).length === 0) {
    die(`no limits for '${p}' — create ${join(wd, ".supa", "limits")} (see ${DOCS_URL}/SUPA.md)`);
  }
  const lbl = labelOf(p);
  if (!lbl || !(await runningLabels()).includes(lbl)) {
    die(`'${p}' isn't running — limits apply automatically on 'supa up ${p}'`);
  }
  const n = await applyLimits(p);
  console.log(`✓ applied resource limits to ${n} container(s) in ${p}`);
}
// Remove named images. `docker image rm` refuses any image a container still
// references (running or stopped) — that refusal is the last line of defence, so a
// failure is reported and never forced.
async function rmImages(refs: string[], what: string): Promise<void> {
  if (refs.length === 0) return;
  const r = await runCapture("docker", ["image", "rm", ...refs]);
  if (r.code === 0) {
    console.log(`  removed ${refs.length} ${what}`);
    return;
  }
  // Partial failure: docker deletes what it can and errors per refused image, so the
  // exact count isn't recoverable — report the refusals rather than guess a number.
  const errs = r.err.split(/\r?\n/).filter((l) => l.trim() !== "");
  console.log(`  ${what}: docker kept ${errs.length} of ${refs.length}`);
  for (const l of errs.slice(0, 3)) console.error(`  ! ${l.trim()}`);
}
// supa reclaims only what it manages: images from Supabase repositories, and
// volumes carrying the Supabase project label. Images and volumes belonging to
// anything else on this docker host are reported and left alone — a host-wide
// `docker image prune` is the user's call, never supa's.
export async function cmdPrune(rest: string[]): Promise<void> {
  const flags = new Set(rest.filter((a) => a.startsWith("-")));
  const dry = flags.has("--dry-run");
  const doAll = flags.has("--all");
  const doImages = flags.has("--images") || doAll;
  const volumesAsked = flags.has("--volumes") || doAll;

  const dv = await runCapture("docker", ["version", "--format", "{{.Server.Version}}"]);
  if (dv.code !== 0 || dv.out.trim() === "") die(withStderr("docker not available", dv.err));

  // Untagged images carry no repository, so each one is attributed by its repo
  // digests. A locally built layer has none and is therefore never supa's.
  const dangling = await runCapture("docker", [
    "image",
    "ls",
    "--filter",
    "dangling=true",
    "--format",
    "{{.ID}}",
  ]);
  const danglingIds = dangling.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  let untaggedOurs: string[] = [];
  let untaggedOthers = 0;
  if (danglingIds.length) {
    const ins = await runCapture("docker", [
      "image",
      "inspect",
      "--format",
      "{{.Id}}\t{{json .RepoDigests}}",
      ...danglingIds,
    ]);
    const { ours, others } = attributeUntagged(ins.out);
    untaggedOurs = ours;
    untaggedOthers = others.length;
  }

  // Tagged Supabase images no container references (--images). They re-pull.
  const rows = parseImageRows(
    (await runCapture("docker", [
      "image",
      "ls",
      "--format",
      "{{.ID}}\t{{.Repository}}\t{{.Tag}}\t{{.Size}}",
    ])).out,
  );
  const refs = (await runCapture("docker", ["ps", "-a", "--format", "{{.Image}}"]))
    .out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const unusedSupa = rows.filter((r) =>
    isSupabaseRepo(r.repo) && r.tag !== "<none>" && !imageInUse(r, refs)
  );

  // Orphan volumes: Supabase-labelled volumes whose stack is neither registered nor
  // running. supa doesn't manage those stacks, so it reports them and stops there.
  const registered = new Set(names().map((n) => labelOf(n)).filter((l): l is string => !!l));
  const running = new Set(await runningLabels());
  const { out: vout } = await runCapture("docker", [
    "volume",
    "ls",
    "--format",
    '{{.Name}}\t{{.Label "com.supabase.cli.project"}}',
  ]);
  const orphanVols: string[] = [];
  for (const line of vout.split(/\r?\n/)) {
    const [vname, vlbl] = line.split("\t");
    const l = (vlbl ?? "").trim();
    if (vname?.trim() && l && !registered.has(l) && !running.has(l)) orphanVols.push(vname.trim());
  }

  console.log("supa prune — scope: Supabase images + Supabase-labelled volumes only.");
  console.log(
    `  • untagged Supabase images  → ${
      untaggedOurs.length === 0 ? "none" : `remove ${untaggedOurs.length}`
    }`,
  );
  console.log(
    `  • unused Supabase images    → ${
      unusedSupa.length === 0
        ? "none"
        : doImages
        ? `remove ${unusedSupa.length} (re-pulled on next up)`
        : `skip ${unusedSupa.length} (--images)`
    }`,
  );
  // prune removes without a prompt, so it names its targets first.
  for (const r of doImages ? unusedSupa : []) console.log(`      ${r.repo}:${r.tag}  ${r.size}`);
  if (untaggedOthers) {
    console.log(
      `  • ${untaggedOthers} untagged image(s) from other projects → left alone ` +
        `(not supa's — 'docker image prune' is yours to run)`,
    );
  }
  console.log(
    `  • orphan Supabase volumes   → ${
      orphanVols.length === 0 ? "none" : `report only (${orphanVols.length})`
    }`,
  );
  if (orphanVols.length) {
    console.log("      not in your registry, so supa won't delete their data — you can:");
    console.log(`        docker volume rm ${orphanVols.join(" ")}`);
    console.log("      (a registered stack's data: supa destroy <project>)");
  }
  if (volumesAsked) {
    console.log("  note: --volumes/--all no longer delete volumes (out of supa's scope).");
  }
  if (dry) {
    console.log("(dry run — nothing removed)");
    return;
  }

  await rmImages(untaggedOurs, "untagged Supabase image(s)");
  if (doImages) {
    await rmImages(unusedSupa.map((r) => `${r.repo}:${r.tag}`), "unused Supabase image(s)");
  }
  console.log("✓ prune done");
}
// Every dispatchable verb (aliases excluded) — completions + help share this.
const VERBS =
  "ls up down restart switch destroy rotate backup restore pg-upgrade upgrade status stats " +
  "limit logs studio env add rm park unpark ports doctor prune config mcp completion version help";

export function cmdCompletion(rest: string[]): void {
  const usage = "usage: supa completion bash|zsh|pwsh   (see 'supa help completion' for install)";
  const shell = rest[0];
  if (rest.length !== 1) die(usage);
  if (shell === "bash") {
    console.log([
      '# supa bash completion — add to ~/.bashrc:  eval "$(supa completion bash)"',
      "_supa() {",
      '  local cur="${COMP_WORDS[COMP_CWORD]}"',
      '  if [ "$COMP_CWORD" -eq 1 ]; then',
      `    COMPREPLY=( $(compgen -W "${VERBS}" -- "$cur") )`,
      "  else",
      '    COMPREPLY=( $(compgen -W "$(supa __names 2>/dev/null)" -- "$cur") )',
      "  fi",
      "}",
      "complete -F _supa supa",
    ].join("\n"));
    return;
  }
  if (shell === "zsh") {
    console.log([
      '# supa zsh completion — add to ~/.zshrc:  eval "$(supa completion zsh)"',
      "_supa() {",
      "  if (( CURRENT == 2 )); then",
      `    compadd ${VERBS}`,
      "  else",
      "    compadd $(supa __names 2>/dev/null)",
      "  fi",
      "}",
      "compdef _supa supa",
    ].join("\n"));
    return;
  }
  if (shell === "pwsh" || shell === "powershell") {
    console.log([
      "# supa PowerShell completion — add to $PROFILE:",
      "#   supa completion pwsh | Out-String | Invoke-Expression",
      "Register-ArgumentCompleter -Native -CommandName supa -ScriptBlock {",
      "  param($wordToComplete, $commandAst, $cursorPosition)",
      "  $els = $commandAst.CommandElements.Count",
      "  $words = if ($els -ge 3 -or ($els -eq 2 -and $wordToComplete -eq '')) { supa __names }",
      `  else { '${VERBS}' -split ' ' }`,
      '  $words | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {',
      "    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)",
      "  }",
      "}",
    ].join("\n"));
    return;
  }
  die(usage);
}

// Detailed help per command — `supa help <cmd>` or `supa <cmd> --help`.
const HELP_TOPICS: Record<string, string> = {
  up: `supa up <project...> [--exclude <containers>]   (alias: start)
Start one or more stacks via 'supabase start'. Refuses past the max-active
limit (default 1) — raise it: supa config max-active <n>. Runs the project's
up.pre / up.post hooks (supa.hooks) and applies supa.limits caps if present.
--exclude (or -x) is this start only — it is not written to config.toml.
Names are the CLI's container names (studio, mailpit, gotrue, …), comma-separated.
The database cannot be excluded. The next up without the flag follows config.toml.`,
  down: `supa down <project...> | supa down --all   (alias: stop)
Stop stack(s) via 'supabase stop' (data stays in the docker volume).
Named lists refuse the whole batch if any name is unknown / has no
config.toml. --all skips broken registry rows (warns) so one bad entry
cannot block stopping the rest. Runs down.pre / down.post only when the
stack is currently UP (never-started park discoveries stay quiet).`,
  switch: `supa switch <project>   (alias: only)
If max-active has room, start <project> first, then stop every other
registered running stack. If one of those stops fails, the target started
by this command is stopped and the stacks already stopped are started again.
If it is already full, stop the others first and start them again when the
target fails to come up. Unregistered running stacks are left alone. A set
ram_budget can refuse before anything stops.`,
  destroy: `supa destroy <project> [--yes]
Stop the stack and DELETE its local data (containers + volumes). Cannot be
undone. Asks you to type the project name; --yes skips (for scripts).`,
  rotate: `supa rotate <project> [--yes]
Generate a NEW JWT signing key under supabase/, set signing_keys_path,
restart. Paths that escape the project (or are absolute) are refused.
Existing tokens become invalid. Gitignore the key file — it is private.`,
  backup: `supa backup <project> [--data-only|--schema-only|--roles-only] [--use-copy] [--out <dir>]
Dump the local DB (stack must be up) to <name>_<YYYY-MM-DD_HHMMSS>.sql.
Default: full (roles+schema+data). Output dir: --out > 'supa config
backup-dir' > <project>/backups/. Atomic — interrupted dumps leave no file.`,
  restore: `supa restore <project> (<file>[.gz] | --latest) [--yes] [--db <name>] [--no-tx]
Load a dump into the LIVE db (stack must be up) via the container's psql.
.gz files are decompressed on the fly. Takes a safety pre-dump first; runs in
a single transaction (errors roll back). --latest prefers the newest full dump
(.sql or .sql.gz); falls back to a typed +data/+schema/+roles part only when
no full dump exists; ignores pre-restore and upgrade snapshots (pass those by
path). A full dump needs a fresh schema — data-only into a migrated schema is
the clean path (automate with restore.pre / restore.post hooks).`,
  "pg-upgrade":
    `supa pg-upgrade <project> --to <major_version> [--yes] [--dry-run] [--allow-downgrade]
Postgres MAJOR upgrade: snapshot -> stop -> copy the DB volume aside ->
bump major_version -> remove the old name -> start fresh -> restore.
The copy is deleted only after restore succeeds. Destructive (typed confirm).
Downgrades are refused by default (Postgres does not support them — roll back
via the pre-upgrade snapshot instead); --allow-downgrade overrides. --dry-run
previews.`,
  upgrade: `supa upgrade [--check]
Update supa ITSELF from GitHub Releases (checksum-verified, atomic swap).
--check only reports the latest version. supa never phones home on its own —
this command is the only network call, and only when you run it.
(Postgres major upgrades: supa pg-upgrade.)`,
  env: `supa env <project> [--json] [--write [file]]
Print the stack's keys/URLs, or --write: merge them into a dotenv file
(default <config-dir>/.env.local) — updates keys in place, keeps other
lines. Without a supa.env.map, --write renames both the legacy JWT keys and
the publishable/secret keys. A project file replaces that default.`,
  add: `supa add <name> <path> [--init] [--slot 0-111]
Register a project (path is stored absolute). --init runs 'supabase init' when
needed. Stock config.toml ports stay in the file. This machine remembers a
free slot in ~/.config/supa/slots and passes it to the CLI as environment
variables. A port changed in config.toml stays as written.
For a directory of projects, see: supa help park`,
  park: `supa park [<dir>] · supa unpark <dir>
Opt-in auto-discovery: parking a dir makes every immediate subdir that
contains supabase/config.toml appear as a project (named after the subdir).
Subdirs without Supabase are ignored; explicit 'supa add' entries win.
'supa park' alone lists parked dirs. Stored as a '*|<dir>' registry line.`,
  ports: `supa ports <name> [slot 0-111]
Move an auto-assigned slot (54421 + slot*100). Does not rewrite config.toml.
Refuses when the file already has a committed port band. Apply with:
supa restart`,
  logs: `supa logs <project> [service] [--since <time>] [-f]
Show one service's container logs (last 200 lines). --since is passed to
docker logs. Stopped containers are included. -f follows only while the
container is running. Without a service, lists the stack's services.`,
  limit: `supa limit <project>
Apply the project's supa.limits (memory/cpus caps per container) to the
running stack now. Happens automatically on 'supa up'.`,
  prune: `supa prune [--images] [--dry-run]
Reclaim docker disk WITHIN supa's scope — Supabase images only. Other
projects' images (a php service, your own builds) are reported, never
touched: a host-wide 'docker image prune' is yours to run.
Default: untagged Supabase images. --images: also unused tagged ones
(re-pulled on next up). Volumes are reported only — delete a registered
stack's data with 'supa destroy', an unmanaged stack's with 'docker volume rm'.`,
  config: `supa config [--json]
Show resolved paths + settings. Set with:
  supa config max-active <n>     stacks allowed at once (default 1)
  supa config ram-budget <gb>    'supa stats' warns above this
  supa config backup-dir <path>  where backups go`,
  completion: `supa completion bash|zsh|pwsh
Print a tab-completion script (verbs + project names). Install:
  bash:  eval "$(supa completion bash)"        (~/.bashrc)
  zsh:   eval "$(supa completion zsh)"         (~/.zshrc)
  pwsh:  supa completion pwsh | Out-String | Invoke-Expression   ($PROFILE)`,
};

export async function cmdStudio(rest: string[]): Promise<void> {
  if (rest.length !== 1) die("usage: supa studio <project>");
  const p = rest[0];
  requireProject(p);
  requireCfg(p);
  const lbl = labelOf(p);
  if (!lbl || !(await runningLabels()).includes(lbl)) {
    die(`'${p}' is not running — start it first: supa up ${p}`);
  }
  const port = shownPort(p, "studio");
  if (!port) die(`no Studio port for '${p}'`);
  const url = `http://127.0.0.1:${port}`;
  console.log(url);
  const code = OS === "windows"
    ? await runInherit("cmd", ["/c", "start", "", url])
    : OS === "darwin"
    ? await runInherit("open", [url])
    : await runInherit("xdg-open", [url]);
  if (code !== 0) die(`could not open ${url}`);
}

export async function cmdMcp(): Promise<void> {
  const pending = { text: "" };
  const dec = new TextDecoder();
  const buf = new Uint8Array(1024 * 1024);
  const main = fromFileUrl(new URL("../main.ts", import.meta.url));
  const run = async (args: string[]) => {
    const self = Deno.execPath();
    const compiled = !/(^|[\\/])deno(\.exe)?$/i.test(self);
    const cmdArgs = compiled ? args : ["run", "--no-check", "-A", main, ...args];
    try {
      const { code, stdout, stderr } = await new Deno.Command(self, {
        args: cmdArgs,
        stdout: "piped",
        stderr: "piped",
      }).output();
      return {
        code,
        out: new TextDecoder().decode(stdout),
        err: new TextDecoder().decode(stderr),
      };
    } catch (e) {
      return { code: 127, out: "", err: e instanceof Error ? e.message : String(e) };
    }
  };
  while (true) {
    const n = await Deno.stdin.read(buf);
    if (n === null) break;
    pending.text += dec.decode(buf.subarray(0, n));
    let nl = pending.text.indexOf("\n");
    while (nl >= 0) {
      const line = pending.text.slice(0, nl).trim();
      pending.text = pending.text.slice(nl + 1);
      nl = pending.text.indexOf("\n");
      if (!line) continue;
      let msg: McpMessage;
      try {
        msg = JSON.parse(line) as McpMessage;
      } catch {
        console.log(JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "parse error" },
        }));
        continue;
      }
      const reply = await handleMcpMessage(msg, run);
      if (reply) console.log(JSON.stringify(reply));
    }
  }
}

export function cmdHelp(rest: string[] = []): void {
  const topic = rest[0];
  if (topic) {
    const t = HELP_TOPICS[topic];
    if (t) {
      console.log(t);
      return;
    }
    console.log(`no detailed help for '${topic}' — general usage:\n`);
  }
  const defHome = OS === "windows" ? "%APPDATA%\\supa" : "~/.config/supa";
  const oneOff = OS === "windows"
    ? "'$env:SUPA_MAX_ACTIVE=2; supa up <p>; rm env:SUPA_MAX_ACTIVE'"
    : "'SUPA_MAX_ACTIVE=2 supa up <p>'";
  console.log(
    `supa — run local Supabase stacks (CLI-backed, cross-platform, no compose)

  supa ls [--json]              list projects, docker label, live ports, status
  supa up <p...> [--exclude <containers>]   start stack(s) — refuses past the max-active limit *
  supa down <p...> | --all      stop one/more stacks (or every registered one)
  supa restart <p...>           stop + start a stack
  supa switch <p>               stop all others, run only <p>
  supa destroy <p> [--yes]      stop + DELETE a stack's data (containers + volumes)
  supa rotate <p> [--yes]       new JWT signing key + restart (invalidates tokens)
  supa backup <p> [--data-only] [--out <dir>]  dump the DB → <name>_<ts>.sql
  supa restore <p> <file>[.gz]|--latest [--yes]  load a dump into the live DB (atomic)
  supa pg-upgrade <p> --to <ver> [--dry-run]   Postgres major upgrade (snapshot+restore)
  supa upgrade [--check]        update supa itself (from GitHub Releases)
  supa status [--json]          raw docker view, grouped by project
  supa stats [--json]           CPU/MEM per container + per-stack & total RAM
  supa limit <p>                apply supa.limits (memory/cpus caps) to a running stack
  supa logs <p> [svc] [--since t] [-f]   container logs, including stopped stacks
  supa studio <p>               open that project's Studio in the browser
  supa env <p> [--json] [--write [f]]   print keys/URLs, or merge them into a .env file
  supa add <name> <path> [--init] [--slot N]   register (--init: init + assign a slot)
  supa rm <name>                unregister a project
  supa park [<dir>] · unpark <dir>   auto-discover supabase projects in a dir (opt-in)
  supa ports <name> [slot]      move an auto slot (does not rewrite config.toml)
  supa mcp                      local stdio MCP server for an editor to launch
  supa doctor                   preflight: docker, CLI, registry, ports, config
  supa prune [--images] [--dry-run]   reclaim docker disk (Supabase images only)
  supa config [--json] [max-active <n> | ram-budget <gb> | backup-dir <path>]   show/set
  supa completion bash|zsh|pwsh    print a tab-completion script
  supa version                  print the supa version
  supa help [command]           this, or details for one command

* max-active defaults to 1. Raise it: 'supa config max-active 2', or one-off
  ${oneOff}. SUPA_ALLOW_MULTI=1 means unlimited.

Config lives in SUPA_HOME (default ${defHome}): supa.registry (name|path) +
supa.config. Override with SUPA_HOME / SUPA_REGISTRY / SUPA_CONFIG.
Full guide: ${DOCS_URL}/SUPA.md
Ports:      ${DOCS_URL}/PORTS.md`,
  );
}
