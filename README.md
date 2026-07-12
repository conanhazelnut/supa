# supa

A thin, cross-platform CLI for running **multiple local Supabase stacks — one per
project — on a single machine**, on top of the official
[Supabase CLI](https://supabase.com/docs/guides/local-development). No hand-rolled
Docker Compose: the CLI still owns every container; supa just decides *which*
stacks run (up to a limit you set) and reads each stack's live facts (Docker
label, host ports) straight from that project's `supabase/config.toml`.

One TypeScript source (`supa.ts`) compiled with `deno compile` to native binaries
— `supa` (macOS/Linux) and `supa.exe` (Windows). Whoever runs it needs nothing
installed beyond **Docker** and the **Supabase CLI**.

## Why

Running several local Supabase projects means juggling ports, Docker labels, and
which stack is up. The Supabase CLI gives you the primitives (`--workdir`,
per-project `project_id`) but no manager on top. supa is that manager — and
deliberately a *thin* one: it wraps the CLI instead of replacing it, and derives
everything it can from each project's `config.toml` so nothing drifts.

## Install

Needs [Deno](https://deno.com) to build (the built binary needs nothing).

```sh
git clone https://github.com/conanhazelnut/supa.git
cd supa
./build.sh                                    # → dist/supa (host) + dist/supa.exe
ln -sf "$PWD/dist/supa" ~/.local/bin/supa     # put it on PATH (macOS/Linux)
```

Then create your registry:

```sh
mkdir -p ~/.config/supa
cp supa.registry.example ~/.config/supa/supa.registry
$EDITOR ~/.config/supa/supa.registry          # name|path per project
supa ls
```

On Windows: copy `dist/supa.exe` onto your `PATH`, put `supa.registry` in
`%APPDATA%\supa\` (or set `SUPA_HOME`), then `supa ls`. See [SUPA.md](./SUPA.md).

## Quick start

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

| Group | Commands |
| --- | --- |
| **Lifecycle** | `up` · `down [--all]` · `restart` · `switch` · `destroy` · `rotate` |
| **Inspect** | `ls` · `status` · `stats` · `logs` · `doctor` · `env [--write]` |
| **Manage** | `add [--init]` · `rm` · `ports` · `config` |

Destructive commands — `destroy` (deletes a stack's data) and `rotate`
(invalidates existing tokens) — require typing the project name to confirm.

## How it works

- The **registry** (`supa.registry`, `name|path` per line) is the only thing you
  maintain. Docker label + ports are derived from each project's
  `supabase/config.toml` every call.
- **Config** lives in `SUPA_HOME` (default `~/.config/supa`, `%APPDATA%\supa` on
  Windows): `supa.registry` + `supa.config` (`max_active`, `ram_budget_gb`).
- Which services run, the Postgres version, and image versions live in each
  project's `config.toml` — supa reads it live; edit it, then `supa restart`.

Full guide: **[SUPA.md](./SUPA.md)** · port scheme: **[PORTS.md](./PORTS.md)** ·
roadmap: **[MILESTONE.md](./MILESTONE.md)**.

## Requirements

- [Docker](https://www.docker.com/) — Desktop or Engine
- [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started)
- [Deno](https://deno.com) — to build only

## License

[Apache-2.0](./LICENSE) © conanhazelnut
