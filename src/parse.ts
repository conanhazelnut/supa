// Pure text parsers (registry, config.toml, dotenv, port re-banding, signing key).
// Everything here is side-effect-free and unit-tested in lib_test.ts.
import { escapeRegExp, expandTilde, join } from "./util.ts";

export interface Project {
  name: string;
  root: string;
}

// Parse registry text into projects (skips comments/blank/malformed lines,
// expands a leading ~).
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

// Read project_id (the docker label) from config.toml text.
export function parseLabel(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*project_id\s*=\s*"?([^"\s]+)"?/);
    if (m) return m[1];
  }
  return null;
}

// Read `major_version` under the [db] table from config.toml text.
export function parseMajorVersion(text: string): string | null {
  let inDb = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) inDb = /^\s*\[db\]\s*(#.*)?$/.test(line);
    else if (inDb) {
      const m = line.match(/^\s*major_version\s*=\s*(\d+)/);
      if (m) return m[1];
    }
  }
  return null;
}

// Set `major_version` under [db]; returns updated text + whether it changed.
export function setMajorVersion(text: string, ver: string): { text: string; changed: boolean } {
  let inDb = false;
  let changed = false;
  const out = text.split(/\r?\n/).map((line) => {
    if (/^\s*\[/.test(line)) {
      inDb = /^\s*\[db\]\s*(#.*)?$/.test(line);
      return line;
    }
    if (inDb) {
      const m = line.match(/^(\s*major_version\s*=\s*)(\d+)(.*)$/);
      if (m && m[2] !== ver) {
        changed = true;
        return `${m[1]}${ver}${m[3]}`;
      }
    }
    return line;
  }).join("\n");
  return { text: out, changed };
}

// Read the host `port` under `[section]` from config.toml text.
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

// Parse a per-project rename map ("APP_NAME = NATIVE" per line, # comments ok).
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

// Rename `supabase status -o env` output via a map, one native -> many app names.
// Returns the mapped KEY=VALUE lines + any natives not in the output.
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

// Re-band every 543XX port to `slot` (keep the service digit), and pull the
// edge_runtime inspector_port (default 8083, off-scheme) into 543<slot>8 so it
// can't collide across projects. Returns updated text + changes.
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

// Normalize `supabase gen signing-key` output (a single JWK object, or an array,
// possibly multi-line or with a stray notice) into the JSON *array* text that
// Supabase's signing_keys file requires. Throws on unparseable input.
export function signingKeyArray(genOutput: string): string {
  const starts: number[] = [];
  for (let i = 0; i < genOutput.length; i++) {
    if (genOutput[i] === "{" || genOutput[i] === "[") starts.push(i);
  }
  let parsed: unknown;
  outer:
  for (const start of starts) {
    for (let end = genOutput.length; end > start; end--) {
      const c = genOutput[end - 1];
      if (c !== "}" && c !== "]") continue;
      try {
        parsed = JSON.parse(genOutput.slice(start, end));
        break outer;
      } catch { /* keep shrinking */ }
    }
  }
  if (parsed === undefined) throw new Error("could not parse signing key JSON");
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  return JSON.stringify(arr, null, 2) + "\n";
}

// ---------- self-update (pure helpers) ----------------------------------------

// True when `latest` (a "vX.Y.Z" or "X.Y.Z" tag) is newer than `current`.
export function semverNewer(latest: string, current: string): boolean {
  const num = (s: string) => s.trim().replace(/^v/, "").split(".").map((p) => parseInt(p, 10) || 0);
  const [a, b] = [num(latest), num(current)];
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
  }
  return false;
}

// Release asset name for a platform — must match build.ts TARGETS naming.
export function releaseAsset(os: string, arch: string): string | null {
  if (arch !== "x86_64" && arch !== "aarch64") return null;
  if (os === "windows") return arch === "x86_64" ? "supa-x86_64-pc-windows-msvc.exe" : null;
  if (os === "darwin") return `supa-${arch}-apple-darwin`;
  if (os === "linux") return `supa-${arch}-unknown-linux-gnu`;
  return null;
}

// Find the SHA-256 for `asset` in SHA256SUMS.txt text ("<hash>  <file>" lines).
export function shaFor(sums: string, asset: string): string | null {
  for (const line of sums.split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(\S+)$/);
    if (m && m[2] === asset) return m[1].toLowerCase();
  }
  return null;
}

