// The command handlers. Each maps `supa <verb> …` to Supabase-CLI + docker calls,
// deriving everything from the registry and each project's config.toml.
import {
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
  readTextFile,
  REPO,
  VERSION,
} from "./util.ts";
import {
  applyEnvMap,
  attributeUntagged,
  backupFileName,
  type BackupType,
  droppedRegistryNames,
  ensureSigningKeysPath,
  imageInUse,
  isReleaseTag,
  isSupabaseRepo,
  latestBackup,
  mergeDotenv,
  parseImageRows,
  parseMajorVersion,
  releaseAsset,
  resolveBackupDir,
  SAFE_NAME,
  semverNewer,
  setMajorVersion,
  shaFor,
  signingKeyArray,
  tsStamp,
} from "./parse.ts";
import {
  cfgDir,
  cfgFile,
  configDir,
  configPath,
  labelOf,
  names,
  nextFreeSlot,
  parkedDirs,
  portOf,
  readBackupDir,
  readEnvMap,
  readHooks,
  readLimits,
  readMaxActive,
  readRamBudget,
  readRegistry,
  rebandConfig,
  registryPath,
  rootOf,
  setConfigKey,
  slotOf,
} from "./config.ts";
import {
  applyLimits,
  dbContainer,
  foreignSlots,
  guard,
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
} from "./supabase.ts";

