// End-to-end CLI tests: spawn `main.ts` as a subprocess against a throwaway
// SUPA_HOME so nothing touches real config. No Docker needed — the commands
// exercised here (version/help/config/add/rm/ls) degrade gracefully without it.
// Run: deno test -A

import { fromFileUrl } from "@std/path";

const MAIN = fromFileUrl(new URL("main.ts", import.meta.url));

function ok(cond: boolean, msg = "expected true"): void {
  if (!cond) throw new Error(msg);
}

async function runSupa(
  args: string[],
  home: string,
  opts: { cwd?: string } = {},
): Promise<{ code: number; out: string; err: string }> {
  // clearEnv so NO inherited SUPA_* (max-active, allow-multi, ram-budget, …) from
  // the developer's shell can leak in; keep only PATH (for the child's own
  // docker/supabase lookups) and the pinned config vars.
  const env: Record<string, string> = {
    PATH: Deno.env.get("PATH") ?? "",
    SUPA_HOME: home,
    SUPA_REGISTRY: `${home}/supa.registry`,
    SUPA_CONFIG: `${home}/supa.config`,
  };
  if (Deno.build.os === "windows") {
    for (const k of ["SystemRoot", "USERPROFILE", "TEMP"]) {
      const v = Deno.env.get(k);
      if (v) env[k] = v;
    }
  }
  const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--no-check", "-A", MAIN, ...args],
    clearEnv: true,
    env,
    cwd: opts.cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code,
    out: new TextDecoder().decode(stdout),
    err: new TextDecoder().decode(stderr),
  };
}

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await Deno.makeTempDir({ prefix: "supa-test-" });
  try {
    await fn(home);
  } finally {
    await Deno.remove(home, { recursive: true });
  }
}

Deno.test("version prints the version", async () => {
  await withHome(async (home) => {
    const r = await runSupa(["version"], home);
    ok(r.code === 0, `exit ${r.code}`);
    ok(/^supa \d+\.\d+\.\d+$/.test(r.out.trim()), `got: ${r.out.trim()}`);
    const short = await runSupa(["--version"], home);
    ok(short.out.trim() === r.out.trim(), "--version matches");
  });
});

Deno.test("help works and no-arg defaults to help", async () => {
  await withHome(async (home) => {
    const h = await runSupa(["help"], home);
    ok(h.code === 0 && h.out.includes("supa —"), "help header");
    const none = await runSupa([], home);
    ok(none.out.includes("supa —"), "no-arg -> help");
  });
});

Deno.test("unknown command exits non-zero", async () => {
  await withHome(async (home) => {
    const r = await runSupa(["frobnicate"], home);
    ok(r.code === 1, `exit ${r.code}`);
    ok(r.err.includes("unknown command"), r.err);
  });
});

Deno.test("config max-active round-trips through supa.config", async () => {
  await withHome(async (home) => {
    await Deno.writeTextFile(`${home}/supa.registry`, "web|/tmp/web\n");
    const set = await runSupa(["config", "max-active", "3"], home);
    ok(set.code === 0, set.err);
    const show = await runSupa(["config"], home);
    ok(/max_active:\s*3/.test(show.out), show.out);
    const bad = await runSupa(["config", "max-active", "0"], home);
    ok(bad.code === 1, "0 is rejected");
  });
});

Deno.test("add then rm round-trips the registry", async () => {
  await withHome(async (home) => {
    await Deno.writeTextFile(`${home}/supa.registry`, "");
    const add = await runSupa(["add", "myapp", "/tmp/myapp"], home);
    ok(add.code === 0, add.err);
    ok((await Deno.readTextFile(`${home}/supa.registry`)).includes("myapp|/tmp/myapp"));
    const dup = await runSupa(["add", "myapp", "/tmp/x"], home);
    ok(dup.code === 1, "duplicate rejected");
    const rm = await runSupa(["rm", "myapp"], home);
    ok(rm.code === 0, rm.err);
    ok(!(await Deno.readTextFile(`${home}/supa.registry`)).includes("myapp|"));
  });
});

Deno.test("add bootstraps a missing registry (first-run, no install seed)", async () => {
  await withHome(async (home) => {
    // No registry file — install.sh curl may have failed; add must still work.
    ok(!(await Deno.stat(`${home}/supa.registry`).then(() => true).catch(() => false)));
    const add = await runSupa(["add", "fresh", "/tmp/fresh"], home);
    ok(add.code === 0, add.err);
    const reg = await Deno.readTextFile(`${home}/supa.registry`);
    ok(reg.includes("fresh|/tmp/fresh"), reg);
  });
});

Deno.test("backup rejects a missing --out value and unknown flags", async () => {
  await withHome(async (home) => {
    await Deno.writeTextFile(`${home}/supa.registry`, "web|/tmp/web\n");
    const missing = await runSupa(["backup", "web", "--out"], home);
    ok(missing.code === 1, missing.err);
    ok(/usage:/.test(missing.err), missing.err);
    const swallowed = await runSupa(["backup", "web", "--out", "--data-only"], home);
    ok(swallowed.code === 1, swallowed.err);
    const typo = await runSupa(["backup", "web", "--data"], home);
    ok(typo.code === 1, typo.err);
    ok(/unknown flag/.test(typo.err), typo.err);
  });
});

