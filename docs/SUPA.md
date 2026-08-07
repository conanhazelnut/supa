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
- **supa only ever touches Supabase stacks.** Your other containers (a php
  service, a redis, your own builds) share the Docker daemon and are never
  started, stopped, capped, or deleted by supa. See [Scope](#scope--what-supa-touches-on-your-docker-host).

---

## Scope — what supa touches on your Docker host

supa coordinates Supabase stacks on a Docker daemon it shares with everything
else you run. The boundary is mechanical, not a promise: every container,
volume, and image operation is filtered by the Supabase CLI's own project label
(`com.supabase.cli.project`) or by a Supabase image repository.

| supa does this                       | Scoped by                                  |
| ------------------------------------ | ------------------------------------------ |
| `up` / `down` / `restart` / `switch` | `supabase start\|stop --workdir <project>` |
| `status` / `stats` / `logs`          | `label=com.supabase.cli.project`           |
| `limit` (memory/cpu caps)            | `label=…=<project label>`                  |
| `destroy` (volumes)                  | `label=…=<project label>`                  |
| `pg-upgrade` (drops one volume)      | volume named `supabase_db_<label>`         |
| `backup` / `restore` (psql)          | that stack's db container                  |
| `prune` (images)                     | repositories under a `supabase` namespace  |

Consequences worth knowing:

- **`supa switch` leaves unknown stacks up.** It stops only running stacks that
  are in your registry; a Supabase stack it doesn't manage gets a warning, not a
  `stop`.
- **`supa prune` never runs a host-wide `docker image prune`.** It removes
  untagged images only when their repo digests prove they came from a Supabase
  repository — a locally built layer has no digest and is therefore never
  attributed to supa. Other projects' images are counted and left alone.
- **supa never deletes a volume it doesn't manage.** `supa destroy` removes a
  registered stack's data on a typed confirmation; orphan Supabase volumes (a
  stack that isn't in your registry) are reported with the `docker volume rm`
  command so the decision stays yours.
- **Port bands are checked against other containers.** `supa ports` /
  `supa add --init` skip a `543xX` band that a non-Supabase container already
  publishes on, and `supa doctor` reports any overlap.
- **Two things are deliberately unbounded**: your `supa.hooks` commands (they run
  through your shell — that's the point), and RAM/CPU pressure on the shared
  Docker VM. `supa.limits` caps Supabase containers only; nothing reserves
  headroom for your other services, which is what `max_active` is for.

---

## Files & where config lives

| File / dir             | What it is                                                       | In git? |
| ---------------------- | ---------------------------------------------------------------- | ------- |
| `main.ts`              | thin CLI entry: parse the verb, dispatch into `src/`             | yes     |
| `src/`                 | the implementation (util → parse → config → supabase → commands) | yes     |
| `build.ts`             | compiles `main.ts` → `dist/supa` + `dist/supa.exe` (any OS)      | yes     |
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

| Command                              | Does                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------ |
| `supa ls [--json]` (`list`)          | list projects, docker label, live ports, up/down status                  |
| `supa up <p...>` (`start`)           | start stack(s) — refuses past the `max_active` limit                     |
| `supa down <p...>` (`stop`)          | stop one or more stacks (`--all` for every registered)                   |
| `supa restart <p...>`                | stop + start a stack                                                     |
| `supa switch <p>` (`only`)           | stop all others, run only `<p>`                                          |
| `supa destroy <p> [--yes]`           | stop + **DELETE** a stack's data (containers + volumes)                  |
| `supa rotate <p> [--yes]`            | new JWT signing key + restart (invalidates tokens)                       |
| `supa backup <p> [flags]`            | dump the local DB to a timestamped `.sql` (see below)                    |
| `supa restore <p> <file>\|--latest`  | load a dump into the live DB — atomic, with a safety pre-dump            |
| `supa pg-upgrade <p> --to <ver>`     | Postgres major upgrade: snapshot → recreate → restore                    |
| `supa upgrade [--check]`             | update **supa itself** from GitHub Releases (checksum-verified)          |
| `supa status [--json]` (`ps`)        | raw docker view, grouped by project                                      |
| `supa stats`                         | CPU/MEM per container + per-stack & total RAM (vs `ram_budget`)          |
| `supa limit <p>`                     | apply `supa.limits` (memory/cpus caps) to a running stack                |
| `supa logs <p> [svc] [-f]`           | tail a stack's container logs (no `svc` → list services)                 |
| `supa env <p> [--write [f]]`         | print keys/URLs, or merge them into a `.env` file                        |
| `supa add <name> <path> [--init]`    | register a project (`--init`: `supabase init` + assign ports)            |
| `supa rm <name>`                     | unregister a project                                                     |
| `supa park [<dir>]` / `unpark`       | opt-in auto-discovery of supabase projects in a directory                |
| `supa ports <name> [slot] [--force]` | re-band `543XX` ports to a free slot (auto-picks; `--force` to override) |
| `supa doctor`                        | preflight: docker, CLI, registry, ports, config                          |
| `supa prune [--images]`              | reclaim docker disk — Supabase images only (others reported)             |
| `supa config`                        | show `max_active`, `ram_budget` + resolved paths                         |
| `supa config max-active <n>`         | set how many stacks may run at once (persists)                           |
| `supa config ram-budget <gb>`        | warn in `stats` when total RAM exceeds this                              |
| `supa config backup-dir <path>`      | where `supa backup` writes dumps (default `<project>/backups/`)          |
| `supa completion bash\|zsh\|pwsh`    | print a tab-completion script (verbs + project names)                    |
| `supa version`                       | print the supa version (`--version` / `-V` too)                          |
| `supa help [command]`                | usage, or detailed help for one command (`<cmd> --help` too)             |

**Scripting:** `ls` / `status` / `config` take `--json` — that output is the
stable machine interface. Parse it, never the human tables (their layout may
change between versions).

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
  Omit the slot and it **auto-picks a free one**; pass an explicit slot already
  used by another registered project and it **refuses** (their ports would
  collide) unless you add `--force`.
- **`backup`** dumps the **local** DB via `supabase db dump --local` (the stack
  must be **up**). Default is a **full** snapshot — roles + schema + data,
  concatenated in restore order into one `<name>_<YYYY-MM-DD_HHMMSS>.sql`. Flags:
  `--data-only` / `--schema-only` / `--roles-only` (one part only; data files are
  named `<name>_data_…`), `--use-copy` (COPY instead of INSERTs, for large data),
  `--out <dir>` (this run only). Output dir resolves **`--out` → `backup_dir`
  config → `<project-root>/backups/`**. Writes atomically (temp → rename), so an
  interrupted dump never leaves a usable-looking file. **Gitignore your backups
  dir** — dumps contain real data.
- **`restore`** loads a dump into the stack's **live** DB (must be up) by piping it
  into the db container's `psql` — no host `psql` needed. Give it a file (`.sql`,
  or `.sql.gz` — decompressed on the fly) or `--latest` (newest `.sql` / `.sql.gz`
  in the backup dir, ignoring pre-restore snapshots).
  Safety model, same spirit as `destroy`: it **type-name confirms** (`--yes` to
  skip), takes a **full safety pre-dump first** (`<name>_pre-restore_…`), and runs
  inside a **single transaction** — any error rolls the whole thing back, leaving
  the DB unchanged (`ON_ERROR_STOP`; `--no-tx` to opt out). `--db <name>` targets a
  non-default database. **Target state matters:** a Supabase dump omits the managed
  schemas/roles, so it must restore into a Supabase-initialised DB — a **data-only**
  dump into a migrated (freshly `reset`/`start`ed) schema is the clean path; a full
  dump conflicts with an existing schema. Automate the prep with hooks ↓.
- **`pg-upgrade <p> --to <ver>`** automates a **Postgres major-version** migration —
  the otherwise-manual dance — in six steps: data-only snapshot → stop → bump
  `[db] major_version` (backs up `config.toml`) → **drop the DB volume**
  `supabase_db_<label>` → start fresh on the new version (migrations run) → restore
  the snapshot (running `restore.pre`/`restore.post` hooks). **Destructive** (drops
  the volume): type-name confirm (`--yes` to skip), and the snapshot is kept as the
  recovery artifact. Preview the plan with **`--dry-run`**. The restore step needs
  the schema in place first — that's the project's `restore.pre` hook (e.g.
  `deno task db:migrate`). Only the DB volume is dropped; a storage volume, if any,
  is left intact.

  **No downgrade — roll back instead.** Postgres has no supported major-version
  downgrade (a newer dump may not load into an older server), so `pg-upgrade` refuses
  a lower `--to` unless you pass `--allow-downgrade`. To undo a bad upgrade, **roll
  back**: the pre-upgrade snapshot was dumped on the _old_ version, so restoring it
  onto that version is safe. After an upgrade `<old>` → `<new>` you want to reverse:

  ```sh
  supa down <p>
  mv <config.toml>.bak <config.toml>              # major_version back to <old>
  docker volume rm supabase_db_<label>            # drop the <new> volume
  supa up <p>                                     # fresh <old> volume; migrations run
  supa restore <p> <name>_upgrade-<old>-to-<new>_<ts>.sql   # data was dumped on <old>
  ```

- **`upgrade [--check]`** updates **supa itself**: queries the latest GitHub
  Release, downloads the binary for this platform, verifies it against
  `SHA256SUMS.txt` (fail-closed, same rule as the install scripts), and swaps it
  in atomically (the old binary is renamed aside first, so updating while supa
  runs works — including on Windows). `--check` only reports whether a newer
  version exists. supa never checks for updates on its own — this command is its
  only network call, and only when you run it.

### Per-project hooks (`supa.hooks`)

Drop a `supa.hooks` next to `config.toml` (in the same dir as `supa.env.map`) to let
a project declare its own lifecycle steps — supa owns the flow, the project owns the
specifics:

```
# runs before / after `supa restore` (in the project dir, via your shell)
restore.pre  = supabase db reset      # get a clean, migrated schema first
restore.post = deno task db:migrate   # re-apply migrations / seed after data loads
backup.type  = full                   # default type for `supa backup` (full|data|schema|roles)
# lifecycle hooks around start/stop (also fire via restart / switch / pg-upgrade)
up.pre    = docker info > NUL         # e.g. preflight
up.post   = deno task dev:seed        # e.g. seed / warm caches once the stack is up
down.pre  = echo draining...
down.post = echo stopped.
```

Hooks are the one place supa runs a shell command (they're your commands, like a
Makefile target). A failing hook aborts the operation.

### Resource limits (`supa.limits`) — capping RAM/CPU per stack

By default a Supabase container has **no memory limit** — it can balloon up to the
whole Docker VM (and past your physical RAM into swap). On a RAM-bound host, drop a
`supa.limits` next to `config.toml` to cap each container. supa applies it via
`docker update` right after `supa up` (and `supa limit <p>` re-applies to a running
stack). See [`examples/supa.limits.example`](../examples/supa.limits.example):

```
default.memory = 256m      # every container unless overridden
db.memory      = 1g        # Postgres needs the most
db.cpus        = 2
analytics.memory = 512m    # if enabled — a memory hog
```

`memory` is a **hard cap** (no swap — an over-limit container is OOM-killed rather
than swapping the host to death), so give heavy services (`db`) headroom. **The
bigger RAM win, though, is turning off services you don't use** in `config.toml`
(e.g. `[analytics] enabled = false`) — cap what remains with `supa.limits`.

### Reclaiming disk (`supa prune`)

Supabase images and volumes are large. `supa prune` reclaims Docker disk **within
supa's [scope](#scope--what-supa-touches-on-your-docker-host)** — Supabase images
only:

```sh
supa prune                 # untagged Supabase images + report orphan volumes
supa prune --dry-run       # show the plan, remove nothing
supa prune --images        # also unused tagged Supabase images (re-pull on next up)
```

Everything else is reported, never removed:

- **Other projects' images** (your php build layers, base images) are counted so
  you can see what's there. Reclaiming those is a host-wide decision — run
  `docker image prune` yourself.
- **Orphan volumes** — a `com.supabase.cli.project`-labelled volume whose stack is
  neither registered nor running, i.e. a stack supa doesn't manage. It holds real
  data, so supa prints the `docker volume rm …` line instead of running it. For a
  registered stack, `supa destroy <project>` is the supported path.
- `--volumes` / `--all` are still accepted and now only produce that report.

Removal never uses `--force`: Docker refuses to delete an image any container
still references (running _or_ stopped), and supa reports that refusal rather
than overriding it. `supa doctor` / `supa stats` show what's live before pruning.

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
*|~/code            # parked dir (written by `supa park ~/code`)
```

- **name** — what you type (`supa up <name>`). Letters/digits/`._-` only —
  names reach shell tab-completion, so the charset is enforced even on
  hand-edited lines; anything else is ignored and `supa doctor` lists it.
- **path** — the repo root. A leading `~` expands to home on every OS. Relative
  paths are resolved to absolute when you `supa add` / `supa park` (so the
  registry survives a later invocation from another cwd). Use forward slashes
  even on Windows; absolute paths work too.
- **`*|dir` (parked)** — opt-in auto-discovery: every immediate subdir of `dir`
  containing a `supabase/config.toml` appears as a project named after the
  subdir. Subdirs without Supabase are ignored, so a mixed projects folder is
  fine. Explicit `name|path` entries win over discovered ones. Manage with
  `supa park <dir>` / `supa unpark <dir>`; `supa park` alone lists parked dirs.

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
deno task build                # → dist/supa (this host) + dist/supa.exe (Windows x64)
deno run -A build.ts host      # only this host
deno run -A build.ts windows   # only the Windows .exe
deno run -A build.ts release   # ALL platforms as dist/supa-<target>[.exe] (what CI runs)
```

The build script is itself a Deno script (`build.ts`), so it runs identically on
macOS, Linux, and Windows — no bash required.

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
`PORTS.md`, any `supabase/config.toml`. Prefer these to inspect state before
doing anything.

### Tier 2 — state-changing (state what you'll do, then act)

- `supa up / down / restart / switch` — start/stop real containers. `switch` and
  `down --all` stop **other** stacks — name which ones first.
- `supa add / rm` — edit the registry. `supa ports <name>` — rewrites a
  `config.toml`'s ports (it backs up `.bak`, but it's a real edit).
- `supa env <p> --write [file]` — writes into a project's `.env` file.
- `supa config max-active <n>` / `ram-budget <gb>` — change limits.
- `supa prune [--images]` — deletes Supabase images (they re-pull). Never other
  projects' images, never volumes — `--dry-run` shows exactly what it would do.
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
  `main.ts`), then `deno task build`.

### Verifying a change to supa itself

`deno task check` + `deno task lint` + `deno fmt --check`, then
`SUPA_HOME=<repo> deno run -A main.ts ls` (and `config`, `help`). To exercise the
`max_active` guard or the destructive commands **without real side effects**, put
fake `docker` / `supabase` shims first on `PATH` and point `SUPA_REGISTRY` /
`SUPA_CONFIG` at throwaway files.

---

## See also

- `README.md` — overview, install, quick start.
- `QUICKSTART.md` — first-run walkthrough with expected output at each step.
- `PORTS.md` — port scheme, allocation example, per-project service profiles.
- Each project's `supabase/config.toml` — the authoritative stack definition.
