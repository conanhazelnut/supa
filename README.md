# supa

[![ci](https://github.com/conanhazelnut/supa/actions/workflows/ci.yml/badge.svg)](https://github.com/conanhazelnut/supa/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/conanhazelnut/supa?sort=semver)](https://github.com/conanhazelnut/supa/releases)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)

A thin, cross-platform CLI for running **multiple local Supabase stacks — one per
project — on a single machine**, on top of the official
[Supabase CLI](https://supabase.com/docs/guides/local-development). No hand-rolled
Docker Compose: the CLI still owns every container; supa just decides _which_
stacks run (up to a limit you set) and reads each stack's live facts (Docker
label, host ports) straight from that project's `supabase/config.toml`.

TypeScript (a thin `main.ts` over `src/`) compiled with `deno compile` to native
binaries — `supa` (macOS/Linux) and `supa.exe` (Windows). Whoever runs it needs
nothing installed beyond **Docker** and the **Supabase CLI**.

## Why

Running several local Supabase projects means juggling ports, Docker labels, and
which stack is up. The Supabase CLI gives you the primitives (`--workdir`,
per-project `project_id`) but no manager on top. supa is that manager — and
deliberately a _thin_ one: it wraps the CLI instead of replacing it, and derives
everything it can from each project's `config.toml` so nothing drifts.

## Install

Downloads the prebuilt binary for your platform — no compiler, no Deno.

**macOS / Linux**

```sh
curl -fsSL https://raw.githubusercontent.com/conanhazelnut/supa/main/install.sh | sh
```

**Windows (PowerShell)**

```powershell
irm https://raw.githubusercontent.com/conanhazelnut/supa/main/install.ps1 | iex
```

The installer also seeds a starter registry. Point it at your projects, then go:

```sh
$EDITOR ~/.config/supa/supa.registry     # name|path per project (%APPDATA%\supa on Windows)
supa ls
```

### Build from source

For contributors, or platforms without a prebuilt binary. Needs
[Deno](https://deno.com); the built binary needs nothing.

```sh
git clone https://github.com/conanhazelnut/supa.git && cd supa
deno task build                            # → dist/supa (+ dist/supa.exe), any OS
ln -sf "$PWD/dist/supa" ~/.local/bin/supa  # put it on PATH (macOS/Linux)
```

Releases are built by CI on a version tag (`.github/workflows/release.yml`) and
attached to the [GitHub Release](https://github.com/conanhazelnut/supa/releases);
that's what the install scripts download.

## Quick start

New here? **[docs/QUICKSTART.md](./docs/QUICKSTART.md)** walks you from zero to
a running stack in ~10 minutes, with expected output at each step. The daily
essentials:

```sh
supa ls                     # projects, ports, what's UP
supa up web                 # start one (capped by max-active, default 1)
supa switch api             # stop others, run only this
supa down web               # stop it
supa config max-active 2    # allow two at once
supa stats                  # CPU/RAM per stack + total
supa add newapp ~/code/newapp --init   # register + scaffold + assign ports
```

## Commands

Run `supa help` for the full list.

| Group         | Commands                                                                 |
| ------------- | ------------------------------------------------------------------------ |
| **Lifecycle** | `up` · `down [--all]` · `restart` · `switch` · `destroy` · `rotate`      |
| **Data**      | `backup` · `restore` · `pg-upgrade`                                      |
| **Inspect**   | `ls` · `status` · `stats` · `logs` · `doctor` · `env [--write]`          |
| **Resources** | `limit` · `prune`                                                        |
| **Manage**    | `add [--init]` · `rm` · `park`/`unpark` · `ports` · `config` · `upgrade` |

`ls` / `status` / `config` take `--json` for scripting; `supa help <command>`
gives per-command details; `supa completion bash|zsh|pwsh` sets up tab-completion.

Destructive commands — `destroy` (deletes a stack's data) and `rotate`
(invalidates existing tokens) — require typing the project name to confirm.

## How it works

- The **registry** (`supa.registry`, `name|path` per line) is the only thing you
  maintain. Docker label + ports are derived from each project's
  `supabase/config.toml` every call.
- **Config** lives in `SUPA_HOME` (default `~/.config/supa`, `%APPDATA%\supa` on
  Windows): `supa.registry` + `supa.config` (`max_active`, `ram_budget_gb`,
  `backup_dir`).
- Which services run, the Postgres version, and image versions live in each
  project's `config.toml` — supa reads it live; edit it, then `supa restart`.
- **Only Supabase stacks are touched.** Every container / volume / image
  operation is filtered by the Supabase CLI's project label or a Supabase image
  repository, so other containers on the same Docker daemon are never stopped,
  capped, or pruned ([scope](./docs/SUPA.md#scope--what-supa-touches-on-your-docker-host)).

First-run walkthrough: **[QUICKSTART.md](./docs/QUICKSTART.md)** · full guide:
**[SUPA.md](./docs/SUPA.md)** · port scheme: **[PORTS.md](./docs/PORTS.md)**.

## Requirements

- [Docker](https://www.docker.com/) — Desktop or Engine
- [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started)
  — v2.30+ (`rotate`/`env` rely on JWT signing keys; `supa doctor` warns on
  older versions)
- [Deno](https://deno.com) — v2+, to build from source only

## License

[Apache-2.0](./LICENSE) © conanhazelnut

supa is an independent community tool. It is not affiliated with, sponsored, or
endorsed by Supabase, Inc. "Supabase" is a trademark of Supabase, Inc.
