// Talking to the outside world: resolve the Supabase CLI, run docker/supabase
// (never through a shell), and the start/stop/max-active lifecycle.
import { CommandFailed, die, escapeRegExp, home, isFile, join, OS, readTextFile } from "./util.ts";
import {
  cfgDir,
  cfgFile,
  labelOf,
  names,
  portOverlay,
  readHooks,
  readLimits,
  readMaxActive,
  readProjectSlot,
  rootOf,
} from "./config.ts";
import {
  apiPortMismatch,
  effectivePorts,
  fixedKeys,
  parsePublishedPorts,
  readHostPorts,
} from "./ports.ts";
import { exceedsMaxActive, foreignSlotHolders, uniqueNames } from "./parse.ts";

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

// Run a command, capturing stdout + stderr (stderr is for failure messages —
// callers that die() should include it so the real cause isn't swallowed).
// 127 == spawn failure.
function childEnv(extra?: Record<string, string>): Record<string, string> | undefined {
  if (!extra || Object.keys(extra).length === 0) return undefined;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(Deno.env.toObject())) env[k] = v;
  for (const [k, v] of Object.entries(extra)) env[k] = v;
  return env;
}
export async function runCapture(
  cmd: string,
  args: string[],
  extraEnv?: Record<string, string>,
): Promise<{ code: number; out: string; err: string }> {
  try {
    const { code, stdout, stderr } = await new Deno.Command(cmd, {
      args,
      env: childEnv(extraEnv),
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      code,
      out: new TextDecoder().decode(stdout),
      err: new TextDecoder().decode(stderr),
    };
  } catch {
    return { code: 127, out: "", err: "" };
  }
}
// Run a command with inherited stdio (interactive). 127 == spawn failure.
export async function runInherit(
  cmd: string,
  args: string[],
  extraEnv?: Record<string, string>,
): Promise<number> {
  try {
    const { code } = await new Deno.Command(cmd, {
      args,
      env: childEnv(extraEnv),
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
// Used to feed a .sql dump into the db container's psql; a .gz file is
// decompressed on the fly. 127 == spawn failure. A feed failure (missing file,
// corrupt gzip, …) never reports success just because psql exited 0 on empty
// stdin — only a broken pipe from psql closing early is ignored.
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
  let feedFailed = false;
  try {
    const f = await Deno.open(file, { read: true });
    const src = file.endsWith(".gz")
      ? f.readable.pipeThrough(new DecompressionStream("gzip"))
      : f.readable;
    await src.pipeTo(child.stdin); // closes stdin (EOF) when the file ends
  } catch (e) {
    // psql may close stdin early on error — broken pipe is expected; trust exit.
    // Anything else (open/decompress/pipe failure) means we never fed a dump.
    const brokenPipe = e instanceof Deno.errors.BrokenPipe ||
      (e instanceof Error && /broken pipe/i.test(e.message));
    if (!brokenPipe) feedFailed = true;
    try {
      await child.stdin.close();
    } catch { /* already closed by pipeTo */ }
  }
  const { code } = await child.status;
  if (feedFailed) return code === 0 ? 1 : code;
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
    "--filter",
    "label=com.supabase.cli.project",
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
// 543xX bands currently published by non-Supabase containers, so supa never hands a
// project a band another service is already on. Read-only; empty when docker is down.
export async function foreignSlots(): Promise<Map<string, string[]>> {
  const { code, out } = await runCapture("docker", [
    "ps",
    "--format",
    '{{.Names}}\t{{.Ports}}\t{{.Label "com.supabase.cli.project"}}',
  ]);
  if (code !== 0) return new Map();
  return foreignSlotHolders(out);
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

// Run a project-declared hook. Hooks are the ONE place supa uses a shell — the
// command is user-authored config (like a Makefile target), run in the project
// dir, so this is a deliberate, trusted exception to the no-shell rule.
// `soft: true` warns on failure instead of dying — used for up.post / down.post
// so a failed post-hook cannot look like a failed start/stop after the stack
// mutation already succeeded (and cannot abort a batch / switch mid-list).
export async function runHook(
  kind: string,
  cmd: string,
  cwd: string,
  opts?: { failHint?: string; soft?: boolean },
): Promise<void> {
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
  if (code !== 0) {
    const hint = opts?.failHint ? `\n${opts.failHint}` : "";
    const msg = `${kind} hook failed (exit ${code}): ${cmd}${hint}`;
    if (opts?.soft) {
      console.error(`supa: warning: ${msg}`);
      return;
    }
    die(msg);
  }
}

export async function startStack(
  name: string,
  opts?: { failHint?: string; failHintAfterStart?: string; exclude?: string; json?: boolean },
): Promise<void> {
  const wd = cfgDir(name);
  if (!wd) die(`no supabase/config.toml under '${rootOf(name)}' for '${name}'`);
  const say = opts?.json ? console.error : console.log;
  const preHint = opts?.failHint ? { failHint: opts.failHint } : undefined;
  const postHint = opts?.failHintAfterStart
    ? { failHint: opts.failHintAfterStart, soft: true as const }
    : { soft: true as const };
  // Soft-fail postHint even when no custom hint — stack is already up.
  const hooks = readHooks(wd);
  if (hooks.upPre) await runHook("up.pre", hooks.upPre, wd, preHint);
  say(`>> starting ${name}  (${wd})`);
  const startArgs = ["--workdir", wd, "start"];
  // After the subcommand: `--exclude` is not a global flag.
  if (opts?.exclude) startArgs.push("--exclude", opts.exclude);
  const overlay = portOverlay(name);
  const code = await runInherit(supabaseCmd(), startArgs, overlay);
  if (code === 127) {
    const hint = opts?.failHint ? `\n${opts.failHint}` : "";
    die(SUPABASE_MISSING + hint);
  }
  if (code !== 0) {
    const hint = opts?.failHint ? `\n${opts.failHint}` : "";
    throw new CommandFailed(`supabase start failed for '${name}' (exit ${code})${hint}`);
  }
  const lbl = labelOf(name);
  const f = cfgFile(name);
  if (lbl && f && isFile(f)) {
    const found = readHostPorts(readTextFile(f));
    const slot = readProjectSlot(name);
    if (!fixedKeys(found).has("api") && typeof slot === "number") {
      const ps = await runCapture("docker", [
        "ps",
        "--filter",
        `label=com.supabase.cli.project=${lbl}`,
        "--format",
        '{{.Names}}\t{{.Ports}}\t{{.Label "com.supabase.cli.project"}}',
      ]);
      const expected = effectivePorts(found, slot).api;
      const mismatch = apiPortMismatch(parsePublishedPorts(ps.out), lbl, expected);
      if (mismatch) throw new CommandFailed(mismatch);
    }
  }
  if (lbl) await pinNoRestart(lbl);
  const n = await applyLimits(name);
  if (n) say(`  applied resource limits to ${n} container(s)  (supa.limits)`);
  if (hooks.upPost) await runHook("up.post", hooks.upPost, wd, postHint);
}
export async function stopStack(name: string): Promise<void> {
  const wd = cfgDir(name);
  if (!wd) die(`unresolvable project '${name}'`);
  const hooks = readHooks(wd);
  // Never-started / already-down stacks: still call `supabase stop` (idempotent),
  // but skip hooks so `down --all` cannot fire shell for park discoveries that
  // were never brought up.
  const lbl = labelOf(name);
  const isUp = lbl !== null && (await runningLabels()).includes(lbl);
  if (isUp && hooks.downPre) await runHook("down.pre", hooks.downPre, wd);
  console.log(`== stopping ${name}`);
  const code = await runInherit(supabaseCmd(), ["--workdir", wd, "stop"], portOverlay(name));
  if (code === 127) die(SUPABASE_MISSING);
  if (code !== 0) throw new CommandFailed(`supabase stop failed for '${name}' (exit ${code})`);
  // Soft-fail: stop already succeeded — same rationale as up.post.
  if (isUp && hooks.downPost) await runHook("down.post", hooks.downPost, wd, { soft: true });
}

function printMaxActiveHelp(
  max: number,
  source: string,
  running: string[],
  want: string,
  // Slots the refused operation would need. Defaults to "one more than what's
  // listed as already running" — fine for single `up`, wrong for a batch that
  // itself exceeds the limit with nothing currently up.
  needSlots?: number,
): void {
  const from = source === "default" ? "" : `, from ${source}`;
  console.error(`supa: max-active limit reached (${max}${from}) — already running:`);
  for (const l of running) {
    const nm = nameForLabel(l);
    console.error(
      nm ? `  - ${nm} (${l})` : `  - ${l} (not registered — supa will not stop it)`,
    );
  }
  console.error("");
  // The one-off hint must be copy-pasteable in the user's actual shell. In
  // PowerShell an env var set inline persists for the whole session (unlike the
  // POSIX `VAR=x cmd` form), so the hint removes it again after the command.
  const n = needSlots ?? running.length + 1;
  const oneOff = OS === "windows"
    ? `$env:SUPA_MAX_ACTIVE=${n}; supa up ${want}; rm env:SUPA_MAX_ACTIVE`
    : `SUPA_MAX_ACTIVE=${n} supa up ${want}`;
  console.error(`  free a slot:       supa down <name>`);
  console.error(`  swap to '${want}':   supa switch ${want}   (stops others, runs only this)`);
  console.error(`  raise the limit:   supa config max-active ${n}`);
  console.error(`  or one-off:        ${oneOff}`);
  Deno.exit(1);
}

// Refuse to start the listed projects when that would exceed the max-active
// limit. Skips names whose stacks are already up (re-up / restart is net-zero).
// Used by `up` and `restart` so a batch never starts A then dies on B.
export async function guardMany(toStart: string[]): Promise<void> {
  const { value: max, source } = readMaxActive();
  if (max === Infinity) return;
  const running = await runningLabels();
  const runningSet = new Set(running);
  const needStart: string[] = [];
  for (const name of uniqueNames(toStart)) {
    const lbl = labelOf(name);
    if (lbl && runningSet.has(lbl)) continue;
    needStart.push(name);
  }
  // Already-up only (or empty list): net-zero — allow even if the host is
  // currently over max (e.g. max was lowered while stacks were still running).
  if (!exceedsMaxActive(max, running.length, needStart.length)) return;
  printMaxActiveHelp(
    max,
    source,
    running,
    needStart[0],
    running.length + needStart.length,
  );
}

export async function volumeExists(name: string): Promise<boolean> {
  const r = await runCapture("docker", ["volume", "inspect", name]);
  if (r.code === 0) return true;
  if (/no such volume/i.test(r.err) || /no such volume/i.test(r.out)) return false;
  if (r.code === 127) throw new CommandFailed("docker not available");
  throw new CommandFailed(r.err.trim() || `docker volume inspect ${name} failed`);
}

export async function dbImage(container: string): Promise<string> {
  const r = await runCapture("docker", ["inspect", "--format", "{{.Config.Image}}", container]);
  if (r.code !== 0 || r.out.trim() === "") {
    throw new CommandFailed(
      `cannot read the image of ${container} — is the stack stopped but the container still there?`,
    );
  }
  return r.out.trim();
}

/** Copy a stopped DB volume. Does not delete `from`. */
export async function copyDbVolume(opts: {
  image: string;
  from: string;
  to: string;
}): Promise<void> {
  const created = await runCapture("docker", ["volume", "create", opts.to]);
  if (created.code !== 0) {
    throw new CommandFailed(created.err.trim() || `could not create volume ${opts.to}`);
  }
  const copy = await runCapture("docker", [
    "run",
    "--rm",
    "--entrypoint",
    "/bin/cp",
    "-v",
    `${opts.from}:/from:ro`,
    "-v",
    `${opts.to}:/to`,
    opts.image,
    "-a",
    "/from/.",
    "/to/",
  ]);
  if (copy.code !== 0) {
    await runCapture("docker", ["volume", "rm", opts.to]);
    throw new CommandFailed(copy.err.trim() || `could not copy ${opts.from} to ${opts.to}`);
  }
  const check = await runCapture("docker", [
    "run",
    "--rm",
    "--entrypoint",
    "/bin/cat",
    "-v",
    `${opts.to}:/data:ro`,
    opts.image,
    "/data/PG_VERSION",
  ]);
  if (check.code !== 0 || check.out.trim() === "") {
    await runCapture("docker", ["volume", "rm", opts.to]);
    throw new CommandFailed(
      `copy of ${opts.from} has no PG_VERSION — left the original volume in place`,
    );
  }
}
