#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-run --allow-net=api.github.com,github.com,objects.githubusercontent.com,release-assets.githubusercontent.com
// Copyright 2026 conanhazelnut — SPDX-License-Identifier: Apache-2.0
/**
 * supa — cross-platform manager for local Supabase stacks (one per project).
 *
 * Thin entry point: parse the verb and dispatch. Compiled to native binaries
 * with `deno compile` (see build.ts) — `supa` (macOS/Linux) and `supa.exe`
 * (Windows). The person running it needs nothing installed beyond Docker and the
 * Supabase CLI, because supa is a coordinator, not a container runtime.
 *
 * Implementation is split under src/: util → parse → config → supabase → commands.
 * Full guide: docs/SUPA.md
 */
import { die, VERSION } from "./src/util.ts";
import {
  cmdAdd,
  cmdBackup,
  cmdCompletion,
  cmdConfig,
  cmdDestroy,
  cmdDoctor,
  cmdDown,
  cmdEnv,
  cmdHelp,
  cmdLimit,
  cmdLogs,
  cmdLs,
  cmdNames,
  cmdPark,
  cmdPorts,
  cmdPrune,
  cmdRestart,
  cmdRestore,
  cmdRm,
  cmdRotate,
  cmdSelfUpdate,
  cmdStats,
  cmdStatus,
  cmdSwitch,
  cmdUnpark,
  cmdUp,
  cmdUpgrade,
} from "./src/commands.ts";

async function main(): Promise<void> {
  const [cmd = "help", ...rest] = Deno.args;
  // `supa <cmd> --help` → that command's detailed help (same as `supa help <cmd>`).
  if (cmd !== "help" && (rest.includes("--help") || rest.includes("-h"))) {
    cmdHelp([cmd]);
    return;
  }
  switch (cmd) {
    case "ls":
    case "list":
      await cmdLs(rest);
      break;
    case "up":
    case "start":
      await cmdUp(rest);
      break;
    case "down":
    case "stop":
      await cmdDown(rest);
      break;
    case "restart":
      await cmdRestart(rest);
      break;
    case "switch":
    case "only":
      await cmdSwitch(rest);
      break;
    case "destroy":
      await cmdDestroy(rest);
      break;
    case "rotate":
      await cmdRotate(rest);
      break;
    case "backup":
      await cmdBackup(rest);
      break;
    case "restore":
      await cmdRestore(rest);
      break;
    case "pg-upgrade":
      await cmdUpgrade(rest);
      break;
    case "upgrade":
    case "self-update":
      await cmdSelfUpdate(rest);
      break;
    case "status":
    case "ps":
      await cmdStatus(rest);
      break;
    case "stats":
      await cmdStats();
      break;
    case "limit":
      await cmdLimit(rest);
      break;
    case "logs":
      await cmdLogs(rest);
      break;
    case "env":
      await cmdEnv(rest);
      break;
    case "add":
      await cmdAdd(rest);
      break;
    case "rm":
    case "remove":
      cmdRm(rest);
      break;
    case "park":
      cmdPark(rest);
      break;
    case "unpark":
      cmdUnpark(rest);
      break;
    case "ports":
      await cmdPorts(rest);
      break;
    case "completion":
      cmdCompletion(rest);
      break;
    case "__names": // hidden: completion helper
      cmdNames();
      break;
    case "doctor":
      await cmdDoctor();
      break;
    case "prune":
      await cmdPrune(rest);
      break;
    case "config":
      cmdConfig(rest);
      break;
    case "version":
    case "--version":
    case "-V":
      console.log(`supa ${VERSION}`);
      break;
    case "help":
    case "-h":
    case "--help":
      cmdHelp(rest);
      break;
    default:
      die(`unknown command '${cmd}' (try: supa help)`);
  }
}

if (import.meta.main) await main();