function requireProject(p: string): void {
  if (rootOf(p) === null) die(`unknown project '${p}' (known: ${names().join(" ")})`);
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

export async function cmdUp(rest: string[]): Promise<void> {
  if (rest.length < 1) die("usage: supa up <project...>");
  // Validate every name + the max-active budget BEFORE starting anyone, so a
  // later failure can't leave earlier stacks up under a broken partial run.
  for (const p of rest) requireProject(p);
  await guardMany(rest);
  for (const p of rest) await startStack(p);
}
export async function cmdDown(rest: string[]): Promise<void> {
  if (rest.length < 1) die("usage: supa down <project...> | supa down --all");
  const list = rest[0] === "--all" ? names() : rest;
  // Same preflight as up: refuse the whole list if any name is unknown, so we
  // never stop A then die on B and leave the registry half-acted-on.
  if (rest[0] !== "--all") {
    for (const p of list) requireProject(p);
  }
  for (const p of list) await stopStack(p);
}
export async function cmdSwitch(rest: string[]): Promise<void> {
  if (rest.length !== 1) die("usage: supa switch <project>");
  const target = rest[0];
  if (rootOf(target) === null) die(`unknown project '${target}' (known: ${names().join(" ")})`);
  // Resolve the target BEFORE stopping anyone, so an unresolvable project doesn't
  // tear down every running stack and then fail.
  if (!cfgDir(target)) die(`no supabase/config.toml under '${rootOf(target)}' for '${target}'`);
  const tgt = labelOf(target);
  for (const l of await runningLabels()) {
    if (l === tgt) continue;
    const nm = nameForLabel(l);
    if (nm) await stopStack(nm);
    else console.error(`! running stack '${l}' not in registry — leaving it up`);
  }
  await startStack(target);
}
export async function cmdRestart(rest: string[]): Promise<void> {
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
export async function cmdEnv(rest: string[]): Promise<void> {
  const write = rest.includes("--write") || rest.includes("-w");
  const args = rest.filter((a) => a !== "--write" && a !== "-w");
  if (args.length < 1 || args.length > 2) die("usage: supa env <project> [--write [file]]");
  const p = args[0];
  const wd = cfgDir(p);
  if (!wd) die(`unresolvable project '${p}'`);
  if (!write) {
    const code = await runInherit(supabaseCmd(), ["--workdir", wd, "status", "-o", "env"]);
    if (code === 127) die(SUPABASE_MISSING);
    if (code !== 0) Deno.exit(code);
    return;
  }
  const { code, out, err } = await runCapture(supabaseCmd(), [
    "--workdir",
    wd,
    "status",
    "-o",
    "env",
  ]);
  if (code === 127) die(SUPABASE_MISSING);
  if (code !== 0 || out.trim() === "") {
    die(withStderr(`could not read env for '${p}' — is it up? try 'supa up ${p}'`, err));
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
  const existing = isFile(target) ? readTextFile(target) : "";
  const { text, keys, map } = mergeDotenv(existing, incoming);
  // Holds service keys — owner-only, tightening an existing file's perms too.
  Deno.writeTextFileSync(target, text, { mode: 0o600 });
  console.log(`supa: wrote ${keys.length} keys to ${target}`);
  for (const k of keys) console.log(`  ${k}=${maskSecret(k, map[k])}`);
  console.log(
    envMap.length
      ? `  mapped via ${join(wd, "supa.env.map")}`
      : `  note: native Supabase key names — add a supa.env.map to rename them.`,
  );
}
export async function cmdLs(rest: string[] = []): Promise<void> {
  const running = new Set(await runningLabels());
  const projects = readRegistry().sort((a, b) => (a.name < b.name ? -1 : 1));
  if (rest.includes("--json")) {
    // The stable machine interface — scripts should parse this, never the table.
    const out = projects.map((p) => {
      const lbl = labelOf(p.name);
      return {
        name: p.name,
        label: lbl,
        api: portOf(p.name, "api"),
        db: portOf(p.name, "db"),
        studio: portOf(p.name, "studio"),
        status: lbl && running.has(lbl) ? "up" : "down",
        root: p.root,
      };
    });
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
      portOf(p.name, "api") ?? "",
      portOf(p.name, "db") ?? "",
      portOf(p.name, "studio") ?? "",
      running.has(lbl) ? "UP" : "down",
      p.root,
    ]);
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
    setConfigKey("backup_dir", rest[1].trim());
    return;
  }
  die(
    `unknown config key '${rest[0]}' ` +
      `(try: supa config [max-active <n> | ram-budget <gb> | backup-dir <path>])`,
  );
}
export async function cmdLogs(rest: string[]): Promise<void> {
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
export async function cmdDestroy(rest: string[]): Promise<void> {
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
    else if (rest[i] === "--slot") slot = rest[++i];
    else pos.push(rest[i]);
  }
  if (pos.length !== 2) die("usage: supa add <name> <path> [--init] [--slot 0-9]");
  if (slot !== undefined && !/^\d$/.test(slot)) die("--slot must be a single digit 0-9");
  const [name, path] = pos;
  if (!SAFE_NAME.test(name)) die(`invalid name '${name}' (use letters/digits/._-)`);
  if (names().includes(name)) die(`'${name}' is already registered`);
  const abs = expandTilde(path);
  if (!isDir(abs)) console.error(`  warning: '${abs}' is not a directory (registering anyway)`);
  const reg = registryPath();
  const prev = isFile(reg) ? readTextFile(reg) : "";
  const sep = prev.length && !prev.endsWith("\n") ? "\n" : "";
  Deno.writeTextFileSync(reg, `${prev}${sep}${name}|${path}\n`);
  console.log(`supa: added ${name} -> ${path}`);

  if (init) {
    if (isFile(join(abs, "supabase", "config.toml"))) {
      console.error(`  note: supabase/config.toml already exists — skipping 'supabase init'`);
    } else {
      console.log(`>> supabase init (${abs})`);
      const code = await runInherit(supabaseCmd(), ["--workdir", abs, "init"]);
      if (code === 127) die(SUPABASE_MISSING);
      if (code !== 0) die(`'supabase init' failed for '${name}' (exit ${code})`);
    }
    const chosen = slot ?? nextFreeSlot(new Set((await foreignSlots()).keys())) ?? "";
    const f = cfgFile(name);
    if (/^\d$/.test(chosen) && f && isFile(f)) {
      const changes = rebandConfig(f, chosen);
      console.log(
        `  assigned slot ${chosen} — ${changes.length} port(s) re-banded (543${chosen}X)`,
      );
    }
  }
  const wd = cfgDir(name);
  if (wd) {
    console.log(
      `  config: ${join(wd, "supabase", "config.toml")} (label: ${labelOf(name) ?? "?"})`,
    );
  } else console.error(`  note: no supabase/config.toml found under it yet`);
  if (!init) {
    const s = nextFreeSlot(new Set((await foreignSlots()).keys()));
    if (s) console.log(`  next free port band: 543${s}X  (apply: supa ports ${name} ${s})`);
  }
}
export function cmdRm(rest: string[]): void {
  if (rest.length !== 1) die("usage: supa rm <name>");
  const name = rest[0];
  if (!names().includes(name)) die(`'${name}' is not in the registry`);
  const reg = registryPath();
  const kept = readTextFile(reg).split(/\r?\n/).filter((line) => {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) return true;
    const i = t.indexOf("|");
    return i < 1 ? true : t.slice(0, i).trim() !== name;
  });
  Deno.writeTextFileSync(reg, kept.join("\n").replace(/\n+$/, "\n"));
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
  const abs = expandTilde(rest[0]);
  if (!isDir(abs)) die(`'${abs}' is not a directory`);
  if (parkedDirs().includes(abs)) die(`'${abs}' is already parked`);
  const reg = registryPath();
  const prev = isFile(reg) ? readTextFile(reg) : "";
  const sep = prev.length && !prev.endsWith("\n") ? "\n" : "";
  Deno.writeTextFileSync(reg, `${prev}${sep}*|${abs}\n`);
  console.log(`supa: parked ${abs}`);
  const found: string[] = [];
  for (const s of Deno.readDirSync(abs)) {
    // Same filter as discovery in readRegistry — never announce a name it won't register.
    if (!s.isDirectory || !SAFE_NAME.test(s.name)) continue;
    if (isFile(join(abs, s.name, "supabase", "config.toml"))) found.push(s.name);
  }
  console.log(
    found.length
      ? `  discovered: ${found.sort().join(", ")}`
      : `  (no supabase projects in it yet — subdirs appear in 'supa ls' as you create them)`,
  );
}
export function cmdUnpark(rest: string[]): void {
  if (rest.length !== 1) die("usage: supa unpark <dir>");
  const abs = expandTilde(rest[0]);
  if (!parkedDirs().includes(abs)) die(`'${abs}' is not parked ('supa park' lists parked dirs)`);
  const reg = registryPath();
  const kept = readTextFile(reg).split(/\r?\n/).filter((line) => {
    const t = line.trim();
    if (!t.startsWith("*|")) return true;
    return expandTilde(t.slice(2).trim()) !== abs;
  });
  Deno.writeTextFileSync(reg, kept.join("\n").replace(/\n+$/, "\n"));
  console.log(`supa: unparked ${abs}  (its projects leave the registry; nothing is stopped)`);
}
// Hidden helper for shell completions: project names, one per line.
export function cmdNames(): void {
  for (const n of names()) console.log(n);
}
export async function cmdPorts(rest: string[]): Promise<void> {
  const force = rest.includes("--force") || rest.includes("-f");
  const pos = rest.filter((a) => a !== "--force" && a !== "-f");
  if (pos.length < 1 || pos.length > 2) die("usage: supa ports <name> [slot 0-9] [--force]");
  const name = pos[0];
  requireProject(name);
  const f = cfgFile(name);
  if (!f || !isFile(f)) die(`no supabase/config.toml for '${name}'`);
  const foreign = await foreignSlots();
  let slot = pos[1];
  if (slot === undefined) {
    const s = nextFreeSlot(new Set(foreign.keys()));
    if (s === null) die("no free port slot (0-9 all taken by projects or other containers)");
    slot = s;
  }
  if (!/^\d$/.test(slot)) die("slot must be a single digit 0-9");
  // Refuse a slot already claimed by another registered project (their ports would
  // collide) unless --force. Auto-picked slots are free by construction.
  const clash = names().filter((n) => n !== name && slotOf(n) === slot);
  if (clash.length && !force) {
    die(
      `slot ${slot} (543${slot}X) is already used by ${clash.join(", ")}.\n` +
        `  omit the slot to auto-pick a free one, or pass --force to override anyway.`,
    );
  }
  // Same for a band a container outside supa already publishes on — the stack
  // simply won't bind while that container holds the port.
  const held = foreign.get(slot);
  if (held && !force) {
    die(
      `slot ${slot} (543${slot}X) is published by non-Supabase container(s): ${
        held.join(", ")
      }.\n` +
        `  omit the slot to auto-pick a free band, or pass --force to take it anyway\n` +
        `  (the stack won't start while they hold the port).`,
    );
  }
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
// Oldest CLI verified to support everything supa drives (signing_keys_path, status -o env).
const MIN_SUPABASE_CLI = "2.30.0";

export async function cmdDoctor(): Promise<void> {
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
  if (sv.code === 0) {
    const v = sv.out.match(/\d+\.\d+\.\d+/)?.[0];
    if (v && semverNewer(MIN_SUPABASE_CLI, v)) {
      console.log(
        `     ⚠ rotate/env need supabase CLI >= ${MIN_SUPABASE_CLI} (JWT signing keys)`,
      );
    }
  }
  const reg = registryPath();
  console.log(`  ${ok(isFile(reg))} registry             ${reg}`);
  if (!isFile(reg)) return;
  const projs = readRegistry();
  console.log(`  ${ok(projs.length > 0)} projects registered  ${projs.length}`);
  // JSON.stringify neutralizes control chars — these names failed the charset
  // rule, so they may contain anything, including terminal escapes.
  const dropped = droppedRegistryNames(readTextFile(reg));
  console.log(
    `  ${ok(dropped.length === 0)} registry names valid` +
      (dropped.length ? `  (${dropped.length} line(s) ignored)` : ""),
  );
  for (const n of dropped) {
    console.log(`     ✗ ignored (name must match [A-Za-z0-9._-]): ${JSON.stringify(n)}`);
  }
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
  // 543XX bands held by containers outside supa: supa can't (and won't) move them,
  // but a stack pointed at one of those bands will fail to bind.
  const foreign = await foreignSlots();
  console.log(`  ${ok(foreign.size === 0)} no 543XX ports held by other containers`);
  for (const [slot, who] of [...foreign].sort()) {
    const hit = projs.filter((p) => slotOf(p.name) === slot).map((p) => p.name);
    console.log(
      `     ! 543${slot}X held by ${who.join(", ")}` +
        (hit.length ? ` — collides with ${hit.join(", ")} (re-band: supa ports ${hit[0]})` : ""),
    );
  }
  const { value, source } = readMaxActive();
  console.log(`  · max_active = ${value === Infinity ? "unlimited" : value} (${source})`);
}
export async function cmdStats(): Promise<void> {
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
  const keyFile = join(wd, "supabase", relPath.replace(/^\.\//, ""));
  let keyArrayText: string;
  try {
    keyArrayText = signingKeyArray(gen.out);
  } catch (e) {
    die(`bad signing key from the Supabase CLI: ${e instanceof Error ? e.message : e}`);
  }
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
    await stopStack(p);
    await startStack(p);
  } else {
    console.log(`  '${p}' isn't running — start it to apply: supa up ${p}`);
  }
  console.log(`✓ rotated ${p}`);
}
// Dump `type` (roles/schema/data, or full) for project p into finalPath, atomically:
// each part → a temp file, concatenated in restore order, then renamed into place
// so a failed dump never leaves a usable-looking file. Throws on failure; callers
// die. Assumes the target directory already exists and the stack is up.
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
  try {
    const chunks: string[] = [];
    for (const part of parts) {
      const tmp = Deno.makeTempFileSync({ prefix: `supa-backup-${p}-`, suffix: ".sql" });
      temps.push(tmp);
      const code = await runInherit(
        supabaseCmd(),
        ["--workdir", wd, "db", "dump", "--local", ...part.args, "-f", tmp],
      );
      if (code === 127) throw new Error(SUPABASE_MISSING);
      if (code !== 0) {
        throw new Error(`'supabase db dump' (${part.label}) failed for '${p}' (exit ${code})`);
      }
      const body = Deno.readTextFileSync(tmp);
      chunks.push(parts.length > 1 ? `-- >>> supa backup: ${part.label} <<<\n${body}` : body);
    }
    // Dumps hold real data — owner-only; rename carries the mode to finalPath.
    Deno.writeTextFileSync(partial, chunks.join("\n"), { mode: 0o600 });
    Deno.renameSync(partial, finalPath);
  } catch (e) {
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
  const flags = new Set<string>();
  const pos: string[] = [];
  let out: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--out") out = rest[++i];
    else if (a.startsWith("-")) flags.add(a);
    else pos.push(a);
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
  const flags = new Set<string>();
  const pos: string[] = [];
  let dbName = "postgres";
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--db") dbName = rest[++i];
    else if (a.startsWith("-")) flags.add(a);
    else pos.push(a);
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
  if (hooks.restorePost) await runHook("restore.post", hooks.restorePost, wd);
  console.log(`✓ restored ${p} from ${file}`);
}
export async function cmdUpgrade(rest: string[]): Promise<void> {
  const usage = "usage: supa pg-upgrade <project> --to <major_version> [--yes] [--dry-run]";
  const flags = new Set<string>();
  const pos: string[] = [];
  let to: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--to") to = rest[++i];
    else if (a.startsWith("-")) flags.add(a);
    else pos.push(a);
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
  const payload = join(dir, `${p}_upgrade-${current}-to-${to}_${tsStamp(new Date())}.sql`);

  console.log(`supa pg-upgrade '${p}': Postgres ${current} → ${to}`);
  console.log(`  1. data-only snapshot   → ${payload}`);
  console.log(`  2. stop the stack`);
  console.log(`  3. major_version ${current} → ${to} in config.toml (+ .bak)`);
  console.log(`  4. drop DB volume       ${volume}`);
  console.log(`  5. start the stack      (fresh ${to} volume; migrations run)`);
  console.log(`  6. restore the snapshot (+ restore.pre/post hooks)`);
  if (flags.has("--dry-run")) {
    console.log("(dry run — nothing changed)");
    return;
  }

  console.error(`⚠ this DROPS the '${p}' DB volume and rebuilds it on Postgres ${to}.`);
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
  await stopStack(p);

  // 3. bump major_version (backup config first)
  console.log(`>> [3/6] major_version ${current} → ${to}`);
  const { text: bumped, changed } = setMajorVersion(cfgText, to);
  if (!changed) die(`could not update major_version in ${f}\n${recovery}`);
  Deno.writeTextFileSync(`${f}.bak`, cfgText);
  Deno.writeTextFileSync(f, bumped);

  // 4. drop the DB volume so the stack recreates it on the new PG version
  console.log(`>> [4/6] dropping volume ${volume}`);
  const rm = await runCapture("docker", ["volume", "rm", volume]);
  if (rm.code !== 0) {
    die(
      `failed to drop volume ${volume} (is the stack fully stopped?).\n` +
        `  recover config: mv ${f}.bak ${f}\n${recovery}`,
    );
  }

  // 5. start fresh (new PG version; supabase applies migrations)
  console.log(`>> [5/6] starting ${p} on Postgres ${to}`);
  await startStack(p); // dies on failure

  // 6. restore the data snapshot (project's schema prep via restore.pre)
  console.log(`>> [6/6] restoring data`);
  const container = await dbContainer(lbl);
  if (!container) {
    die(`stack up but no db container found — reload manually: supa restore ${p} ${payload}`);
  }
  const hooks = readHooks(wd);
  if (hooks.restorePre) await runHook("restore.pre", hooks.restorePre, wd);
  const code = await runStdinFile("docker", psqlArgs(container, "postgres", true), payload);
  if (code !== 0) {
    die(
      `data restore failed (psql exit ${code}). The stack is up on Postgres ${to} but empty.\n` +
        `  reload manually: supa restore ${p} ${payload}\n` +
        `  (usually a restore.pre hook to build the schema first is what's missing.)`,
    );
  }
  if (hooks.restorePost) await runHook("restore.post", hooks.restorePost, wd);
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
    die(`no supa.limits for '${p}' — create ${join(wd, "supa.limits")} (see ${DOCS_URL}/SUPA.md)`);
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
  "limit logs env add rm park unpark ports doctor prune config completion version help";

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
  up: `supa up <project...>   (alias: start)
Start one or more stacks via 'supabase start'. Refuses past the max-active
limit (default 1) — raise it: supa config max-active <n>. Runs the project's
up.pre / up.post hooks (supa.hooks) and applies supa.limits caps if present.`,
  down: `supa down <project...> | supa down --all   (alias: stop)
Stop stack(s) via 'supabase stop' (data stays in the docker volume).
Runs down.pre / down.post hooks if present.`,
  switch: `supa switch <project>   (alias: only)
Stop every other registered running stack, then start only <project>.
Running stacks that aren't in the registry are left alone.`,
  destroy: `supa destroy <project> [--yes]
Stop the stack and DELETE its local data (containers + volumes). Cannot be
undone. Asks you to type the project name; --yes skips (for scripts).`,
  rotate: `supa rotate <project> [--yes]
Generate a NEW JWT signing key, write signing_keys.json, set
signing_keys_path in config.toml, restart. Existing tokens become invalid.
Gitignore signing_keys.json — it holds the private key.`,
  backup: `supa backup <project> [--data-only|--schema-only|--roles-only] [--use-copy] [--out <dir>]
Dump the local DB (stack must be up) to <name>_<YYYY-MM-DD_HHMM>.sql.
Default: full (roles+schema+data). Output dir: --out > 'supa config
backup-dir' > <project>/backups/. Atomic — interrupted dumps leave no file.`,
  restore: `supa restore <project> (<file>[.gz] | --latest) [--yes] [--db <name>] [--no-tx]
Load a dump into the LIVE db (stack must be up) via the container's psql.
.gz files are decompressed on the fly. Takes a safety pre-dump first; runs in
a single transaction (errors roll back). --latest picks the newest backup.
A full dump needs a fresh schema — data-only into a migrated schema is the
clean path (automate with restore.pre / restore.post hooks).`,
  "pg-upgrade": `supa pg-upgrade <project> --to <major_version> [--yes] [--dry-run]
Postgres MAJOR upgrade: data snapshot -> stop -> bump major_version ->
drop the DB volume -> start fresh -> restore. Destructive (typed confirm).
No downgrades (roll back via the snapshot instead); --dry-run previews.`,
  upgrade: `supa upgrade [--check]
Update supa ITSELF from GitHub Releases (checksum-verified, atomic swap).
--check only reports the latest version. supa never phones home on its own —
this command is the only network call, and only when you run it.
(Postgres major upgrades: supa pg-upgrade.)`,
  env: `supa env <project> [--write [file]]
Print the stack's keys/URLs, or --write: merge them into a dotenv file
(default <config-dir>/.env.local) — updates keys in place, keeps other
lines. Add a supa.env.map next to config.toml to rename keys for your app.`,
  add: `supa add <name> <path> [--init] [--slot 0-9]
Register a project. --init also runs 'supabase init' and assigns a free
543XX port band. For a directory of projects, see: supa help park`,
  park: `supa park [<dir>] · supa unpark <dir>
Opt-in auto-discovery: parking a dir makes every immediate subdir that
contains supabase/config.toml appear as a project (named after the subdir).
Subdirs without Supabase are ignored; explicit 'supa add' entries win.
'supa park' alone lists parked dirs. Stored as a '*|<dir>' registry line.`,
  ports: `supa ports <name> [slot 0-9]
Re-band the project's 543XX ports to a new slot (4th digit), keeping the
service digit. Writes config.toml.bak first. Apply with: supa restart`,
  logs: `supa logs <project> [service] [-f]
Tail one service's container logs (200 lines; -f follows). Without a
service, lists the stack's services.`,
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
  supa up <p...>                start stack(s) — refuses past the max-active limit *
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
  supa stats                    CPU/MEM per container + per-stack & total RAM
  supa limit <p>                apply supa.limits (memory/cpus caps) to a running stack
  supa logs <p> [svc] [-f]      tail a stack's container logs
  supa env <p> [--write [f]]    print keys/URLs, or merge them into a .env file
  supa add <name> <path> [--init] [--slot N]   register (--init: init + assign ports)
  supa rm <name>                unregister a project
  supa park [<dir>] · unpark <dir>   auto-discover supabase projects in a dir (opt-in)
  supa ports <name> [slot] [--force]   re-band 543XX ports (auto-picks a free slot)
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
