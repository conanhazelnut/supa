// Host-port plan for a local stack. Pure: toml text in, numbers and env out.
// Auto slots start at 54400 so a committed 54300–54399 band is never rewritten.

export const SLOT_MIN = 0;
export const SLOT_MAX = 111;

export type HostKey =
  | "shadow"
  | "api"
  | "db"
  | "studio"
  | "local_smtp"
  | "smtp"
  | "pop3"
  | "analytics"
  | "inspector"
  | "pooler";

export interface HostSpec {
  key: HostKey;
  env: string;
  /** Official template value. Optional keys use this only when the line is present. */
  stock: number;
  /** Added to `54400 + slot * 100`. API is 21 → 54421. */
  tail: number;
  optional: boolean;
}

export const HOST_PORTS: readonly HostSpec[] = [
  { key: "shadow", env: "SUPABASE_DB_SHADOW_PORT", stock: 54320, tail: 20, optional: false },
  { key: "api", env: "SUPABASE_API_PORT", stock: 54321, tail: 21, optional: false },
  { key: "db", env: "SUPABASE_DB_PORT", stock: 54322, tail: 22, optional: false },
  { key: "studio", env: "SUPABASE_STUDIO_PORT", stock: 54323, tail: 23, optional: false },
  {
    key: "local_smtp",
    env: "SUPABASE_LOCAL_SMTP_PORT",
    stock: 54324,
    tail: 24,
    optional: false,
  },
  {
    key: "smtp",
    env: "SUPABASE_LOCAL_SMTP_SMTP_PORT",
    stock: 54325,
    tail: 25,
    optional: true,
  },
  {
    key: "pop3",
    env: "SUPABASE_LOCAL_SMTP_POP3_PORT",
    stock: 54326,
    tail: 26,
    optional: true,
  },
  {
    key: "analytics",
    env: "SUPABASE_ANALYTICS_PORT",
    stock: 54327,
    tail: 27,
    optional: false,
  },
  {
    key: "inspector",
    env: "SUPABASE_EDGE_RUNTIME_INSPECTOR_PORT",
    stock: 8083,
    tail: 28,
    optional: false,
  },
  { key: "pooler", env: "SUPABASE_DB_POOLER_PORT", stock: 54329, tail: 29, optional: false },
];

export interface FoundPort {
  key: HostKey;
  value: number;
}

const FIELD_KEY: Record<string, Partial<Record<string, HostKey>>> = {
  api: { port: "api" },
  db: { port: "db", shadow_port: "shadow" },
  studio: { port: "studio" },
  local_smtp: { port: "local_smtp", smtp_port: "smtp", pop3_port: "pop3" },
  inbucket: { port: "local_smtp", smtp_port: "smtp", pop3_port: "pop3" },
  analytics: { port: "analytics" },
  "db.pooler": { port: "pooler" },
  edge_runtime: { inspector_port: "inspector" },
};

export function specOf(key: HostKey): HostSpec {
  const spec = HOST_PORTS.find((s) => s.key === key);
  if (!spec) throw new Error(`unknown host port ${key}`);
  return spec;
}

export function portForSlot(tail: number, slot: number): number {
  return 54400 + slot * 100 + tail;
}

/** Uncommented host ports. `[inbucket]` is read as `local_smtp` so an old file is not treated as stock. */
export function readHostPorts(toml: string): FoundPort[] {
  const found: FoundPort[] = [];
  let section = "";
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const sec = line.match(/^\[([A-Za-z0-9_.]+)\]/);
    if (sec) {
      section = sec[1];
      continue;
    }
    const fields = FIELD_KEY[section];
    if (!fields) continue;
    const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(\d+)\b/);
    if (!m) continue;
    const key = fields[m[1]];
    if (!key) continue;
    found.push({ key, value: Number(m[2]) });
  }
  return found;
}

/** Ports written to a value other than the official template. Only these stay as written. */
export function fixedKeys(found: FoundPort[]): Set<HostKey> {
  const fixed = new Set<HostKey>();
  for (const f of found) {
    if (f.value !== specOf(f.key).stock) fixed.add(f.key);
  }
  return fixed;
}

export function parseSlotText(text: string): number | "missing" | "invalid" {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = line.match(/^slot\s*=\s*(\d+)\s*(?:#.*)?$/);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isInteger(n) && n >= SLOT_MIN && n <= SLOT_MAX) return n;
    return "invalid";
  }
  return "missing";
}

/** Ports this project publishes. A non-stock value stays; stock ports follow `slot`. */
export function effectivePorts(found: FoundPort[], slot: number | null): Record<HostKey, number> {
  const written = new Map(found.map((f) => [f.key, f.value]));
  const fixed = fixedKeys(found);
  const out = {} as Record<HostKey, number>;
  for (const spec of HOST_PORTS) {
    const explicit = written.get(spec.key);
    if (spec.optional && explicit === undefined) continue;
    if (fixed.has(spec.key)) out[spec.key] = explicit ?? spec.stock;
    else if (slot === null) out[spec.key] = explicit ?? spec.stock;
    else out[spec.key] = portForSlot(spec.tail, slot);
  }
  return out;
}

export function envForPorts(
  ports: Record<string, number>,
  found: FoundPort[],
): Record<string, string> {
  const fixed = fixedKeys(found);
  const env: Record<string, string> = {};
  for (const spec of HOST_PORTS) {
    if (fixed.has(spec.key)) continue;
    const value = ports[spec.key];
    if (value === undefined) continue;
    env[spec.env] = String(value);
  }
  return env;
}

export function firstFreeSlot(taken: ReadonlySet<number>, found: FoundPort[]): number | null {
  for (let slot = SLOT_MIN; slot <= SLOT_MAX; slot++) {
    const ports = Object.values(effectivePorts(found, slot));
    if (ports.every((p) => !taken.has(p))) return slot;
  }
  return null;
}

export interface PublishedRow {
  name: string;
  label: string;
  ports: number[];
}

/** `docker ps` lines `name \\t ports \\t label`. A range expands to each host port. */
export function parsePublishedPorts(text: string): PublishedRow[] {
  const rows: PublishedRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const [name = "", ports = "", label = ""] = line.split("\t");
    const nums: number[] = [];
    for (const m of ports.matchAll(/:(\d+)(?:-(\d+))?->/g)) {
      const lo = Number(m[1]);
      const hi = m[2] ? Number(m[2]) : lo;
      for (let p = lo; p <= hi && p - lo < 64; p++) nums.push(p);
    }
    rows.push({ name: name.trim(), label: label.trim(), ports: nums });
  }
  return rows;
}

/**
 * After start, the published API port must be the one we asked for.
 * Empty port columns (a test shim, or ports not shown) are not a mismatch.
 */
export function apiPortMismatch(
  rows: PublishedRow[],
  label: string,
  expectedApi: number,
): string | null {
  const own = rows.filter((r) => r.label === label);
  const published = own.flatMap((r) => r.ports);
  if (published.includes(expectedApi) || published.length === 0) return null;
  // Only the stock API port proves the CLI ignored the override. Other published
  // ports (db, or an excluded gateway) are not a failed assignment.
  if (!published.includes(54321) || expectedApi === 54321) return null;
  const who = own.find((r) => r.ports.includes(54321));
  return `stack '${label}' published 54321 but this machine's API port is ${expectedApi}` +
    (who ? ` (${who.name})` : "");
}
