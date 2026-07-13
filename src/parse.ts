// Pure text parsers (registry, config.toml, dotenv, port re-banding, signing key).
// Everything here is side-effect-free and unit-tested in lib_test.ts.
import { escapeRegExp, expandTilde } from "./util.ts";

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
