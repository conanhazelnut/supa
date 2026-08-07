// Tests for supa's pure parsing/formatting logic. No test framework — a tiny
// inline assert is all the harness this needs.  Run: deno test
import { SEPARATOR as SEP } from "@std/path";
import {
  absolutize,
  decodeText,
  escapeRegExp,
  expandTilde,
  fmtMiB,
  home,
  join,
  maskSecret,
  memToMiB,
  parentDir,
} from "./util.ts";
import {
  applyEnvMap,
  attributeUntagged,
  backupFileName,
  droppedRegistryNames,
  ensureSigningKeysPath,
  foreignSlotHolders,
  imageInUse,
  isReleaseTag,
  isSupabaseRepo,
  latestBackup,
  mergeDotenv,
  parseEnvMap,
  parseHooks,
  parseImageRows,
  parseLabel,
  parseLimits,
  parseMajorVersion,
  parsePort,
  parseRegistry,
  rebandText,
  releaseAsset,
  resolveBackupDir,
  semverNewer,
  setMajorVersion,
  shaFor,
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
Deno.test("join uses the OS separator, collapses slashes, drops empties", () => {
  eq(join("a", "b", "c"), `a${SEP}b${SEP}c`);
  eq(join("a", "", "c"), `a${SEP}c`);
  eq(join("a/", "/b"), `a${SEP}b`);
});
Deno.test("parentDir", () => {
  eq(parentDir(join("a", "b", "c")), join("a", "b"));
  eq(parentDir("file"), ".");
  if (Deno.build.os === "windows") {
    eq(parentDir("C:\\a\\b"), "C:\\a");
    eq(parentDir("\\\\server\\share\\dir"), "\\\\server\\share\\"); // UNC root survives
  }
});
Deno.test("expandTilde", () => {
  eq(expandTilde("/abs/path"), "/abs/path"); // no tilde -> unchanged
  eq(expandTilde("relative"), "relative");
  eq(expandTilde("~/x"), join(home(), "x"));
  eq(expandTilde("~"), home());
});
Deno.test("absolutize expands ~ and resolves relative against cwd", () => {
  eq(absolutize("/abs/path"), "/abs/path");
  eq(absolutize("~/x"), join(home(), "x"));
  const rel = absolutize("rel-only");
  ok(rel.endsWith(`${SEP}rel-only`), `got ${rel}`);
  ok(rel !== "rel-only", "must not stay relative");
});

// ---------- text decoding (BOM sniffing) --------------------------------------
function utf16le(s: string): Uint8Array {
  const buf = new Uint8Array(2 + s.length * 2);
  buf[0] = 0xff;
  buf[1] = 0xfe;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    buf[2 + i * 2] = c & 0xff;
    buf[3 + i * 2] = c >> 8;
  }
  return buf;
}
Deno.test("decodeText reads UTF-16LE with BOM (PowerShell Out-File default)", () => {
  eq(decodeText(utf16le("web|C:\\code\\web\r\n")), "web|C:\\code\\web\r\n");
});
Deno.test("decodeText reads UTF-16BE with BOM", () => {
  const le = utf16le("a|b");
  const be = new Uint8Array(le.length);
  for (let i = 0; i < le.length; i += 2) {
    be[i] = le[i + 1];
    be[i + 1] = le[i];
  }
  eq(decodeText(be), "a|b");
});
Deno.test("decodeText strips a UTF-8 BOM and passes plain UTF-8 through", () => {
  const plain = new TextEncoder().encode("web|/code/web\n");
  eq(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...plain])), "web|/code/web\n");
  eq(decodeText(plain), "web|/code/web\n");
  eq(decodeText(new Uint8Array(0)), "");
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
  eq(reg[0].root, join(home(), "proj"));
});
Deno.test("parseRegistry passes parked (*|dir) lines through", () => {
  const reg = parseRegistry("web|/code/web\n*|/code\n");
  eq(reg, [{ name: "web", root: "/code/web" }, { name: "*", root: "/code" }]);
});
// TEETH: names reach bash completion via `compgen -W "$(supa __names)"`, which
// expands command substitutions in its wordlist. Accepting a name outside
// SAFE_NAME turns Tab into code execution — REVERT the filter → RED.
Deno.test("parseRegistry drops names outside the safe charset", () => {
  const reg = parseRegistry(
    "ok-name|/a\nbad name|/b\nx$(whoami)|/c\n`ls`|/d\nsemi;rm|/e\n中文|/f\nok.two|/g\n",
  );
  eq(reg.map((p) => p.name), ["ok-name", "ok.two"]);
});
// TEETH: doctor is the only place a charset-dropped line is surfaced — if this
// list and parseRegistry ever disagree on the accept set, a hand-edited project
// vanishes with no explanation. REVERT either side → RED.
Deno.test("droppedRegistryNames mirrors parseRegistry's accept set", () => {
  const text = "ok|/a\nbad name|/b\n*|/c\nx$(y)|/d\n# comment\nnopipe\n|/empty\n";
  const dropped = droppedRegistryNames(text);
  eq(dropped, ["bad name", "x$(y)"]); // charset drops only — not malformed lines
  const accepted = parseRegistry(text).map((p) => p.name);
  eq(accepted, ["ok", "*"]);
  eq(dropped.filter((d) => accepted.includes(d)), [], "disjoint from accepted");
});

