// End-to-end CLI tests: spawn `supa.ts` as a subprocess against a throwaway
// SUPA_HOME so nothing touches real config. No Docker needed — the commands
// exercised here (version/help/config/add/rm/ls) degrade gracefully without it.
// Run: deno test -A

function ok(cond: boolean, msg = "expected true"): void {
  if (!cond) throw new Error(msg);
}

async function runSupa(
  args: string[],
  home: string,
): Promise<{ code: number; out: string; err: string }> {
  const { code, stdout, stderr } = await new Deno.Command("deno", {
    args: ["run", "--no-check", "-A", "supa.ts", ...args],
    // Pin registry/config into the temp home so an inherited SUPA_* from the
    // developer's shell can't leak into the test.
    env: {
      SUPA_HOME: home,
      SUPA_REGISTRY: `${home}/supa.registry`,
      SUPA_CONFIG: `${home}/supa.config`,
    },
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
