#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-run
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
import { die } from "./src/util.ts";
import {
  cmdAdd,
  cmdBackup,
  cmdConfig,
  cmdDestroy,
  cmdDoctor,
  cmdDown,
  cmdEnv,
  cmdHelp,
  cmdLimit,
  cmdLogs,
  cmdLs,
  cmdPorts,
  cmdPrune,
  cmdRestart,
  cmdRestore,
  cmdRm,
  cmdRotate,
  cmdStats,
  cmdStatus,
  cmdSwitch,
  cmdUp,
  cmdUpgrade,
} from "./src/commands.ts";

const VERSION = "0.1.0"; // keep in sync with deno.json + CHANGELOG

async function main(): Promise<void> {
  const [cmd = "help", ...rest] = Deno.args;
  switch (cmd) {
    case "ls":
    case "list":
      await cmdLs();
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
    case "upgrade":
      await cmdUpgrade(rest);
      break;
    case "status":
    case "ps":
      await cmdStatus();
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
    case "ports":
      cmdPorts(rest);
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
      cmdHelp();
      break;
    default:
      die(`unknown command '${cmd}' (try: supa help)`);
  }
}

if (import.meta.main) await main();
