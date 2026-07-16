#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-run
// Copyright 2026 conanhazelnut — SPDX-License-Identifier: Apache-2.0
// Build native `supa` binaries from main.ts into ./dist (gitignored).
//
//   deno task build              build for this host + Windows x64 (quick local dev)
//   deno run -A build.ts host    build only for this host
//   deno run -A build.ts windows build only the Windows .exe
//   deno run -A build.ts release build ALL release targets as dist/supa-<target>[.exe]
//
// A Deno script (not bash) so the build runs identically on macOS, Linux, and
// Windows — no shell dependency. `deno compile` bundles the Deno runtime and
// cross-compiles every target from any host, so the person running the binary
// needs nothing installed (Docker + the Supabase CLI aside). Release artifacts
// are normally built by CI on a version tag (see .github/workflows/release.yml)
// and attached to a GitHub Release; the install scripts download those.
// `deno run -A build.ts release` is the manual equivalent. The first build of
// each target downloads its runtime once.

const PERMS = ["--allow-read", "--allow-write", "--allow-env", "--allow-run"];

// Release targets — deno compile cross-compiles all of these from any OS.
const TARGETS = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
  "x86_64-pc-windows-msvc",
];

async function compile(output: string, target?: string): Promise<void> {
  const args = ["compile", ...PERMS];
  if (target) args.push("--target", target);
  args.push("--output", output, "main.ts");
  const { code } = await new Deno.Command(Deno.execPath(), {
    args,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (code !== 0) {
    console.error(`build: deno compile failed (exit ${code})`);
    Deno.exit(code);
  }
}

async function sha256Hex(path: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await Deno.readFile(path));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function buildHost(): Promise<void> {
  // On a Windows host `deno compile` appends .exe to the output itself.
  console.log(`▶ host (${Deno.build.os} ${Deno.build.arch}) → dist/supa`);
  await compile("dist/supa");
}
async function buildWindows(): Promise<void> {
  console.log("▶ windows (x86_64) → dist/supa.exe");
  await compile("dist/supa.exe", "x86_64-pc-windows-msvc");
}
async function buildRelease(): Promise<void> {
  for (const t of TARGETS) {
    const out = `dist/supa-${t}${t.includes("windows") ? ".exe" : ""}`;
    console.log(`▶ ${t} → ${out}`);
    await compile(out, t);
  }
  // sha256sum-compatible lines ("<hash>  <file>") — install.sh/install.ps1 parse this.
  console.log("▶ checksums → dist/SHA256SUMS.txt");
  const names = [...Deno.readDirSync("dist")]
    .filter((e) => e.isFile && e.name.startsWith("supa-"))
    .map((e) => e.name)
    .sort();
  const lines = await Promise.all(names.map(async (n) => `${await sha256Hex(`dist/${n}`)}  ${n}`));
  Deno.writeTextFileSync("dist/SHA256SUMS.txt", lines.join("\n") + "\n");
}

async function main(): Promise<void> {
  Deno.chdir(new URL(".", import.meta.url)); // run from the repo root, like cd "$(dirname $0)"
  Deno.mkdirSync("dist", { recursive: true });
  const want = Deno.args[0] ?? "all";
  switch (want) {
    case "host":
      await buildHost();
      break;
    case "windows":
      await buildWindows();
      break;
    case "all":
      await buildHost();
      // On a Windows host the host build IS dist/supa.exe — don't build it twice.
      if (Deno.build.os !== "windows") await buildWindows();
      break;
    case "release":
      await buildRelease();
      break;
    default:
      console.error("usage: deno run -A build.ts [host|windows|all|release]");
      Deno.exit(1);
  }
  console.log("✓ done:");
  for (const e of [...Deno.readDirSync("dist")].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!e.isFile) continue;
    const mib = Deno.statSync(`dist/${e.name}`).size / (1024 * 1024);
    console.log(`  dist/${e.name}  ${mib >= 1 ? `${mib.toFixed(1)} MiB` : "<1 MiB"}`);
  }
}

if (import.meta.main) await main();