// ---------- self-update helpers -----------------------------------------------
Deno.test("semverNewer compares vX.Y.Z tags numerically", () => {
  ok(semverNewer("v0.2.0", "0.1.0"), "minor bump");
  ok(semverNewer("v0.1.10", "0.1.9"), "numeric not lexicographic");
  ok(semverNewer("1.0.0", "0.9.9"), "major bump");
  ok(!semverNewer("v0.1.0", "0.1.0"), "equal is not newer");
  ok(!semverNewer("v0.1.0", "0.2.0"), "older is not newer");
});
// TEETH: the latest-release tag feeds self-update URL building; anything beyond
// vX.Y.Z admits path segments into the download URL — REVERT the gate → RED.
Deno.test("isReleaseTag accepts only vX.Y.Z", () => {
  ok(isReleaseTag("v0.1.1"), "v-prefixed");
  ok(isReleaseTag("1.2.3"), "bare");
  eq(isReleaseTag("v1.2.3-rc.1"), false); // supa never publishes pre-releases
  eq(isReleaseTag("9x/../../evil"), false);
  eq(isReleaseTag("v1.2"), false);
  eq(isReleaseTag(""), false);
});
Deno.test("releaseAsset matches build.ts target naming", () => {
  eq(releaseAsset("windows", "x86_64"), "supa-x86_64-pc-windows-msvc.exe");
  eq(releaseAsset("darwin", "aarch64"), "supa-aarch64-apple-darwin");
  eq(releaseAsset("linux", "x86_64"), "supa-x86_64-unknown-linux-gnu");
  eq(releaseAsset("windows", "aarch64"), null); // no arm64 windows build
  eq(releaseAsset("freebsd", "x86_64"), null);
});
Deno.test("shaFor finds the asset line in SHA256SUMS.txt", () => {
  const h = "a".repeat(64);
  const sums = `${h}  supa-x86_64-apple-darwin\n${"b".repeat(64)}  other\n`;
  eq(shaFor(sums, "supa-x86_64-apple-darwin"), h);
  eq(shaFor(sums, "missing"), null);
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
Deno.test("tsStamp formats local time as YYYY-MM-DD_HHMMSS", () => {
  eq(tsStamp(new Date(2026, 6, 14, 1, 30, 7)), "2026-07-14_013007"); // month is 0-based
  eq(tsStamp(new Date(2026, 11, 3, 9, 5, 0)), "2026-12-03_090500"); // zero-padding
});
Deno.test("backupFileName: full has no type suffix, parts do", () => {
  eq(backupFileName("larp", "full", "2026-07-14_013007"), "larp_2026-07-14_013007.sql");
  eq(backupFileName("larp", "data", "2026-07-14_013007"), "larp_data_2026-07-14_013007.sql");
  eq(backupFileName("pams", "schema", "2026-07-14_013007"), "pams_schema_2026-07-14_013007.sql");
  eq(backupFileName("pams", "roles", "2026-07-14_013007"), "pams_roles_2026-07-14_013007.sql");
});
Deno.test("resolveBackupDir precedence: out > configured > project/backups", () => {
  eq(resolveBackupDir({ out: "/x", configured: "/y", projectRoot: "/z" }), "/x");
  eq(resolveBackupDir({ configured: "/y", projectRoot: "/z" }), "/y");
  eq(resolveBackupDir({ projectRoot: "/z" }), join("/z", "backups"));
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
    "larp_2026-07-14_1200.sql", // newest for larp (minute-precision, legacy)
    "larp_data_2026-07-12_0800.sql",
    "larp_pre-restore_2026-07-20_0000.sql", // must be ignored
    "pams_2026-07-19_0000.sql", // different project
    "notes.txt",
  ];
  eq(latestBackup(files, "larp"), "larp_2026-07-14_1200.sql");
  eq(latestBackup(files, "pams"), "pams_2026-07-19_0000.sql");
  eq(latestBackup(files, "nope"), null);
});
Deno.test("latestBackup prefers .sql.gz when it is newer, and accepts second-precision stamps", () => {
  const files = [
    "larp_2026-07-14_120000.sql",
    "larp_2026-07-14_120001.sql.gz", // newer + gzipped
    "larp_pre-restore_2026-07-14_120002.sql.gz",
  ];
  eq(latestBackup(files, "larp"), "larp_2026-07-14_120001.sql.gz");
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
Deno.test("parseHooks reads lifecycle hooks (up/down pre/post)", () => {
  const h = parseHooks(
    "up.pre = docker info\nup.post = deno task seed\ndown.pre = echo bye\ndown.post = echo gone\n",
  );
  eq(h.upPre, "docker info");
  eq(h.upPost, "deno task seed");
  eq(h.downPre, "echo bye");
  eq(h.downPost, "echo gone");
});

// ---------- upgrade: major_version read/write ---------------------------------
const DBCFG = `project_id = "x"
[db]
port = 54322
major_version = 17
[db.pooler]
port = 54329
major_version = 99
`;
Deno.test("parseMajorVersion reads it from [db] only (not [db.pooler])", () => {
  eq(parseMajorVersion(DBCFG), "17");
  eq(parseMajorVersion(`[db]\nmajor_version = 15\n`), "15");
  eq(parseMajorVersion(`[api]\nport = 1\n`), null);
});
Deno.test("setMajorVersion bumps [db] in place, leaves other tables + reports change", () => {
  const { text, changed } = setMajorVersion(DBCFG, "18");
  eq(changed, true);
  eq(parseMajorVersion(text), "18");
  ok(text.includes("major_version = 99"), "[db.pooler] value untouched");
  ok(text.includes("port = 54322"), "other [db] keys untouched");
});
Deno.test("setMajorVersion is a no-op when already at target", () => {
  const { changed } = setMajorVersion(DBCFG, "17");
  eq(changed, false);
});

// ---------- docker scope attribution ------------------------------------------
// TEETH: these decide what supa may delete on a shared docker host. Loosen them and
// prune reaches another project's images — REVERT any of these → RED.
Deno.test("isSupabaseRepo accepts only a supabase namespace", () => {
  ok(isSupabaseRepo("supabase/postgres"), "docker hub");
  ok(isSupabaseRepo("public.ecr.aws/supabase/kong"), "ecr mirror");
  ok(isSupabaseRepo("ghcr.io/supabase/studio"), "ghcr");
  eq(isSupabaseRepo("php"), false);
  eq(isSupabaseRepo("library/php"), false);
  eq(isSupabaseRepo("myorg/supabase-clone"), false); // namespace must match exactly
  eq(isSupabaseRepo("postgres"), false); // bare official image is not ours
  eq(isSupabaseRepo("<none>"), false);
  eq(isSupabaseRepo(""), false);
});
Deno.test("parseImageRows tolerates blank/short lines", () => {
  const rows = parseImageRows(
    "abc123\tpublic.ecr.aws/supabase/postgres\t15.8.1\t3.2GB\n\nbad-line\ndef456\tphp\t8.3\t500MB\n",
  );
  eq(rows.length, 2);
  eq(rows[0], {
    id: "abc123",
    repo: "public.ecr.aws/supabase/postgres",
    tag: "15.8.1",
    size: "3.2GB",
  });
  eq(rows[1].repo, "php");
});
Deno.test("attributeUntagged claims only images with a supabase repo digest", () => {
  const { ours, others } = attributeUntagged(
    `sha256:aaa\t["public.ecr.aws/supabase/gotrue@sha256:1"]\n` +
      `sha256:bbb\t["php@sha256:2"]\n` +
      `sha256:ccc\t[]\n` + // locally built php layer — no digest, never ours
      `sha256:ddd\tnull\n` +
      `sha256:eee\tnot-json\n`,
  );
  eq(ours, ["sha256:aaa"]);
  eq(others, ["sha256:bbb", "sha256:ccc", "sha256:ddd", "sha256:eee"]);
});
Deno.test("imageInUse matches a container ref by tag or id", () => {
  const row = {
    id: "abc123def456",
    repo: "public.ecr.aws/supabase/kong",
    tag: "2.8.1",
    size: "1GB",
  };
  ok(imageInUse(row, ["public.ecr.aws/supabase/kong:2.8.1"]), "repo:tag ref");
  ok(imageInUse(row, ["sha256:abc123def456789"]), "sha-prefixed id ref");
  ok(imageInUse(row, ["abc123def456"]), "bare id ref");
  eq(imageInUse(row, ["php:8.3", ""]), false);
});
Deno.test("foreignSlotHolders maps 543XX bands to non-supabase containers only", () => {
  const holders = foreignSlotHolders(
    `php-web\t0.0.0.0:54331->80/tcp, :::54331->80/tcp\t\n` +
      `supabase_kong_api\t0.0.0.0:54321->8000/tcp\tapi\n` + // labelled -> a supa stack
      `redis\t0.0.0.0:6379->6379/tcp\t\n` + // outside the 543XX bands
      `php-queue\t0.0.0.0:54339->9000/tcp\t\n` +
      `exposed-only\t8080/tcp\t\n`, // not published -> no host port
  );
  eq([...holders.keys()].sort(), ["3"]);
  eq(holders.get("3"), ["php-web", "php-queue"]);
});
Deno.test("foreignSlotHolders expands a published port range across bands", () => {
  const holders = foreignSlotHolders(`gw\t0.0.0.0:54338-54352->80-94/tcp\t\n`);
  eq([...holders.keys()].sort(), ["3", "4", "5"]);
  eq(foreignSlotHolders(`gw\t0.0.0.0:1-65535->1-65535/tcp\t\n`).size, 10);
  eq(foreignSlotHolders(`gw\t0.0.0.0:54400-54500->80/tcp\t\n`).size, 0); // outside 543XX
});

// ---------- resource limits ---------------------------------------------------
Deno.test("parseLimits reads per-service memory/cpus, skips malformed", () => {
  const l = parseLimits(
    `# limits\ndefault.memory = 256m\ndb.memory = 1g\ndb.cpus = 2\n` +
      `analytics.memory = 512m\nbad.memory = notsize\nweird = x\n`,
  );
  eq(l.default, { memory: "256m" });
  eq(l.db, { memory: "1g", cpus: "2" });
  eq(l.analytics, { memory: "512m" });
  eq("bad" in l, false); // malformed memory value rejected
  eq("weird" in l, false); // no .memory/.cpus resource
});
Deno.test("parseLimits returns empty for blank/comment input", () => {
  eq(parseLimits("\n# nope\n"), {});
});