// ---------- backup: filename + output-dir resolution (pure) -------------------

// A full backup is roles+schema+data; the others dump a single part.
export type BackupType = "full" | "data" | "schema" | "roles";

// Local-time stamp `YYYY-MM-DD_HHMM` for backup filenames (sorts chronologically).
export function tsStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${
    p(d.getMinutes())
  }`;
}

// `<name>_<stamp>.sql` for full, `<name>_<type>_<stamp>.sql` for a single part.
export function backupFileName(name: string, type: BackupType, stamp: string): string {
  const suffix = type === "full" ? "" : `_${type}`;
  return `${name}${suffix}_${stamp}.sql`;
}

// Resolve where dumps go: an explicit --out wins, then the backup_dir config,
// then `<project-root>/backups/`. Throws if none is available.
export function resolveBackupDir(
  opts: { out?: string | null; configured?: string | null; projectRoot?: string | null },
): string {
  if (opts.out) return expandTilde(opts.out);
  if (opts.configured) return expandTilde(opts.configured);
  if (opts.projectRoot) return join(opts.projectRoot, "backups");
  throw new Error("cannot resolve a backup directory");
}

// Newest backup for `name` from a list of filenames. Sorts by the trailing
// `YYYY-MM-DD_HHMM` stamp (NOT the whole filename — a `_data_` type suffix would
// otherwise sort a data dump after a same-day full one), and excludes safety
// pre-restore dumps so `--latest` never picks the snapshot a restore just took.
export function latestBackup(files: string[], name: string): string | null {
  const stampOf = (f: string): string => f.match(/(\d{4}-\d{2}-\d{2}_\d{4})\.sql$/)?.[1] ?? "";
  const mine = files
    .filter((f) =>
      f.startsWith(`${name}_`) && f.endsWith(".sql") && !f.includes("_pre-restore_") &&
      stampOf(f) !== ""
    )
    .sort((a, b) => (stampOf(a) < stampOf(b) ? -1 : stampOf(a) > stampOf(b) ? 1 : 0));
  return mine.length ? mine[mine.length - 1] : null;
}

// ---------- restore hooks (per-project supa.hooks, pure parse) -----------------

// A project's optional lifecycle/restore/backup hooks. Values are shell commands
// (run in the project dir) — a project declares its own migrate/seed/prep steps,
// supa owns the flow. Unknown keys are ignored (forward-compatible).
export interface Hooks {
  restorePre?: string;
  restorePost?: string;
  backupType?: BackupType;
  upPre?: string;
  upPost?: string;
  downPre?: string;
  downPost?: string;
}
export function parseHooks(text: string): Hooks {
  const h: Hooks = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = line.match(/^([a-z.]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if (
      val.length >= 2 &&
      ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
    ) {
      val = val.slice(1, -1);
    }
    if (val === "") continue;
    if (m[1] === "restore.pre") h.restorePre = val;
    else if (m[1] === "restore.post") h.restorePost = val;
    else if (m[1] === "up.pre") h.upPre = val;
    else if (m[1] === "up.post") h.upPost = val;
    else if (m[1] === "down.pre") h.downPre = val;
    else if (m[1] === "down.post") h.downPost = val;
    else if (m[1] === "backup.type" && ["full", "data", "schema", "roles"].includes(val)) {
      h.backupType = val as BackupType;
    }
  }
  return h;
}

// ---------- resource limits (per-project supa.limits, pure parse) --------------

// Per-container caps applied on `supa up` (docker update). Keys are service names
// (e.g. `db`, `analytics`) or `default` (applied to every container).
export interface Cap {
  memory?: string; // e.g. "1g", "512m"
  cpus?: string; // e.g. "2", "1.5"
}
export type Limits = Record<string, Cap>;

export function parseLimits(text: string): Limits {
  const out: Limits = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z0-9_]+)\.(memory|cpus)\s*=\s*(\S+)/);
    if (!m) continue;
    const val = m[3];
    // memory: <n>[b|k|m|g]; cpus: a positive number — skip anything malformed.
    if (m[2] === "memory" && !/^\d+(\.\d+)?[bkmgBKMG]?$/.test(val)) continue;
    if (m[2] === "cpus" && !/^\d+(\.\d+)?$/.test(val)) continue;
    (out[m[1]] ??= {})[m[2] as "memory" | "cpus"] = val;
  }
  return out;
}

// ---------- docker scope attribution (pure) -----------------------------------
// supa manages Supabase stacks only. Everything below decides what on a shared
// docker host is supa's — the rest is another service's and is never touched.

// Every image the Supabase CLI pulls sits under a `supabase` namespace
// (supabase/postgres, public.ecr.aws/supabase/kong, ghcr.io/supabase/…). Any other
// repository belongs to something supa does not manage.
export function isSupabaseRepo(repo: string): boolean {
  const r = repo.trim();
  if (r === "" || r === "<none>") return false;
  const segs = r.split("/");
  return segs.length > 1 && segs.slice(0, -1).includes("supabase");
}

export interface ImageRow {
  id: string;
  repo: string;
  tag: string;
  size: string;
}
// Parse `docker image ls --format '{{.ID}}\t{{.Repository}}\t{{.Tag}}\t{{.Size}}'`.
export function parseImageRows(text: string): ImageRow[] {
  const out: ImageRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const [id, repo, tag, size] = line.split("\t");
    if (!id?.trim() || !repo?.trim()) continue;
    out.push({
      id: id.trim(),
      repo: repo.trim(),
      tag: (tag ?? "").trim(),
      size: (size ?? "").trim(),
    });
  }
  return out;
}

// Split untagged ("dangling") images into supa's and everyone else's. A pulled
// image keeps its RepoDigests after losing its tag — the only ownership evidence
// left. A locally built layer has none, so it is NEVER attributed to Supabase.
// Input: `docker image inspect --format '{{.Id}}\t{{json .RepoDigests}}'`.
export function attributeUntagged(text: string): { ours: string[]; others: string[] } {
  const ours: string[] = [];
  const others: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const [id, digestJson] = line.split("\t");
    const key = (id ?? "").trim();
    if (key === "") continue;
    let digests: string[] = [];
    try {
      const parsed = JSON.parse((digestJson ?? "").trim() || "null");
      if (Array.isArray(parsed)) digests = parsed.filter((d) => typeof d === "string");
    } catch { /* unparseable -> unattributable -> not ours */ }
    (digests.some((d) => isSupabaseRepo(d.split("@")[0])) ? ours : others).push(key);
  }
  return { ours, others };
}

// Does a container's image reference name this image? Refs are repo:tag or a bare
// (sometimes sha256-prefixed) id, so both forms have to be compared.
export function imageInUse(row: ImageRow, refs: Iterable<string>): boolean {
  const tagged = `${row.repo}:${row.tag}`;
  for (const raw of refs) {
    const ref = raw.trim();
    if (ref === "") continue;
    if (ref === tagged || ref === row.repo) return true;
    if (ref.replace(/^sha256:/, "").startsWith(row.id)) return true;
  }
  return false;
}

// 543xX bands published by containers carrying no Supabase project label, keyed by
// slot digit → container names. supa hands out bands, so it must not pick one
// another service already holds. Input:
// `docker ps --format '{{.Names}}\t{{.Ports}}\t{{.Label "com.supabase.cli.project"}}'`.
export function foreignSlotHolders(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const [name, ports, label] = line.split("\t");
    if ((label ?? "").trim() !== "") continue; // a Supabase stack — not foreign
    const who = (name ?? "").trim();
    if (who === "") continue;
    // A published range ("0.0.0.0:54330-54339->80-89/tcp") can cover several bands.
    for (const m of (ports ?? "").matchAll(/:(\d+)(?:-(\d+))?->/g)) {
      const lo = Number(m[1]);
      const hi = m[2] ? Number(m[2]) : lo;
      for (let d = 0; d <= 9; d++) {
        const base = 54300 + d * 10; // slot d owns 543d0–543d9
        if (lo > base + 9 || hi < base) continue;
        const slot = String(d);
        const list = out.get(slot) ?? [];
        if (!list.includes(who)) list.push(who);
        out.set(slot, list);
      }
    }
  }
  return out;
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
  const authHeader = /^[ \t]*\[auth\][ \t]*(#.*)?$/m;
  if (authHeader.test(text)) {
    return {
      text: text.replace(authHeader, (m) => `${m}\nsigning_keys_path = "${rel}"`),
      relPath: rel,
    };
  }
  return {
    text: `${text.replace(/\n*$/, "")}\n\n[auth]\nsigning_keys_path = "${rel}"\n`,
    relPath: rel,
  };
}
