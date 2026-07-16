// The command handlers. Each maps `supa <verb> …` to Supabase-CLI + docker calls,
// deriving everything from the registry and each project's config.toml.
import {
  die,
  escapeRegExp,
  expandTilde,
  fmtMiB,
  isDir,
  isFile,
  join,
  maskSecret,
  memToMiB,
  OS,
} from "./util.ts";
import {
  applyEnvMap,
  backupFileName,
  type BackupType,
  ensureSigningKeysPath,
  latestBackup,
  mergeDotenv,
  parseMajorVersion,
  resolveBackupDir,
  setMajorVersion,
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
} from "./config.ts";
import {
  applyLimits,
  dbContainer,
  guard,
  nameForLabel,
  runCapture,
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
async function readLine(prompt: string): Promise<string> {
  await Deno.stdout.write(new TextEncoder().encode(prompt));
  const buf = new Uint8Array(256);
  const n = await Deno.stdin.read(buf);
  return n === null ? "" : new TextDecoder().decode(buf.subarray(0, n)).trim();
}

export async function cmdUp(rest: string[]): Promise<void> {
  if (rest.length < 1) die("usage: supa up <project...>");
  for (const p of rest) {
    if (rootOf(p) === null) die(`unknown project '${p}' (known: ${names().join(" ")})`);
  }
  for (const p of rest) {
    await guard(p);
    await startStack(p);
  }
}
export async function cmdDown(rest: string[]): Promise<void> {
  if (rest.length < 1) die("usage: supa down <project...> | supa down --all");
  const list = rest[0] === "--all" ? names() : rest;
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
  const { code, out } = await runCapture(supabaseCmd(), ["--workdir", wd, "status", "-o", "env"]);
  if (code === 127) die(SUPABASE_MISSING);
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
export async function cmdLs(): Promise<void> {
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
export async function cmdStatus(): Promise<void> {
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
export function cmdConfig(rest: string[]): void {
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
      if (code === 127) die(SUPABASE_MISSING);
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
  if (wd) {
    console.log(
      `  config: ${join(wd, "supabase", "config.toml")} (label: ${labelOf(name) ?? "?"})`,
    );
  } else console.error(`  note: no supabase/config.toml found under it yet`);
  if (!init) {
    const s = nextFreeSlot();
    if (s) console.log(`  next free port band: 543${s}X  (apply: supa ports ${name} ${s})`);
  }
}
export function cmdRm(rest: string[]): void {
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
export function cmdPorts(rest: string[]): void {
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
export async function cmdStats(): Promise<void> {
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
    Deno.writeTextFileSync(partial, chunks.join("\n"));
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
// Run a project-declared hook. Hooks are the ONE place supa uses a shell — the
// command is user-authored config (like a Makefile target), run in the project
// dir, so this is a deliberate, trusted exception to the no-shell rule.
async function runHook(kind: string, cmd: string, cwd: string): Promise<void> {
  console.log(`  hook (${kind}): ${cmd}`);
  const [sh, flag] = OS === "windows" ? ["cmd", "/c"] : ["sh", "-c"];
  let code: number;
  try {
    code = (await new Deno.Command(sh, {
      args: [flag, cmd],
      cwd,
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    }).output()).code;
  } catch {
    code = 127;
  }
  if (code !== 0) die(`${kind} hook failed (exit ${code}): ${cmd}`);
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
  const usage = "usage: supa restore <project> (<file> | --latest) [--yes] [--db <name>] [--no-tx]";
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
        `  stack, or use a --data-only dump. See docs/SUPA.md.`,
    );
  }
  if (hooks.restorePost) await runHook("restore.post", hooks.restorePost, wd);
  console.log(`✓ restored ${p} from ${file}`);
}
export async function cmdUpgrade(rest: string[]): Promise<void> {
  const usage = "usage: supa upgrade <project> --to <major_version> [--yes] [--dry-run]";
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

  const cfgText = Deno.readTextFileSync(f);
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
        `  docs/SUPA.md. If you truly mean to downgrade, re-run with --allow-downgrade.`,
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

  console.log(`supa upgrade '${p}': Postgres ${current} → ${to}`);
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
export async function cmdLimit(rest: string[]): Promise<void> {
  if (rest.length !== 1) {
    die("usage: supa limit <project>   (apply supa.limits to the running stack now)");
  }
  const p = rest[0];
  requireProject(p);
  const wd = cfgDir(p);
  if (!wd) die(`unresolvable project '${p}'`);
  if (Object.keys(readLimits(wd)).length === 0) {
    die(`no supa.limits for '${p}' — create ${join(wd, "supa.limits")} (see docs/SUPA.md)`);
  }
  const lbl = labelOf(p);
  if (!lbl || !(await runningLabels()).includes(lbl)) {
    die(`'${p}' isn't running — limits apply automatically on 'supa up ${p}'`);
  }
  const n = await applyLimits(p);
  console.log(`✓ applied resource limits to ${n} container(s) in ${p}`);
}
export async function cmdPrune(rest: string[]): Promise<void> {
  const flags = new Set(rest.filter((a) => a.startsWith("-")));
  const dry = flags.has("--dry-run");
  const yes = flags.has("--yes") || flags.has("-y");
  const doAll = flags.has("--all");
  const doImages = flags.has("--images") || doAll;
  const doVolumes = flags.has("--volumes") || doAll;

  // Orphan volumes: supabase volumes whose project label is neither registered nor
  // running — old stacks left behind. They hold DATA, so removal needs a confirm.
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

  console.log("supa prune — plan:");
  console.log("  • dangling images  → prune (safe)");
  console.log(
    `  • unused images    → ${doImages ? "prune ALL (re-pulls on next up)" : "skip (--images)"}`,
  );
  console.log(
    `  • orphan volumes   → ${
      orphanVols.length === 0
        ? "none"
        : (doVolumes ? "DELETE (data!): " : "keep (--volumes): ") + orphanVols.join(", ")
    }`,
  );
  if (dry) {
    console.log("(dry run — nothing removed)");
    return;
  }

  const reclaimed = (out: string) =>
    out.split(/\r?\n/).find((l) => /Total reclaimed/.test(l))?.trim();
  const d = await runCapture("docker", ["image", "prune", "-f"]);
  console.log(`  ${reclaimed(d.out) ?? "pruned dangling images"}`);
  if (doImages) {
    const a = await runCapture("docker", ["image", "prune", "-af"]);
    console.log(`  ${reclaimed(a.out) ?? "pruned unused images"}`);
  }
  if (doVolumes && orphanVols.length) {
    if (!yes) {
      console.error(`⚠ about to DELETE ${orphanVols.length} volume(s) holding real data:`);
      for (const v of orphanVols) console.error(`    ${v}`);
      const ans = await readLine(`  type 'delete' to confirm: `);
      if (ans !== "delete") die("aborted (confirmation did not match)");
    }
    const r = await runCapture("docker", ["volume", "rm", ...orphanVols]);
    console.log(
      r.code === 0
        ? `  removed ${orphanVols.length} orphan volume(s)`
        : `  ! volume rm failed (exit ${r.code})`,
    );
  }
  console.log("✓ prune done");
}
export function cmdHelp(): void {
  const defHome = OS === "windows" ? "%APPDATA%\\supa" : "~/.config/supa";
  const oneOff = OS === "windows"
    ? "'$env:SUPA_MAX_ACTIVE=2; supa up <p>'"
    : "'SUPA_MAX_ACTIVE=2 supa up <p>'";
  console.log(
    `supa — run local Supabase stacks (CLI-backed, cross-platform, no compose)

  supa ls                       list projects, docker label, live ports, status
  supa up <p...>                start stack(s) — refuses past the max-active limit *
  supa down <p...> | --all      stop one/more stacks (or every registered one)
  supa restart <p...>           stop + start a stack
  supa switch <p>               stop all others, run only <p>
  supa destroy <p> [--yes]      stop + DELETE a stack's data (containers + volumes)
  supa rotate <p> [--yes]       new JWT signing key + restart (invalidates tokens)
  supa backup <p> [--data-only] [--out <dir>]  dump the DB → <name>_<ts>.sql
  supa restore <p> <file>|--latest [--yes]     load a dump into the live DB (atomic)
  supa upgrade <p> --to <ver> [--dry-run]      Postgres major upgrade (snapshot+restore)
  supa status                   raw docker view, grouped by project
  supa stats                    CPU/MEM per container + per-stack & total RAM
  supa limit <p>                apply supa.limits (memory/cpus caps) to a running stack
  supa logs <p> [svc] [-f]      tail a stack's container logs
  supa env <p> [--write [f]]    print keys/URLs, or merge them into a .env file
  supa add <name> <path> [--init] [--slot N]   register (--init: init + assign ports)
  supa rm <name>                unregister a project
  supa ports <name> [slot]      re-band that project's 543XX ports to a free slot
  supa doctor                   preflight: docker, CLI, registry, ports, config
  supa prune [--images|--volumes|--all] [--dry-run]  reclaim docker disk (safe by default)
  supa config [max-active <n> | ram-budget <gb> | backup-dir <path>]   show/set
  supa version                  print the supa version
  supa help                     this

* max-active defaults to 1. Raise it: 'supa config max-active 2', or one-off
  ${oneOff}. SUPA_ALLOW_MULTI=1 means unlimited.

Config lives in SUPA_HOME (default ${defHome}): supa.registry (name|path) +
supa.config. Override with SUPA_HOME / SUPA_REGISTRY / SUPA_CONFIG.
Full guide: docs/SUPA.md   Ports: docs/PORTS.md`,
  );
}
