// Tests for supa's pure parsing/formatting logic. Zero dependencies — a tiny
// inline assert keeps the whole project dependency-free.  Run: deno test
import {
  ensureSigningKeysPath,
  expandTilde,
  fmtMiB,
  join,
  maskSecret,
  memToMiB,
  mergeDotenv,
  parentDir,
  parseEnvMap,
  parseLabel,
  parsePort,
  parseRegistry,
  rebandText,
} from "./supa.ts";

function eq<T>(actual: T, expected: T, msg = ""): void {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}\n  expected: ${e}\n  actual:   ${a}`);
}
function ok(cond: boolean, msg = "expected true"): void {
  if (!cond) throw new Error(msg);
}

// ---------- path helpers ------------------------------------------------------
Deno.test("join collapses slashes and drops empties", () => {
  eq(join("a", "b", "c"), "a/b/c");
  eq(join("a", "", "c"), "a/c");
  eq(join("a/", "/b"), "a/b");
});
Deno.test("parentDir", () => {
  eq(parentDir("/a/b/c"), "/a/b");
  eq(parentDir("a\\b\\c"), "a/b"); // backslashes normalized
  eq(parentDir("file"), ".");
});
Deno.test("expandTilde", () => {
  eq(expandTilde("/abs/path"), "/abs/path"); // no tilde -> unchanged
  eq(expandTilde("relative"), "relative");
  ok(!expandTilde("~/x").startsWith("~"), "~ should expand");
  ok(expandTilde("~/x").endsWith("/x"));
});

// ---------- registry ----------------------------------------------------------
Deno.test("parseRegistry skips comments/blanks/malformed", () => {
  const reg = parseRegistry(
    "# a comment\n\nweb|/code/web\nmalformed-no-pipe\n|/no/name\napi | /code/api \n",
  );
  eq(reg, [{ name: "web", root: "/code/web" }, { name: "api", root: "/code/api" }]);
});
Deno.test("parseRegistry expands a leading tilde", () => {
  const reg = parseRegistry("x|~/proj");
  ok(reg[0].root.endsWith("/proj") && !reg[0].root.startsWith("~"));
});

// ---------- config.toml -------------------------------------------------------
const CFG = `project_id = "myproj"
[api]
port = 54321
[db]
port = 54322
shadow_port = 54320
[db.pooler]
port = 54329
[studio]
port = 54323
`;
Deno.test("parseLabel reads project_id (quoted & unquoted)", () => {
  eq(parseLabel(CFG), "myproj");
  eq(parseLabel("project_id = bare\n"), "bare");
  eq(parseLabel("[api]\nport = 1\n"), null);
});
Deno.test("parsePort respects section boundaries", () => {
  eq(parsePort(CFG, "api"), "54321");
  eq(parsePort(CFG, "db"), "54322"); // not shadow_port, not [db.pooler]
  eq(parsePort(CFG, "studio"), "54323");
  eq(parsePort(CFG, "realtime"), null);
});

// ---------- port re-banding ---------------------------------------------------
Deno.test("rebandText keeps the service digit, changes the slot", () => {
  const { text, changes } = rebandText("port = 54321\nport = 54322\n", "5");
  eq(text, "port = 54351\nport = 54352\n");
  eq(changes.length, 2);
});
Deno.test("rebandText pulls off-scheme inspector_port into 543<slot>8", () => {
  const { text } = rebandText("inspector_port = 8083\n", "7");
  eq(text, "inspector_port = 54378\n");
});
Deno.test("rebandText is a no-op when already on the target slot", () => {
  const { changes } = rebandText("port = 54351\n", "5");
  eq(changes.length, 0);
});
Deno.test("rebandText does not touch 6-digit numbers", () => {
  const { text } = rebandText("x = 543210\n", "9");
  eq(text, "x = 543210\n");
});

// ---------- RAM parsing -------------------------------------------------------
Deno.test("memToMiB", () => {
  eq(memToMiB("120MiB"), 120);
  eq(memToMiB("1GiB"), 1024);
  eq(memToMiB("512KiB"), 0.5);
  eq(Math.round(memToMiB("7.6GiB")), 7782);
  eq(memToMiB("garbage"), 0);
});
Deno.test("fmtMiB", () => {
  eq(fmtMiB(120), "120MiB");
  eq(fmtMiB(2048), "2.0GiB");
});

// ---------- secrets & dotenv --------------------------------------------------
Deno.test("maskSecret masks only long secret-ish keys", () => {
  ok(maskSecret("ANON_KEY", "abcdefghijklmnop").includes("…"));
  eq(maskSecret("API_URL", "http://localhost"), "http://localhost");
  eq(maskSecret("KEY", "short"), "short"); // too short to mask
});
Deno.test("mergeDotenv updates in place, keeps others, appends new", () => {
  const { text, keys } = mergeDotenv("KEEP=1\nANON_KEY=old\n", "ANON_KEY=new\nAPI_URL=u\n");
  ok(text.includes("KEEP=1"), "keeps unrelated line");
  ok(text.includes("ANON_KEY=new"), "updates in place");
  ok(!text.includes("ANON_KEY=old"), "old value gone");
  ok(text.includes("API_URL=u"), "appends new key");
  eq(keys.sort(), ["ANON_KEY", "API_URL"]);
});

// ---------- env map -----------------------------------------------------------
Deno.test("parseEnvMap supports comments and one-to-many", () => {
  const m = parseEnvMap("# map\nDATABASE_URL = DB_URL\nDIRECT_URL = DB_URL   # dup ok\n");
  eq(m, [
    { app: "DATABASE_URL", native: "DB_URL" },
    { app: "DIRECT_URL", native: "DB_URL" },
  ]);
});

// ---------- signing key path --------------------------------------------------
Deno.test("ensureSigningKeysPath uncomments an existing commented line", () => {
  const { text, relPath } = ensureSigningKeysPath(
    `[auth]\n# signing_keys_path = "./signing_keys.json"\n`,
  );
  eq(relPath, "./signing_keys.json");
  ok(/^signing_keys_path = "\.\/signing_keys\.json"$/m.test(text));
});
Deno.test("ensureSigningKeysPath keeps an already-active line", () => {
  const src = `[auth]\nsigning_keys_path = "./keys.json"\n`;
  const { text, relPath } = ensureSigningKeysPath(src);
  eq(text, src);
  eq(relPath, "./keys.json");
});
Deno.test("ensureSigningKeysPath inserts under [auth] when absent", () => {
  const { text } = ensureSigningKeysPath(`[auth]\nenabled = true\n`);
  ok(text.includes(`signing_keys_path = "./signing_keys.json"`));
});
Deno.test("ensureSigningKeysPath appends [auth] when there is none", () => {
  const { text } = ensureSigningKeysPath(`project_id = "x"\n`);
  ok(text.includes("[auth]") && text.includes("signing_keys_path"));
});
