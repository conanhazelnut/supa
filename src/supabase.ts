// Talking to the outside world: resolve the Supabase CLI, run docker/supabase
// (never through a shell), and the start/stop/guard lifecycle.
import { die, escapeRegExp, home, isFile, join, OS } from "./util.ts";
import { cfgDir, labelOf, names, readLimits, readMaxActive, rootOf } from "./config.ts";

export const SUPABASE_MISSING =
  "Supabase CLI not found on PATH — install it: https://supabase.com/docs/guides/local-development";

export function which(cmd: string): string | null {
  const pathEnv = Deno.env.get("PATH") ?? "";
  const sep = OS === "windows" ? ";" : ":";
  // On Windows resolve like cmd.exe does: try each PATHEXT extension in order
  // (.exe, .cmd, .bat, …), then the bare name. PATH entries may be quoted.
  const exts = OS === "windows"
    ? (Deno.env.get("PATHEXT") ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [];
  const cands = OS === "windows" ? [...exts.map((e) => cmd + e.toLowerCase()), cmd] : [cmd];
  for (const raw of pathEnv.split(sep)) {
    const dir = raw.replace(/"/g, "");
    if (!dir) continue;
    for (const c of cands) {
      const full = join(dir, c);
      if (isFile(full)) return full;
    }
  }
  return null;
}
export function supabaseCmd(): string {
  const onPath = which("supabase");
  if (onPath) return onPath;
  const fb = join(home(), ".local", "bin", "supabase");
  return isFile(fb) ? fb : "supabase";
}

// Run a command, capturing stdout (stderr discarded). 127 == spawn failure.
export async function runCapture(
  cmd: string,
  args: string[],
): Promise<{ code: number; out: string }> {
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
// Run a command with inherited stdio (interactive). 127 == spawn failure.
export async function runInherit(cmd: string, args: string[]): Promise<number> {
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
// Run a command, streaming a file into its stdin (inherit stdout/stderr).
// Used to feed a .sql dump into the db container's psql. 127 == spawn failure.
export async function runStdinFile(cmd: string, args: string[], file: string): Promise<number> {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(cmd, {
      args,
      stdin: "piped",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
  } catch {
    return 127;
  }
  try {
    const f = await Deno.open(file, { read: true });
    await f.readable.pipeTo(child.stdin); // closes stdin (EOF) when the file ends
  } catch {
    // psql may close stdin early on error; ignore the broken pipe and let the
    // exit code below report the failure.
  }
  const { code } = await child.status;
  return code;
}
// Find the Postgres container for a stack (service container `supabase_db_<label>`).
export async function dbContainer(label: string): Promise<string | null> {
  const { code, out } = await runCapture("docker", [
    "ps",
    "--filter",
    `label=com.supabase.cli.project=${label}`,
    "--format",
    "{{.Names}}",
  ]);
  if (code !== 0) return null;
  const found = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return found.find((n) => n === `supabase_db_${label}`) ??
    found.find((n) => n.includes("_db_")) ?? null;
}

export async function runningLabels(): Promise<string[]> {
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
export function nameForLabel(label: string): string | null {
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
// Apply a project's supa.limits (if any) to its running containers via
// `docker update`. memory sets a HARD cap (--memory-swap = --memory, no swap) so a
// runaway container can't balloon past it into host swap. Returns count applied.
export async function applyLimits(name: string): Promise<number> {
  const wd = cfgDir(name);
  if (!wd) return 0;
  const limits = readLimits(wd);
  if (Object.keys(limits).length === 0) return 0;
  const label = labelOf(name);
  if (!label) return 0;
  const { code, out } = await runCapture("docker", [
    "ps",
    "--filter",
    `label=com.supabase.cli.project=${label}`,
    "--format",
    "{{.Names}}",
  ]);
  if (code !== 0) return 0;
  const containers = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const def = limits.default ?? {};
  const svcRe = new RegExp(`_${escapeRegExp(label)}$`);
  let applied = 0;
  for (const c of containers) {
    const svc = c.replace(/^supabase_/, "").replace(svcRe, "");
    const cap = { ...def, ...(limits[svc] ?? {}) };
    const args: string[] = [];
    if (cap.memory) args.push("--memory", cap.memory, "--memory-swap", cap.memory);
    if (cap.cpus) args.push("--cpus", cap.cpus);
    if (args.length === 0) continue;
    const r = await runCapture("docker", ["update", ...args, c]);
    if (r.code === 0) applied++;
    else console.error(`  ! could not limit ${svc} (docker update exit ${r.code})`);
  }
  return applied;
}

export async function startStack(name: string): Promise<void> {
  const wd = cfgDir(name);
  if (!wd) die(`no supabase/config.toml under '${rootOf(name)}' for '${name}'`);
  console.log(`>> starting ${name}  (${wd})`);
  const code = await runInherit(supabaseCmd(), ["--workdir", wd, "start"]);
  if (code === 127) die(SUPABASE_MISSING);
  if (code !== 0) die(`supabase start failed for '${name}' (exit ${code})`);
  const lbl = labelOf(name);
  if (lbl) await pinNoRestart(lbl);
  const n = await applyLimits(name);
  if (n) console.log(`  applied resource limits to ${n} container(s)  (supa.limits)`);
}
export async function stopStack(name: string): Promise<void> {
  const wd = cfgDir(name);
  if (!wd) die(`unresolvable project '${name}'`);
  console.log(`== stopping ${name}`);
  const code = await runInherit(supabaseCmd(), ["--workdir", wd, "stop"]);
  if (code === 127) die(SUPABASE_MISSING);
  if (code !== 0) die(`supabase stop failed for '${name}' (exit ${code})`);
}

// Refuse to start `name` when that would exceed the max-active limit.
export async function guard(name: string): Promise<void> {
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
  // The one-off hint must be copy-pasteable in the user's actual shell.
  const n = others.length + 1;
  const oneOff = OS === "windows"
    ? `$env:SUPA_MAX_ACTIVE=${n}; supa up ${name}`
    : `SUPA_MAX_ACTIVE=${n} supa up ${name}`;
  console.error(`  free a slot:       supa down <name>`);
  console.error(`  swap to '${name}':   supa switch ${name}   (stops others, runs only this)`);
  console.error(`  raise the limit:   supa config max-active ${n}`);
  console.error(`  or one-off:        ${oneOff}`);
  Deno.exit(1);
}
