// Tests for supa's pure parsing/formatting logic. Zero dependencies — a tiny
// inline assert keeps the whole project dependency-free.  Run: deno test
import {
  escapeRegExp,
  expandTilde,
  fmtMiB,
  join,
  maskSecret,
  memToMiB,
  parentDir,
} from "./util.ts";
import {
  applyEnvMap,
  backupFileName,
  ensureSigningKeysPath,
  latestBackup,
  mergeDotenv,
  parseEnvMap,
  parseHooks,
  parseLabel,
  parsePort,
  parseRegistry,
  rebandText,
  resolveBackupDir,
  signingKeyArray,
  tsStamp,
} from "./parse.ts";

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
Deno.test("parsePort treats the section name literally (no regex injection)", () => {
  // '.' in the section must not act as a regex wildcard
  eq(parsePort("[apiXtls]\nport = 999\n[api]\nport = 111\n", "api"), "111");
});
Deno.test("escapeRegExp escapes regex metacharacters", () => {
  eq(escapeRegExp("a.b+c"), "a\\.b\\+c");
  eq(escapeRegExp("plain"), "plain");
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
Deno.test("applyEnvMap renames, supports one-to-many, reports missing", () => {
  const native = `API_URL="http://127.0.0.1:54321"\nDB_URL="postgres://x"\n`;
  const map = [
    { app: "SUPABASE_URL", native: "API_URL" },
    { app: "DATABASE_URL", native: "DB_URL" },
    { app: "DIRECT_URL", native: "DB_URL" }, // one native -> two app names
    { app: "NOPE", native: "MISSING" },
  ];
  const { incoming, missing } = applyEnvMap(native, map);
  eq(incoming.split("\n"), [
    `SUPABASE_URL="http://127.0.0.1:54321"`,
    `DATABASE_URL="postgres://x"`,
    `DIRECT_URL="postgres://x"`,
  ]);
  eq(missing, ["MISSING"]);
});
Deno.test("mergeDotenv seeds a file from empty and ends with a newline", () => {
  const { text } = mergeDotenv("", "A=1\nB=2\n");
  ok(text.endsWith("\n"));
  ok(text.includes("A=1") && text.includes("B=2"));
});
Deno.test("mergeDotenv preserves values containing '='", () => {
  const { text, map } = mergeDotenv("", "DB_URL=postgres://u:p@h/db?a=b&c=d\n");
  eq(map.DB_URL, "postgres://u:p@h/db?a=b&c=d");
  ok(text.includes("DB_URL=postgres://u:p@h/db?a=b&c=d"));
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
Deno.test("ensureSigningKeysPath handles an [auth] header with a trailing comment", () => {
  const { text } = ensureSigningKeysPath(`[auth] # my auth\nenabled = true\n`);
  eq((text.match(/^\s*\[auth\]/gm) || []).length, 1); // no duplicate [auth] table
  ok(text.includes("signing_keys_path"));
});

// ---------- signing-key normalisation (rotate) --------------------------------
Deno.test("signingKeyArray wraps a single JWK object in an array", () => {
  const arr = JSON.parse(signingKeyArray(`{"kty":"EC","kid":"a"}`));
  eq(Array.isArray(arr), true);
  eq(arr.length, 1);
  eq(arr[0].kid, "a");
});
Deno.test("signingKeyArray keeps an existing array", () => {
  const arr = JSON.parse(signingKeyArray(`[{"kty":"EC","kid":"a"},{"kid":"b"}]`));
  eq(arr.length, 2);
});
Deno.test("signingKeyArray handles multi-line JSON and a trailing notice", () => {
  const out = `{\n  "kty": "EC",\n  "kid": "x"\n}\nA new version of the CLI is available\n`;
  const arr = JSON.parse(signingKeyArray(out));
  eq(arr.length, 1);
  eq(arr[0].kid, "x");
});
Deno.test("signingKeyArray strips a trailing notice that contains brackets", () => {
  const out = `{"kty":"EC","kid":"z"}\nRun [supabase upgrade] to update.\n`;
  const arr = JSON.parse(signingKeyArray(out));
  eq(arr.length, 1);
  eq(arr[0].kid, "z");
});
Deno.test("signingKeyArray strips a leading notice that contains a brace", () => {
  const arr = JSON.parse(signingKeyArray(`Use {supabase} upgrade\n{"kty":"EC","kid":"q"}\n`));
  eq(arr.length, 1);
  eq(arr[0].kid, "q");
});
Deno.test("signingKeyArray throws on garbage", () => {
  let threw = false;
  try {
    signingKeyArray("not json at all");
  } catch {
    threw = true;
  }
  ok(threw, "should throw on unparseable input");
});

// ---------- backup: filename + dir resolution ---------------------------------
Deno.test("tsStamp formats local time as YYYY-MM-DD_HHMM", () => {
  eq(tsStamp(new Date(2026, 6, 14, 1, 30)), "2026-07-14_0130"); // month is 0-based
  eq(tsStamp(new Date(2026, 11, 3, 9, 5)), "2026-12-03_0905"); // zero-padding
});
Deno.test("backupFileName: full has no type suffix, parts do", () => {
  eq(backupFileName("larp", "full", "2026-07-14_0130"), "larp_2026-07-14_0130.sql");
  eq(backupFileName("larp", "data", "2026-07-14_0130"), "larp_data_2026-07-14_0130.sql");
  eq(backupFileName("pams", "schema", "2026-07-14_0130"), "pams_schema_2026-07-14_0130.sql");
  eq(backupFileName("pams", "roles", "2026-07-14_0130"), "pams_roles_2026-07-14_0130.sql");
});
Deno.test("resolveBackupDir precedence: out > configured > project/backups", () => {
  eq(resolveBackupDir({ out: "/x", configured: "/y", projectRoot: "/z" }), "/x");
  eq(resolveBackupDir({ configured: "/y", projectRoot: "/z" }), "/y");
  eq(resolveBackupDir({ projectRoot: "/z" }), "/z/backups");
  ok(!resolveBackupDir({ out: "~/b" }).startsWith("~"), "expands a leading ~");
});
Deno.test("resolveBackupDir throws when nothing resolves", () => {
  let threw = false;
  try {
    resolveBackupDir({});
  } catch {
    threw = true;
  }
  ok(threw, "should throw when no dir can be resolved");
});

// ---------- restore: latest-file selection + hooks ----------------------------
Deno.test("latestBackup picks the newest and ignores pre-restore + other projects", () => {
  const files = [
    "larp_2026-07-10_0900.sql",
    "larp_2026-07-14_1200.sql", // newest for larp
    "larp_data_2026-07-12_0800.sql",
    "larp_pre-restore_2026-07-20_0000.sql", // must be ignored
    "pams_2026-07-19_0000.sql", // different project
    "notes.txt",
  ];
  eq(latestBackup(files, "larp"), "larp_2026-07-14_1200.sql");
  eq(latestBackup(files, "pams"), "pams_2026-07-19_0000.sql");
  eq(latestBackup(files, "nope"), null);
});
Deno.test("latestBackup returns null when only a pre-restore dump exists", () => {
  eq(latestBackup(["larp_pre-restore_2026-07-20_0000.sql"], "larp"), null);
});
Deno.test("parseHooks reads restore hooks + backup type, skips junk", () => {
  const h = parseHooks(
    `# hooks\nrestore.pre = supabase db reset\nrestore.post = "deno task db:migrate"\n` +
      `backup.type = data\nunknown.key = x\nbackup.type = bogus\n`,
  );
  eq(h.restorePre, "supabase db reset");
  eq(h.restorePost, "deno task db:migrate"); // surrounding quotes stripped
  // last valid backup.type wins; "bogus" is rejected so "data" stands
  eq(h.backupType, "data");
});
Deno.test("parseHooks returns empty object for blank/garbage input", () => {
  eq(parseHooks("# just a comment\n\n"), {});
});