Deno.test("pg-upgrade and restore reject unknown flags", async () => {
  await withHome(async (home) => {
    const proj = await Deno.makeTempDir({ prefix: "supa-flag-" });
    try {
      await Deno.mkdir(`${proj}/supabase`, { recursive: true });
      await Deno.writeTextFile(
        `${proj}/supabase/config.toml`,
        `project_id = "demo"\n[db]\nmajor_version = 15\nport = 54322\n`,
      );
      await Deno.writeTextFile(`${home}/supa.registry`, `demo|${proj}\n`);
      // A --dry-run typo must not be swallowed (with --yes it would be live fire).
      const dryTypo = await runSupa(
        ["pg-upgrade", "demo", "--to", "17", "--yes", "--dry-ru"],
        home,
      );
      ok(dryTypo.code === 1, dryTypo.err);
      ok(/unknown flag/.test(dryTypo.err), dryTypo.err);
      const restoreTypo = await runSupa(["restore", "demo", "--latets"], home);
      ok(restoreTypo.code === 1, restoreTypo.err);
      ok(/unknown flag/.test(restoreTypo.err), restoreTypo.err);
    } finally {
      await Deno.remove(proj, { recursive: true });
    }
  });
});

Deno.test("doctor warns on relative registry paths and multi config.toml candidates", async () => {
  await withHome(async (home) => {
    const root = await Deno.makeTempDir({ prefix: "supa-mono-" });
    try {
      await Deno.mkdir(`${root}/apps/aaa/supabase`, { recursive: true });
      await Deno.mkdir(`${root}/apps/zzz/supabase`, { recursive: true });
      await Deno.writeTextFile(`${root}/apps/aaa/supabase/config.toml`, `project_id = "aaa"\n`);
      await Deno.writeTextFile(`${root}/apps/zzz/supabase/config.toml`, `project_id = "zzz"\n`);
      // Relative path as stored — doctor should flag it (runtime still absolutizes).
      await Deno.writeTextFile(`${home}/supa.registry`, `mono|${root}\nrel|./somewhere\n`);
      // Rewrite mono as absolute is fine; force relative by writing a relative line only:
      await Deno.writeTextFile(`${home}/supa.registry`, `rel|./somewhere\nmono|${root}\n`);
      const r = await runSupa(["doctor"], home);
      ok(r.code === 0, r.err + r.out);
      ok(/registry paths absolute/.test(r.out) && /relative path/.test(r.out), r.out);
      ok(/2 config.toml candidates/.test(r.out), r.out);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});

Deno.test("ls derives label + ports from a project's config.toml", async () => {
  await withHome(async (home) => {
    const proj = await Deno.makeTempDir({ prefix: "supa-proj-" });
    try {
      await Deno.mkdir(`${proj}/supabase`, { recursive: true });
      await Deno.writeTextFile(
        `${proj}/supabase/config.toml`,
        `project_id = "demo"\n[api]\nport = 54391\n[db]\nport = 54392\n[studio]\nport = 54393\n`,
      );
      await Deno.writeTextFile(`${home}/supa.registry`, `demo|${proj}\n`);
      const r = await runSupa(["ls"], home);
      ok(r.code === 0, r.err);
      ok(/demo\s+demo\s+54391\s+54392\s+54393/.test(r.out), r.out);
    } finally {
      await Deno.remove(proj, { recursive: true });
    }
  });
});

Deno.test("ls reads a UTF-16LE registry (Windows PowerShell 5.1 Out-File default)", async () => {
  await withHome(async (home) => {
    const proj = await Deno.makeTempDir({ prefix: "supa-proj-" });
    try {
      await Deno.mkdir(`${proj}/supabase`, { recursive: true });
      await Deno.writeTextFile(
        `${proj}/supabase/config.toml`,
        `project_id = "demo"\n[api]\nport = 54391\n`,
      );
      const line = `demo|${proj}\r\n`;
      const bytes = new Uint8Array(2 + line.length * 2);
      bytes[0] = 0xff;
      bytes[1] = 0xfe; // UTF-16LE BOM
      for (let i = 0; i < line.length; i++) {
        const c = line.charCodeAt(i);
        bytes[2 + i * 2] = c & 0xff;
        bytes[3 + i * 2] = c >> 8;
      }
      await Deno.writeFile(`${home}/supa.registry`, bytes);
      const r = await runSupa(["ls"], home);
      ok(r.code === 0, r.err);
      ok(/demo\s+demo\s+54391/.test(r.out), r.out);
    } finally {
      await Deno.remove(proj, { recursive: true });
    }
  });
});

Deno.test("config backup-dir round-trips through supa.config", async () => {
  await withHome(async (home) => {
    await Deno.writeTextFile(`${home}/supa.registry`, "web|/tmp/web\n");
    const set = await runSupa(["config", "backup-dir", "/tmp/dumps"], home);
    ok(set.code === 0, set.err);
    const show = await runSupa(["config"], home);
    ok(/backup_dir:\s*\/tmp\/dumps/.test(show.out), show.out);
  });
});

Deno.test("config backup-dir stores a relative path as absolute", async () => {
  await withHome(async (home) => {
    await Deno.writeTextFile(`${home}/supa.registry`, "web|/tmp/web\n");
    const parent = await Deno.makeTempDir({ prefix: "supa-bd-" });
    try {
      const set = await runSupa(["config", "backup-dir", "dumps"], home, { cwd: parent });
      ok(set.code === 0, set.err);
      const cfg = await Deno.readTextFile(`${home}/supa.config`);
      const m = cfg.match(/backup_dir\s*=\s*(.+)/);
      ok(!!m, cfg);
      const stored = m![1].trim();
      ok(stored !== "dumps", `must not stay relative: ${stored}`);
      ok(stored.includes("dumps"), stored);
    } finally {
      await Deno.remove(parent, { recursive: true });
    }
  });
});

Deno.test("backup on a down stack exits with a start-it-first hint", async () => {
  await withHome(async (home) => {
    const proj = await Deno.makeTempDir({ prefix: "supa-proj-" });
    try {
      await Deno.mkdir(`${proj}/supabase`, { recursive: true });
      // A label no container will ever carry → runningLabels() can't include it,
      // so the guard fires regardless of whether docker is running here.
      await Deno.writeTextFile(
        `${proj}/supabase/config.toml`,
        `project_id = "supa-test-absent"\n[api]\nport = 54391\n[db]\nport = 54392\n`,
      );
      await Deno.writeTextFile(`${home}/supa.registry`, `demo|${proj}\n`);
      const r = await runSupa(["backup", "demo"], home);
      ok(r.code === 1, `expected exit 1, got ${r.code}`);
      ok(/isn't running/.test(r.err), r.err);
    } finally {
      await Deno.remove(proj, { recursive: true });
    }
  });
});

Deno.test("restore with a missing file exits before touching docker", async () => {
  await withHome(async (home) => {
    const proj = await Deno.makeTempDir({ prefix: "supa-proj-" });
    try {
      await Deno.mkdir(`${proj}/supabase`, { recursive: true });
      await Deno.writeTextFile(
        `${proj}/supabase/config.toml`,
        `project_id = "supa-test-absent"\n[api]\nport = 54391\n[db]\nport = 54392\n`,
      );
      await Deno.writeTextFile(`${home}/supa.registry`, `demo|${proj}\n`);
      const r = await runSupa(["restore", "demo", `${proj}/nope.sql`], home);
      ok(r.code === 1, `expected exit 1, got ${r.code}`);
      ok(/backup file not found/.test(r.err), r.err);
    } finally {
      await Deno.remove(proj, { recursive: true });
    }
  });
});

Deno.test("upgrade --dry-run prints the plan and changes nothing", async () => {
  await withHome(async (home) => {
    const proj = await Deno.makeTempDir({ prefix: "supa-proj-" });
    try {
      await Deno.mkdir(`${proj}/supabase`, { recursive: true });
      await Deno.writeTextFile(
        `${proj}/supabase/config.toml`,
        `project_id = "demo"\n[db]\nport = 54392\nmajor_version = 15\n`,
      );
      await Deno.writeTextFile(`${home}/supa.registry`, `demo|${proj}\n`);
      const r = await runSupa(["pg-upgrade", "demo", "--to", "17", "--dry-run"], home);
      ok(r.code === 0, r.err);
      ok(/Postgres 15 → 17/.test(r.out), r.out);
      ok(/dry run/.test(r.out), r.out);
      const cfg = await Deno.readTextFile(`${proj}/supabase/config.toml`);
      ok(cfg.includes("major_version = 15"), "config must be unchanged in a dry run");
    } finally {
      await Deno.remove(proj, { recursive: true });
    }
  });
});

Deno.test("park discovers supabase subdirs; unpark removes them", async () => {
  await withHome(async (home) => {
    const base = await Deno.makeTempDir({ prefix: "supa-park-" });
    try {
      await Deno.mkdir(`${base}/withdb/supabase`, { recursive: true });
      await Deno.writeTextFile(
        `${base}/withdb/supabase/config.toml`,
        `project_id = "withdb"\n[api]\nport = 54351\n`,
      );
      await Deno.mkdir(`${base}/plain`, { recursive: true }); // no supabase — ignored
      await Deno.writeTextFile(`${home}/supa.registry`, "");
      const park = await runSupa(["park", base], home);
      ok(park.code === 0, park.err);
      ok(/discovered: withdb/.test(park.out), park.out);
      const ls = await runSupa(["ls"], home);
      ok(/withdb/.test(ls.out), ls.out);
      ok(!/plain/.test(ls.out), "non-supabase subdir must not appear");
      // rm must not lie about park-discovered names
      const rmPark = await runSupa(["rm", "withdb"], home);
      ok(rmPark.code === 1, rmPark.err);
      ok(/park-discovered/.test(rmPark.err), rmPark.err);
      const lsStill = await runSupa(["ls"], home);
      ok(/withdb/.test(lsStill.out), "failed rm must leave discovery intact");
      const unpark = await runSupa(["unpark", base], home);
      ok(unpark.code === 0, unpark.err);
      const ls2 = await runSupa(["ls"], home);
      ok(!/withdb/.test(ls2.out), "unpark removes discovered projects");
    } finally {
      await Deno.remove(base, { recursive: true });
    }
  });
});

Deno.test("park warns when a subdir name is shadowed by an existing entry", async () => {
  await withHome(async (home) => {
    const first = await Deno.makeTempDir({ prefix: "supa-park1-" });
    const second = await Deno.makeTempDir({ prefix: "supa-park2-" });
    try {
      for (const [base, label] of [[first, "one"], [second, "two"]] as const) {
        await Deno.mkdir(`${base}/web/supabase`, { recursive: true });
        await Deno.writeTextFile(
          `${base}/web/supabase/config.toml`,
          `project_id = "${label}"\n[api]\nport = 54351\n`,
        );
      }
      await Deno.writeTextFile(`${home}/supa.registry`, "");
      ok((await runSupa(["park", first], home)).code === 0);
      const park2 = await runSupa(["park", second], home);
      ok(park2.code === 0, park2.err);
      ok(/shadowed.*\bweb\b/.test(park2.err), park2.err);
      ok(!/discovered:.*\bweb\b/.test(park2.out), park2.out);
      const ls = await runSupa(["ls", "--json"], home);
      const rows = JSON.parse(ls.out) as Array<{ name: string; label: string }>;
      const web = rows.find((r) => r.name === "web");
      ok(web?.label === "one", "first park keeps the name");
    } finally {
      await Deno.remove(first, { recursive: true });
      await Deno.remove(second, { recursive: true });
    }
  });
});

Deno.test("unpark removes a park line with spacing around the pipe", async () => {
  await withHome(async (home) => {
    const base = await Deno.makeTempDir({ prefix: "supa-park-" });
    try {
      await Deno.mkdir(`${base}/withdb/supabase`, { recursive: true });
      await Deno.writeTextFile(
        `${base}/withdb/supabase/config.toml`,
        `project_id = "withdb"\n[api]\nport = 54351\n`,
      );
      // Hand-edited spacing — parseRegistry accepts it; unpark must too.
      await Deno.writeTextFile(`${home}/supa.registry`, `* | ${base}\n`);
      const ls = await runSupa(["ls"], home);
      ok(/withdb/.test(ls.out), ls.out);
      const unpark = await runSupa(["unpark", base], home);
      ok(unpark.code === 0, unpark.err);
      ok(!(await Deno.readTextFile(`${home}/supa.registry`)).includes(base));
      const ls2 = await runSupa(["ls"], home);
      ok(!/withdb/.test(ls2.out), ls2.out);
    } finally {
      await Deno.remove(base, { recursive: true });
    }
  });
});

Deno.test("rm of an explicit override warns when a parked dir still exposes the name", async () => {
  await withHome(async (home) => {
    const base = await Deno.makeTempDir({ prefix: "supa-park-" });
    const other = await Deno.makeTempDir({ prefix: "supa-other-" });
    try {
      await Deno.mkdir(`${base}/web/supabase`, { recursive: true });
      await Deno.writeTextFile(
        `${base}/web/supabase/config.toml`,
        `project_id = "web"\n[api]\nport = 54351\n`,
      );
      await Deno.mkdir(`${other}/supabase`, { recursive: true });
      await Deno.writeTextFile(
        `${other}/supabase/config.toml`,
        `project_id = "web"\n[api]\nport = 54361\n`,
      );
      await Deno.writeTextFile(
        `${home}/supa.registry`,
        `*|${base}\nweb|${other}\n`,
      );
      const rm = await runSupa(["rm", "web"], home);
      ok(rm.code === 0, rm.err);
      ok(/parked dir still exposes/.test(rm.err), rm.err);
      ok(!(await Deno.readTextFile(`${home}/supa.registry`)).includes(`web|${other}`));
      const ls = await runSupa(["ls"], home);
      ok(/web/.test(ls.out), "park discovery resurfaces after override rm");
    } finally {
      await Deno.remove(base, { recursive: true });
      await Deno.remove(other, { recursive: true });
    }
  });
});

Deno.test("add can override a park-discovered name (explicit wins)", async () => {
  await withHome(async (home) => {
    const base = await Deno.makeTempDir({ prefix: "supa-park-" });
    const other = await Deno.makeTempDir({ prefix: "supa-other-" });
    try {
      await Deno.mkdir(`${base}/web/supabase`, { recursive: true });
      await Deno.writeTextFile(
        `${base}/web/supabase/config.toml`,
        `project_id = "parked"\n[api]\nport = 54351\n`,
      );
      await Deno.mkdir(`${other}/supabase`, { recursive: true });
      await Deno.writeTextFile(
        `${other}/supabase/config.toml`,
        `project_id = "explicit"\n[api]\nport = 54361\n`,
      );
      await Deno.writeTextFile(`${home}/supa.registry`, `*|${base}\n`);
      const add = await runSupa(["add", "web", other], home);
      ok(add.code === 0, add.err);
      ok(/overrides park-discovered/.test(add.out), add.out);
      const ls = await runSupa(["ls", "--json"], home);
      ok(ls.code === 0, ls.err);
      const rows = JSON.parse(ls.out) as Array<{ name: string; root: string; label: string }>;
      const web = rows.find((r) => r.name === "web");
      ok(web !== undefined && web.root === other, JSON.stringify(web));
      ok(web?.label === "explicit", JSON.stringify(web));
    } finally {
      await Deno.remove(base, { recursive: true });
      await Deno.remove(other, { recursive: true });
    }
  });
});

Deno.test("ls --json emits the stable machine schema", async () => {
  await withHome(async (home) => {
    const proj = await Deno.makeTempDir({ prefix: "supa-proj-" });
    try {
      await Deno.mkdir(`${proj}/supabase`, { recursive: true });
      await Deno.writeTextFile(
        `${proj}/supabase/config.toml`,
        `project_id = "demo"\n[api]\nport = 54391\n[db]\nport = 54392\n`,
      );
      await Deno.writeTextFile(`${home}/supa.registry`, `demo|${proj}\n`);
      const r = await runSupa(["ls", "--json"], home);
      ok(r.code === 0, r.err);
      const arr = JSON.parse(r.out);
      ok(Array.isArray(arr) && arr.length === 1, r.out);
      ok(arr[0].name === "demo" && arr[0].label === "demo", r.out);
      ok(arr[0].api === "54391" && arr[0].db === "54392", r.out);
      ok(arr[0].status === "down" || arr[0].status === "up", r.out);
    } finally {
      await Deno.remove(proj, { recursive: true });
    }
  });
});

Deno.test("self-update refuses under deno run before touching the network", async () => {
  await withHome(async (home) => {
    const r = await runSupa(["upgrade"], home);
    ok(r.code === 1, `expected exit 1, got ${r.code}`);
    ok(/compiled binary/.test(r.err), r.err);
  });
});

Deno.test("completion prints a script; help <cmd> prints topic help", async () => {
  await withHome(async (home) => {
    const bash = await runSupa(["completion", "bash"], home);
    ok(bash.code === 0 && bash.out.includes("complete -F _supa supa"), bash.out);
    const pwsh = await runSupa(["completion", "pwsh"], home);
    ok(pwsh.code === 0 && pwsh.out.includes("Register-ArgumentCompleter"), pwsh.out);
    const topic = await runSupa(["help", "restore"], home);
    ok(topic.code === 0 && topic.out.includes("single transaction"), topic.out);
    ok(/prefers the newest full dump/.test(topic.out), topic.out);
    const viaFlag = await runSupa(["restore", "--help"], home);
    ok(viaFlag.out.trim() === topic.out.trim(), "cmd --help matches help cmd");
  });
});

// TEETH: prune's help is the user-facing scope contract — supa must never offer to
// remove another project's images or any volume. REVERT the scoping in cmdPrune and
// the help text stops matching → RED.
Deno.test("prune help states the Supabase-only scope", async () => {
  await withHome(async (home) => {
    const h = await runSupa(["help", "prune"], home);
    ok(h.code === 0, h.err);
    ok(/Supabase images only/.test(h.out), h.out);
    ok(/reported, never\s+touched/.test(h.out), h.out);
    ok(/Volumes are reported only/.test(h.out), h.out);
  });
});

Deno.test("upgrade to a lower version is blocked unless --allow-downgrade", async () => {
  await withHome(async (home) => {
    const proj = await Deno.makeTempDir({ prefix: "supa-proj-" });
    try {
      await Deno.mkdir(`${proj}/supabase`, { recursive: true });
      await Deno.writeTextFile(
        `${proj}/supabase/config.toml`,
        `project_id = "demo"\n[db]\nport = 54392\nmajor_version = 17\n`,
      );
      await Deno.writeTextFile(`${home}/supa.registry`, `demo|${proj}\n`);
      const blocked = await runSupa(["pg-upgrade", "demo", "--to", "15", "--dry-run"], home);
      ok(blocked.code === 1, `expected exit 1, got ${blocked.code}`);
      ok(/downgrade/.test(blocked.err), blocked.err);
      const allowed = await runSupa(
        ["pg-upgrade", "demo", "--to", "15", "--allow-downgrade", "--dry-run"],
        home,
      );
      ok(allowed.code === 0, allowed.err);
      ok(/Postgres 17 → 15/.test(allowed.out), allowed.out);
    } finally {
      await Deno.remove(proj, { recursive: true });
    }
  });
});

Deno.test("ports refuses a slot used by another project unless --force", async () => {
  await withHome(async (home) => {
    const a = await Deno.makeTempDir({ prefix: "supa-a-" });
    const b = await Deno.makeTempDir({ prefix: "supa-b-" });
    try {
      for (const [dir, id, api] of [[a, "aaa", 54331], [b, "bbb", 54351]] as const) {
        await Deno.mkdir(`${dir}/supabase`, { recursive: true });
        await Deno.writeTextFile(
          `${dir}/supabase/config.toml`,
          `project_id = "${id}"\n[api]\nport = ${api}\n[db]\nport = ${api + 1}\n`,
        );
      }
      await Deno.writeTextFile(`${home}/supa.registry`, `aaa|${a}\nbbb|${b}\n`);
      // bbb → slot 3 collides with aaa (54331)
      const blocked = await runSupa(["ports", "bbb", "3"], home);
      ok(blocked.code === 1, `expected exit 1, got ${blocked.code}`);
      ok(/already used by aaa/.test(blocked.err), blocked.err);
      // --force overrides
      const forced = await runSupa(["ports", "bbb", "3", "--force"], home);
      ok(forced.code === 0, forced.err);
      ok(
        (await Deno.readTextFile(`${b}/supabase/config.toml`)).includes("54331"),
        "bbb should be re-banded onto 5433X",
      );
    } finally {
      await Deno.remove(a, { recursive: true });
      await Deno.remove(b, { recursive: true });
    }
  });
});

// Auto-pick must not count the target's own slot as taken — otherwise slots
// 1–8 occupied + web on 9 false-refuses `supa ports web`.
Deno.test("ports auto-pick keeps the project's own free slot", async () => {
  await withHome(async (home) => {
    const dirs: string[] = [];
    try {
      const lines: string[] = [];
      for (let d = 1; d <= 9; d++) {
        const dir = await Deno.makeTempDir({ prefix: `supa-s${d}-` });
        dirs.push(dir);
        await Deno.mkdir(`${dir}/supabase`, { recursive: true });
        const api = 54300 + d * 10 + 1; // 54311 … 54391
        await Deno.writeTextFile(
          `${dir}/supabase/config.toml`,
          `project_id = "p${d}"\n[api]\nport = ${api}\n[db]\nport = ${api + 1}\n`,
        );
        lines.push(`p${d}|${dir}`);
      }
      await Deno.writeTextFile(`${home}/supa.registry`, lines.join("\n") + "\n");
      const r = await runSupa(["ports", "p9"], home);
      ok(r.code === 0, r.err);
      ok(
        (await Deno.readTextFile(`${dirs[8]}/supabase/config.toml`)).includes("54391"),
        "p9 must keep slot 9",
      );
    } finally {
      for (const d of dirs) await Deno.remove(d, { recursive: true });
    }
  });
});

Deno.test("add --init refuses a colliding --slot like ports", async () => {
  await withHome(async (home) => {
    const a = await Deno.makeTempDir({ prefix: "supa-a-" });
    const b = await Deno.makeTempDir({ prefix: "supa-b-" });
    try {
      await Deno.mkdir(`${a}/supabase`, { recursive: true });
      await Deno.writeTextFile(
        `${a}/supabase/config.toml`,
        `project_id = "aaa"\n[api]\nport = 54331\n[db]\nport = 54332\n`,
      );
      // Pre-seed config so --init skips `supabase init` (not needed for this check).
      await Deno.mkdir(`${b}/supabase`, { recursive: true });
      await Deno.writeTextFile(
        `${b}/supabase/config.toml`,
        `project_id = "bbb"\n[api]\nport = 54351\n[db]\nport = 54352\n`,
      );
      await Deno.writeTextFile(`${home}/supa.registry`, `aaa|${a}\n`);
      const r = await runSupa(["add", "bbb", b, "--init", "--slot", "3"], home);
      ok(r.code === 1, `expected exit 1, got ${r.code}`);
      ok(/already used by aaa/.test(r.err), r.err);
      ok(!/--force/.test(r.err), "add has no --force — must not advertise it");
      ok(/pick another --slot|omit --slot/.test(r.err), r.err);
      // Slot checks run before the registry write — no half-applied entry.
      ok(
        !(await Deno.readTextFile(`${home}/supa.registry`)).includes(`bbb|`),
        "failed add --init must not leave a registry row",
      );
    } finally {
      await Deno.remove(a, { recursive: true });
      await Deno.remove(b, { recursive: true });
    }
  });
});

// Nested apps/*/config counts — --init must not scaffold a root that shadows it.
Deno.test("add --init skips init when a nested monorepo config already exists", async () => {
  await withHome(async (home) => {
    const root = await Deno.makeTempDir({ prefix: "supa-mono-" });
    try {
      await Deno.mkdir(`${root}/apps/web/supabase`, { recursive: true });
      await Deno.writeTextFile(
        `${root}/apps/web/supabase/config.toml`,
        `project_id = "web"\n[api]\nport = 54351\n[db]\nport = 54352\n`,
      );
      await Deno.writeTextFile(`${home}/supa.registry`, "");
      const r = await runSupa(["add", "mono", root, "--init", "--slot", "4"], home);
      ok(r.code === 0, r.err);
      ok(/already exists — skipping/.test(r.err), r.err);
      ok(
        !(await Deno.stat(`${root}/supabase/config.toml`).then(() => true).catch(() => false)),
        "must not create a shadowing root config",
      );
      const nested = await Deno.readTextFile(`${root}/apps/web/supabase/config.toml`);
      ok(nested.includes("54341"), "re-band the nested config, not a new root");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});

// TEETH: down used to stop A then die on B mid-list. Preflight must reject the
// whole list first — REVERT → RED (error may still happen, but after a stop).
Deno.test("down refuses an unknown name before stopping any stack", async () => {
  await withHome(async (home) => {
    const proj = await Deno.makeTempDir({ prefix: "supa-proj-" });
    try {
      await Deno.mkdir(`${proj}/supabase`, { recursive: true });
      await Deno.writeTextFile(
        `${proj}/supabase/config.toml`,
        `project_id = "web"\n[api]\nport = 54321\n`,
      );
      await Deno.writeTextFile(`${home}/supa.registry`, `web|${proj}\n`);
      const r = await runSupa(["down", "web", "nope"], home);
      ok(r.code === 1, `expected exit 1, got ${r.code}`);
      ok(/unknown project 'nope'/.test(r.err), r.err);
    } finally {
      await Deno.remove(proj, { recursive: true });
    }
  });
});

// Registered without config.toml must fail the whole batch before any start —
// otherwise `up a b` starts a then dies on b.
Deno.test("up refuses a config-less project before starting any stack", async () => {
  await withHome(async (home) => {
    const a = await Deno.makeTempDir({ prefix: "supa-a-" });
    const b = await Deno.makeTempDir({ prefix: "supa-b-" });
    try {
      await Deno.mkdir(`${a}/supabase`, { recursive: true });
      await Deno.writeTextFile(
        `${a}/supabase/config.toml`,
        `project_id = "aaa"\n[api]\nport = 54331\n[db]\nport = 54332\n`,
      );
      // b is registered but has no supabase/config.toml
      await Deno.writeTextFile(`${home}/supa.registry`, `aaa|${a}\nbbb|${b}\n`);
      await Deno.writeTextFile(`${home}/supa.config`, "max_active = 2\n");
      const r = await runSupa(["up", "aaa", "bbb"], home);
      ok(r.code === 1, `expected exit 1, got ${r.code}`);
      ok(/no supabase\/config\.toml/.test(r.err), r.err);
      ok(!/starting aaa/.test(r.out), r.out);
    } finally {
      await Deno.remove(a, { recursive: true });
      await Deno.remove(b, { recursive: true });
    }
  });
});

// Config without project_id: switch must not tear down every running stack first.
Deno.test("switch refuses a missing project_id before stopping any stack", async () => {
  await withHome(async (home) => {
    const proj = await Deno.makeTempDir({ prefix: "supa-nolabel-" });
    try {
      await Deno.mkdir(`${proj}/supabase`, { recursive: true });
      await Deno.writeTextFile(
        `${proj}/supabase/config.toml`,
        `[api]\nport = 54331\n[db]\nport = 54332\n`,
      );
      await Deno.writeTextFile(`${home}/supa.registry`, `nolabel|${proj}\n`);
      const r = await runSupa(["switch", "nolabel"], home);
      ok(r.code === 1, `expected exit 1, got ${r.code}`);
      ok(/cannot resolve project_id/.test(r.err), r.err);
      ok(!/stopping /.test(r.out), r.out);
    } finally {
      await Deno.remove(proj, { recursive: true });
    }
  });
});

// TEETH: batch up must refuse before starting anyone when the list itself would
// exceed max-active (even with nothing currently running).
Deno.test("up refuses a batch that would exceed max-active before starting any", async () => {
  await withHome(async (home) => {
    const a = await Deno.makeTempDir({ prefix: "supa-a-" });
    const b = await Deno.makeTempDir({ prefix: "supa-b-" });
    try {
      for (const [dir, id, api] of [[a, "aaa", 54331], [b, "bbb", 54351]] as const) {
        await Deno.mkdir(`${dir}/supabase`, { recursive: true });
        await Deno.writeTextFile(
          `${dir}/supabase/config.toml`,
          `project_id = "${id}"\n[api]\nport = ${api}\n[db]\nport = ${api + 1}\n`,
        );
      }
      await Deno.writeTextFile(`${home}/supa.registry`, `aaa|${a}\nbbb|${b}\n`);
      await Deno.writeTextFile(`${home}/supa.config`, "max_active = 1\n");
      const r = await runSupa(["up", "aaa", "bbb"], home);
      ok(r.code === 1, `expected exit 1, got ${r.code}`);
      ok(/max-active limit reached/.test(r.err), r.err);
      // Hint must cover the whole batch (and any already-running stacks on the host).
      const m = r.err.match(/config max-active (\d+)/) ??
        r.err.match(/SUPA_MAX_ACTIVE=(\d+)/);
      ok(m !== null && Number(m[1]) >= 2, r.err);
    } finally {
      await Deno.remove(a, { recursive: true });
      await Deno.remove(b, { recursive: true });
    }
  });
});

Deno.test("restart refuses a batch that would exceed max-active before mutating any", async () => {
  await withHome(async (home) => {
    const a = await Deno.makeTempDir({ prefix: "supa-a-" });
    const b = await Deno.makeTempDir({ prefix: "supa-b-" });
    try {
      for (const [dir, id, api] of [[a, "aaa", 54331], [b, "bbb", 54351]] as const) {
        await Deno.mkdir(`${dir}/supabase`, { recursive: true });
        await Deno.writeTextFile(
          `${dir}/supabase/config.toml`,
          `project_id = "${id}"\n[api]\nport = ${api}\n[db]\nport = ${api + 1}\n`,
        );
      }
      await Deno.writeTextFile(`${home}/supa.registry`, `aaa|${a}\nbbb|${b}\n`);
      await Deno.writeTextFile(`${home}/supa.config`, "max_active = 1\n");
      const r = await runSupa(["restart", "aaa", "bbb"], home);
      ok(r.code === 1, `expected exit 1, got ${r.code}`);
      ok(/max-active limit reached/.test(r.err), r.err);
      ok(!/starting aaa/.test(r.out) && !/starting bbb/.test(r.out), r.out);
    } finally {
      await Deno.remove(a, { recursive: true });
      await Deno.remove(b, { recursive: true });
    }
  });
});

// Duplicate names in one invocation count once — otherwise max_active=1 falsely
// refuses `supa up aaa aaa` as if it needed two slots.
Deno.test("up dedupes duplicate names before max-active preflight", async () => {
  await withHome(async (home) => {
    const a = await Deno.makeTempDir({ prefix: "supa-a-" });
    try {
      await Deno.mkdir(`${a}/supabase`, { recursive: true });
      await Deno.writeTextFile(
        `${a}/supabase/config.toml`,
        `project_id = "aaa"\n[api]\nport = 54331\n[db]\nport = 54332\n`,
      );
      await Deno.writeTextFile(`${home}/supa.registry`, `aaa|${a}\n`);
      await Deno.writeTextFile(`${home}/supa.config`, "max_active = 1\n");
      const r = await runSupa(["up", "aaa", "aaa"], home);
      ok(!/max-active limit reached/.test(r.err), r.err);
    } finally {
      await Deno.remove(a, { recursive: true });
    }
  });
});

Deno.test("add stores a relative path as absolute in the registry", async () => {
  await withHome(async (home) => {
    const proj = await Deno.makeTempDir({ prefix: "supa-rel-" });
    const parent = proj.replace(/[/\\][^/\\]+$/, "");
    const base = proj.replace(/^.*[/\\]/, "");
    try {
      await Deno.writeTextFile(`${home}/supa.registry`, "");
      const add = await runSupa(["add", "relapp", base], home, { cwd: parent });
      ok(add.code === 0, add.err);
      const reg = await Deno.readTextFile(`${home}/supa.registry`);
      const line = reg.split(/\r?\n/).find((l) => l.startsWith("relapp|"));
      ok(!!line, reg);
      const stored = line!.slice("relapp|".length);
      ok(stored.includes(base), stored);
      ok(stored !== base, `must not stay relative: ${stored}`);
      ok(!stored.startsWith("."), stored);
    } finally {
      await Deno.remove(proj, { recursive: true });
    }
  });
});

Deno.test("doctor reports duplicate project_id labels", async () => {
  await withHome(async (home) => {
    const a = await Deno.makeTempDir({ prefix: "supa-a-" });
    const b = await Deno.makeTempDir({ prefix: "supa-b-" });
    try {
      for (const [dir, api] of [[a, 54331], [b, 54351]] as const) {
        await Deno.mkdir(`${dir}/supabase`, { recursive: true });
        await Deno.writeTextFile(
          `${dir}/supabase/config.toml`,
          `project_id = "same"\n[api]\nport = ${api}\n[db]\nport = ${api + 1}\n[studio]\nport = ${
            api + 2
          }\n`,
        );
      }
      await Deno.writeTextFile(`${home}/supa.registry`, `one|${a}\ntwo|${b}\n`);
      const r = await runSupa(["doctor"], home);
      ok(r.code === 0, r.err);
      ok(/duplicate project_id/.test(r.out) || /label 'same'/.test(r.out), r.out);
      ok(/one vs two|two vs one/.test(r.out), r.out);
    } finally {
      await Deno.remove(a, { recursive: true });
      await Deno.remove(b, { recursive: true });
    }
  });
});

// Corrupt .sql.gz + a child that exits 0 on empty stdin must not look like success.
Deno.test("runStdinFile fails closed on corrupt gzip (no false success)", async () => {
  const { runStdinFile } = await import("./src/supabase.ts");
  const dir = await Deno.makeTempDir({ prefix: "supa-gz-" });
  try {
    const bad = `${dir}/x.sql.gz`;
    await Deno.writeTextFile(bad, "this is not gzip");
    const code = await runStdinFile(Deno.execPath(), [
      "eval",
      "await new Response(Deno.stdin.readable).arrayBuffer()",
    ], bad);
    ok(code !== 0, `expected non-zero on corrupt gzip, got ${code}`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
