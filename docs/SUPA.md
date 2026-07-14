# `supa` — local Supabase stack manager

A thin, cross-platform CLI for running **multiple local Supabase stacks (one per
project)** on a single machine via the **Supabase CLI**. It does _not_ hand-roll
Docker Compose — the CLI still owns every container, volume and network. `supa`
only decides _which_ stacks run (up to a limit you set) and reads each stack's
live facts (Docker label, host ports) straight from that project's
`supabase/config.toml`.

TypeScript (a thin `main.ts` entry over `src/` modules) compiled to native
binaries with `deno compile` — `supa` (macOS/Linux) and `supa.exe` (Windows).
The person running it needs nothing installed beyond **Docker** and the
**Supabase CLI**.

> **Operating the runtime (human or AI agent)?** Jump to
> [For AI agents](#for-ai-agents), then the [command reference](#command-reference).

---

## Mental model (read this first)

- **One codebase, native binaries.** A thin `main.ts` dispatches to `src/`
  modules — the only implementation. It's compiled per-platform (see
  [Building](#building--installing)); there is no bash/PowerShell twin to keep in
  sync anymore.
- **The registry is the only thing you maintain by hand.** It maps a friendly
  `name` → a project's repo root. _Everything else_ (Docker label, API/DB/Studio
  ports) is derived from that repo's `supabase/config.toml` at call time — no
  ports or labels duplicated anywhere to drift.
- **A limit you choose, not hard single-active.** `max_active` caps how many
  stacks run at once (default **1**, RAM-bound hosts). `supa up X` refuses once
  the limit is reached. Raise it with `supa config max-active <n>`.
- **`supa ls` is the live source of truth** for what's registered, its ports,
  and what's UP right now.

---

## Files & where config lives

| File / dir             | What it is                                                       | In git? |
| ---------------------- | ---------------------------------------------------------------- | ------- |
| `main.ts`              | thin CLI entry: parse the verb, dispatch into `src/`             | yes     |
| `src/`                 | the implementation (util → parse → config → supabase → commands) | yes     |
| `build.sh`             | compiles `main.ts` → `dist/supa` + `dist/supa.exe`               | yes     |
| `dist/`                | compiled binaries (~65–77 MB each)                               | **no**  |
| `supa.registry`        | **the config you maintain**: `name\|path` per project            | yes     |
| `supa.config`          | machine-local setting (`max_active`)                             | **no**  |
| `SUPA.md` / `PORTS.md` | this guide / the port map + service profiles                     | yes     |

**Config directory (`SUPA_HOME`).** A compiled binary lives on your `PATH`, not
beside the repo, so `supa` looks for `supa.registry` and `supa.config` in a
config dir resolved in this order:

1. `$SUPA_HOME` if set.
2. `$XDG_CONFIG_HOME/supa` if set.
3. Windows: `%APPDATA%\supa`.
4. else `~/.config/supa`.

Point `SUPA_HOME` at a repo to keep the registry version-controlled (e.g.
`export SUPA_HOME="$HOME/code/supa"`), or use a `supa`-dir symlink. Fine-grained
overrides: `SUPA_REGISTRY` (registry file path), `SUPA_CONFIG` (config file
path). `supa config` prints exactly what it resolved.

---

## Command reference

Same binary, same commands on every OS (`supa` on macOS/Linux, `supa.exe` /
`supa` on Windows). Aliases in parentheses.

| Command                             | Does                                                            |
| ----------------------------------- | --------------------------------------------------------------- |
| `supa ls` (`list`)                  | list projects, docker label, live ports, up/down status         |
| `supa up <p...>` (`start`)          | start stack(s) — refuses past the `max_active` limit            |
| `supa down <p...>` (`stop`)         | stop one or more stacks (`--all` for every registered)          |
| `supa restart <p...>`               | stop + start a stack                                            |
| `supa switch <p>` (`only`)          | stop all others, run only `<p>`                                 |
| `supa destroy <p> [--yes]`          | stop + **DELETE** a stack's data (containers + volumes)         |
| `supa rotate <p> [--yes]`           | new JWT signing key + restart (invalidates tokens)              |
| `supa backup <p> [flags]`           | dump the local DB to a timestamped `.sql` (see below)           |
| `supa restore <p> <file>\|--latest` | load a dump into the live DB — atomic, with a safety pre-dump   |
| `supa upgrade <p> --to <ver>`       | Postgres major upgrade: snapshot → recreate → restore           |
| `supa status` (`ps`)                | raw docker view, grouped by project                             |
| `supa stats`                        | CPU/MEM per container + per-stack & total RAM (vs `ram_budget`) |
| `supa logs <p> [svc] [-f]`          | tail a stack's container logs (no `svc` → list services)        |
| `supa env <p> [--write [f]]`        | print keys/URLs, or merge them into a `.env` file               |
| `supa add <name> <path> [--init]`   | register a project (`--init`: `supabase init` + assign ports)   |
| `supa rm <name>`                    | unregister a project                                            |
| `supa ports <name> [slot]`          | re-band that project's `543XX` ports to a free slot             |
| `supa doctor`                       | preflight: docker, CLI, registry, ports, config                 |
| `supa config`                       | show `max_active`, `ram_budget` + resolved paths                |
| `supa config max-active <n>`        | set how many stacks may run at once (persists)                  |
| `supa config ram-budget <gb>`       | warn in `stats` when total RAM exceeds this                     |
| `supa config backup-dir <path>`     | where `supa backup` writes dumps (default `<project>/backups/`) |
| `supa version`                      | print the supa version (`--version` / `-V` too)                 |
| `supa help`                         | usage                                                           |

**Notes on the destructive / mutating commands:**

- **`destroy`** deletes local data (DB volume) and cannot be undone. It names the
  target and requires you to **type the project name** to confirm; `--yes` skips
  the prompt (for scripts). One project at a time — no `--all`.
- **`rotate`** generates a new JWT signing key (`supabase gen signing-key`),
  writes it as a JWK **array** to `signing_keys.json` beside `config.toml` (the
  location Supabase resolves `signing_keys_path` against), sets `signing_keys_path`
  in `config.toml` (backing it up), and restarts. Existing tokens/sessions become
  invalid. Same typed-name confirmation as `destroy`. **Gitignore the key file** —
  it holds the private signing key.
- **`add --init`** runs `supabase init` in the path (skipped if a config already
  exists), then assigns a free `543XX` band (or `--slot N`). Without `--init` it
  just registers and suggests the next free slot.
- **`env --write`** merges `supabase status -o env` into a dotenv file (default
  `<config-dir>/.env.local`): updates existing keys in place, keeps other lines,
  appends new ones, masks secrets in the console. By default it writes Supabase's
  **native** names (`API_URL`, `ANON_KEY`, `SERVICE_ROLE_KEY`, `DB_URL`, …).
  To rename them for your app, drop a **`supa.env.map`** next to `config.toml`:
  ```
  # APP_NAME = NATIVE_NAME   (one native may feed several app names)
  SUPABASE_URL              = API_URL
  SUPABASE_ANON_KEY         = ANON_KEY
  SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY
  DATABASE_URL              = DB_URL
  DIRECT_DATABASE_URL       = DB_URL
  ```
  With a map present, only the mapped names are written (missing natives warn).
  The map holds names only — no secrets — so it's safe to commit in the project.
- **`ports`** rewrites only ports already on the `543XX` scheme, keeping the
  service digit, and writes a `config.toml.bak` first. Run `supa restart` after.
- **`backup`** dumps the **local** DB via `supabase db dump --local` (the stack
  must be **up**). Default is a **full** snapshot — roles + schema + data,
  concatenated in restore order into one `<name>_<YYYY-MM-DD_HHMM>.sql`. Flags:
  `--data-only` / `--schema-only` / `--roles-only` (one part only; data files are
  named `<name>_data_…`), `--use-copy` (COPY instead of INSERTs, for large data),
  `--out <dir>` (this run only). Output dir resolves **`--out` → `backup_dir`
  config → `<project-root>/backups/`**. Writes atomically (temp → rename), so an
  interrupted dump never leaves a usable-looking file. **Gitignore your backups
  dir** — dumps contain real data.
- **`restore`** loads a dump into the stack's **live** DB (must be up) by piping it
  into the db container's `psql` — no host `psql` needed. Give it a file or
  `--latest` (newest dump in the backup dir, ignoring pre-restore snapshots).
  Safety model, same spirit as `destroy`: it **type-name confirms** (`--yes` to
  skip), takes a **full safety pre-dump first** (`<name>_pre-restore_…`), and runs
  inside a **single transaction** — any error rolls the whole thing back, leaving
  the DB unchanged (`ON_ERROR_STOP`; `--no-tx` to opt out). `--db <name>` targets a
  non-default database. **Target state matters:** a Supabase dump omits the managed
  schemas/roles, so it must restore into a Supabase-initialised DB — a **data-only**
  dump into a migrated (freshly `reset`/`start`ed) schema is the clean path; a full
  dump conflicts with an existing schema. Automate the prep with hooks ↓.
- **`upgrade <p> --to <ver>`** automates a **Postgres major-version** migration —
  the otherwise-manual dance — in six steps: data-only snapshot → stop → bump
  `[db] major_version` (backs up `config.toml`) → **drop the DB volume**
  `supabase_db_<label>` → start fresh on the new version (migrations run) → restore
  the snapshot (running `restore.pre`/`restore.post` hooks). **Destructive** (drops
  the volume): type-name confirm (`--yes` to skip), and the snapshot is kept as the
  recovery artifact. Preview the plan with **`--dry-run`**. The restore step needs
  the schema in place first — that's the project's `restore.pre` hook (e.g.
  `deno task db:migrate`). Only the DB volume is dropped; a storage volume, if any,
  is left intact.

### Per-project hooks (`supa.hooks`)

Drop a `supa.hooks` next to `config.toml` (in the same dir as `supa.env.map`) to let
a project declare its own restore steps — supa owns the flow, the project owns the
specifics:

```
# runs before / after `supa restore` (in the project dir, via your shell)
restore.pre  = supabase db reset      # get a clean, migrated schema first
restore.post = deno task db:migrate   # re-apply migrations / seed after data loads
backup.type  = full                   # default type for `supa backup` (full|data|schema|roles)
```

Hooks are the one place supa runs a shell command (they're your commands, like a
Makefile target). A failing hook aborts the operation.

### Setting the concurrency limit

```sh
supa config max-active 2     # persist: at most 2 stacks at once
supa config                  # show current limit + paths
SUPA_MAX_ACTIVE=3 supa up x  # one-off override for this command
SUPA_ALLOW_MULTI=1 supa up x # unlimited (back-compat alias)
```

Precedence: `SUPA_ALLOW_MULTI=1` → `SUPA_MAX_ACTIVE` → `supa.config` → default 1.

---

## How resolution works (no stale state)

For a registered `name`, on every call `supa`:

1. **Finds the config dir** — the first of `<root>/`, `<root>/apps/*/`,
   `<root>/examples/*/` that contains `supabase/config.toml`. That dir is passed
   to the CLI as `--workdir`.
2. **Reads the Docker label** — `project_id` in `config.toml`. Names the
   containers (`supabase_*_<label>`) and what `docker ps` reports.
3. **Reads live host ports** — `port` under `[api]` / `[db]` / `[studio]`.

Change a port in `config.toml` and `supa ls` reflects it immediately.

---

## The registry (`supa.registry`)

One project per line, `#` for comments, blank lines ignored:

```
web|~/code/web
api|~/code/api
admin|~/code/admin
```

- **name** — what you type (`supa up <name>`).
- **path** — the repo root. A leading `~` expands to home on every OS. Use
  forward slashes even on Windows; absolute paths work too.

---

## Installing

Most users don't build anything — the install scripts download a prebuilt binary
(see the [README](../README.md)):

```sh
curl -fsSL https://raw.githubusercontent.com/conanhazelnut/supa/main/install.sh | sh   # macOS/Linux
irm https://raw.githubusercontent.com/conanhazelnut/supa/main/install.ps1 | iex        # Windows
```

Those binaries come from CI (`.github/workflows/release.yml`) on each version
tag, attached to the GitHub Release.

## Building from source

Needs **Deno** on the build machine only (`deno compile` bundles the runtime, so
the _running_ machine needs nothing). Install it from https://deno.com.

```sh
./build.sh            # → dist/supa (this host) + dist/supa.exe (Windows x64)
./build.sh host       # only this host
./build.sh windows    # only the Windows .exe
./build.sh release    # ALL platforms as dist/supa-<target>[.exe] (what CI runs)
```

### macOS / Linux

```sh
export SUPA_HOME="$HOME/code/supa"                # so it finds this repo's registry
ln -sf "$HOME/code/supa/dist/supa" ~/.local/bin/supa    # ~/.local/bin on PATH
supa ls
```

### Windows (the other machine — no Deno, no WSL)

1. Install Docker Desktop and the Supabase CLI (both on `PATH`).
2. Copy `dist/supa.exe` over (AirDrop / cloud / USB) to e.g. `C:\tools\supa.exe`,
   and add that folder to `PATH`.
3. Put your registry where it's found — either set `SUPA_HOME`:
   ```powershell
   setx SUPA_HOME "C:\code\supa"      # dir holding supa.registry
   ```
   or drop `supa.registry` into `%APPDATA%\supa\`.
4. `supa ls`. No execution-policy dance — it's a real `.exe`, not a script.

> The Windows registry paths are that machine's own (e.g. `C:/code/web`); edit
> `supa.registry` there. `supa config` shows what it resolved if a path is off.

---

## Single-active / limited-active policy

`supa up X` counts the Supabase stacks currently running; if starting `X` would
exceed `max_active`, it refuses and tells you how to proceed: free a slot
(`supa down`), swap (`supa switch X`), raise the limit
(`supa config max-active <n>`), or a one-off `SUPA_MAX_ACTIVE=<n>`. Re-running
`up` on an already-running stack is always allowed.

Why a limit at all: an untrimmed stack is ~12 containers / ~1.8 GiB, so an idle
one shouldn't hog RAM. Trimmed stacks (see `PORTS.md` service profiles) are
~0.5–0.7 GiB and coexist fine — that's what raising `max_active` is for.

---

## Adding a project

1. Pick a **free, non-overlapping** port band (see `PORTS.md`).
2. In that repo's `supabase/config.toml`, set every port into that band.
3. Append one line to `supa.registry`: `name|~/path/to/repo`.
4. `supa ls` to confirm the derived label + ports.
5. Update the snapshot table in `PORTS.md`.

---

## Troubleshooting & gotchas

- **`registry not found`** — set `SUPA_HOME` (or `SUPA_REGISTRY`) to where
  `supa.registry` lives; `supa config` shows what it looked for.
- **`no supabase/config.toml under ...`** — the registry path is wrong, or the
  config isn't at root / `apps/*` / `examples/*`.
- **`max-active limit reached`** — expected; raise it or `switch`.
- **Windows: `supabase`/`docker` not recognized** — not on `PATH`; install or
  open a new terminal.
- **`restart=no` resets after start** — the CLI recreates containers with its
  default restart policy on each `start`; `supa` re-pins `restart=no` after
  `up`/`switch`.
- **JWT vs publishable keys** — some clients (e.g. certain Realtime setups)
  expect the legacy `ANON_KEY` / `SERVICE_ROLE_KEY` JWTs from
  `supabase status -o env` rather than the newer `sb_publishable_` / `sb_secret_`
  keys. If auth/realtime rejects a key, try the JWT form (`supa env --write`
  writes the `-o env` values).
- **Clock drift after sleep** → flaky time-window tests; fix with a stop/start.
- **Unsigned binary on first run** — the release binaries aren't code-signed. The
  `curl | sh` install avoids macOS Gatekeeper, but a _browser_-downloaded binary
  needs `xattr -d com.apple.quarantine <path>` (macOS); on Windows, SmartScreen
  may warn — choose _More info → Run anyway_.

---

## For AI agents

Run `supa help` for the current command list; `supa doctor` to check the
environment. Commands fall into three tiers — treat them accordingly.

### Tier 1 — read-only (run freely to answer questions)

`supa ls` · `supa status` · `supa stats` · `supa logs <p> [svc]` · `supa doctor`
· `supa config` · `supa env <p>` (without `--write`). Also: read `supa.registry`,
`PORTS.md`, `MILESTONE.md`, any `supabase/config.toml`. Prefer these to inspect
state before doing anything.

### Tier 2 — state-changing (state what you'll do, then act)

- `supa up / down / restart / switch` — start/stop real containers. `switch` and
  `down --all` stop **other** stacks — name which ones first.
- `supa add / rm` — edit the registry. `supa ports <name>` — rewrites a
  `config.toml`'s ports (it backs up `.bak`, but it's a real edit).
- `supa env <p> --write [file]` — writes into a project's `.env` file.
- `supa config max-active <n>` / `ram-budget <gb>` — change limits.
- Respect `max_active`: don't raise it or use `SUPA_MAX_ACTIVE` /
  `SUPA_ALLOW_MULTI` unless the user asked or you've checked the RAM budget
  (`supa stats`).

### Tier 3 — destructive (never run without explicit user go-ahead on that target)

- `supa destroy <p>` — **deletes** the stack's DB data (volumes). Irreversible.
- `supa rotate <p>` — new JWT signing key; **invalidates all existing tokens/
  sessions** and changes the anon/service keys.
- Both prompt for a typed project-name confirmation. **Never pass `--yes` on the
  user's behalf** unless they explicitly asked for that exact action on that
  exact project.

### Where things live (don't fight the design)

- **Stack composition — which services are on, Postgres `major_version`, image
  versions — lives in each project's `config.toml`, not in supa.** To change it,
  edit that `config.toml`, then `supa restart <p>`. supa reads it live.
- The Supabase **CLI version** (all service images) is whatever `supabase` is on
  `PATH` (`supa doctor` shows it) — machine-wide, not per-project.

### Never

- **Never commit** DB dumps, volumes, `dist/` binaries, `supa.config`, or a
  project's `signing_keys.json` (all gitignored; several hold secrets/real data).
- **Never edit ports/labels expecting supa to store them** — they live in
  `config.toml`; supa derives them every call.
- **Never hand-edit the compiled binary.** Change the source under `src/` (or
  `main.ts`), then `./build.sh`.

### Verifying a change to supa itself

`deno task check` + `deno task lint` + `deno fmt --check`, then
`SUPA_HOME=<repo> deno run -A main.ts ls` (and `config`, `help`). To exercise the
`max_active` guard or the destructive commands **without real side effects**, put
fake `docker` / `supabase` shims first on `PATH` and point `SUPA_REGISTRY` /
`SUPA_CONFIG` at throwaway files.

---

## See also

- `README.md` — overview, install, quick start.
- `PORTS.md` — port scheme, allocation example, per-project service profiles.
- `MILESTONE.md` — planned features (a Multibase-inspired roadmap).
- Each project's `supabase/config.toml` — the authoritative stack definition.
