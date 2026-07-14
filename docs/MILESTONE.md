# supa — roadmap

Feature backlog, largely inspired by **[osobh/multibase](https://github.com/osobh/multibase)**
(a heavier "run many self-hosted Supabase instances" tool with a web dashboard).

## Guiding principle — stay a thin CLI

Multibase's reach is also its weight: a React dashboard, a Node backend, a Python
CLI, and its own Docker Compose. supa's value is the opposite — a single binary
that **wraps the official Supabase CLI**. Adopt Multibase's _capabilities_ without
its _bulk_: prefer CLI/TUI over a web app, derive-don't-store, and lean on
`supabase` + `docker` instead of reimplementing them.

Legend: ✅ done · 🟡 planned · 🔬 only if a real need shows up

---

## Feature map (Multibase → supa)

| Capability                                  | Multibase               | supa                                                                   |
| ------------------------------------------- | ----------------------- | ---------------------------------------------------------------------- |
| name→path registry                          | ✅ (`projects/<name>/`) | ✅ `supa.registry`                                                     |
| start / stop / **restart**                  | ✅                      | ✅ `up` / `down` / `restart`                                           |
| switch / single-or-N active                 | ❌ (unlimited)          | ✅ `switch` + `max_active`                                             |
| derive ports/label from config              | uses own compose        | ✅ from `config.toml`                                                  |
| cross-platform                              | web (any OS)            | ✅ `supa` / `supa.exe`                                                 |
| **delete / destroy** (containers + volumes) | ✅                      | ✅ `destroy` (typed confirm, `--yes`)                                  |
| **logs**                                    | via dashboard           | ✅ `logs <p> [svc] [-f]`                                               |
| **registry via command**                    | web form                | ✅ `add` / `rm`                                                        |
| **system metrics** (CPU/RAM)                | ✅ dashboard            | ✅ `stats` (via `docker stats`)                                        |
| **health check**                            | ✅                      | ✅ `doctor`                                                            |
| **credential → env**                        | ✅                      | ✅ `env --write` (+ `supa.env.map` rename)                             |
| **port assignment**                         | ✅ auto                 | ✅ `ports` re-band + `add --init` auto-assign                          |
| **alert rules / thresholds**                | ✅                      | ✅ `stats` per-stack/total RAM vs `ram_budget` + suggests `max_active` |
| **credential rotation**                     | ✅                      | ✅ `rotate` (new JWT signing key + restart)                            |
| **backup / restore / upgrade**              | ✅                      | ✅ `backup` · `restore` · hooks · `upgrade`                            |
| **web dashboard / GUI**                     | ✅ (React)              | 🔬 a **TUI** over web, only if needed                                  |
| **many self-hosted instances (compose)**    | ✅ core model           | 🔬 separate track — different philosophy                               |

---

## Milestones

### M1 — Core (✅ done)

Registry, config.toml-derived label/ports, `up/down/switch/ls/status/env`,
configurable `max_active`, cross-platform binaries.

### M2 — Lifecycle, observability, registry, credentials (✅ done)

`restart` · `destroy` (typed confirm + `--yes`, deletes volumes) · `logs` ·
`stats` · `doctor` · `add`/`rm` · `ports` (re-band) · `env --write` (dotenv merge
plus secret masking). All shipped and tested (fake-shim + real smoke).

### M3 — Credentials, ports, resource budget (✅ done)

- **`env --write` name-mapping** — per-project `supa.env.map` (`APP = NATIVE`,
  one-to-many). Renames on write; native names when no map (never guesses).
- **`rotate`** — `supabase gen signing-key` → `signing_keys.json` +
  `signing_keys_path` in config + restart. Typed-name confirm.
- **`add --init`** — `supabase init` + auto-assign a free `543XX` band.
- **RAM budget** — `supa config ram-budget <gb>`; `stats` shows per-stack + total
  RAM and flags over-budget.

### M3-leftover (🟡)

- **Windows real-machine validation** — the `.exe` is cross-compiled + format-
  verified but not yet _run_ on real Windows; smoke-test `ls` / `up` there.
  (`rotate` is verified with the real CLI on a throwaway project; its restart
  path is the same proven `up`/`down` code.)

### M4 — Data management (backup / restore / upgrade) (✅ done)

supa owns the local data lifecycle by **orchestrating** `supabase db dump` + the
db container's `psql` — never reimplementing them. Destructive steps reuse the
`destroy` safety model (typed-name confirm + `--yes`).

- **`backup <p>`** (✅) — `supabase db dump --local` (stack must be up). Default is
  a **full** snapshot: roles + schema + data concatenated in restore order into
  `<name>_<YYYY-MM-DD_HHMM>.sql`. Part flags `--data-only` / `--schema-only` /
  `--roles-only`, plus `--use-copy` and `--out`. Output dir resolves
  `--out` → `backup_dir` config → `<project-root>/backups/`. Atomic (temp →
  rename) so an interrupted dump never leaves a usable-looking file.
- **`restore <p> [<file>|--latest]`** (✅) — the Supabase CLI has **no** restore,
  so pipe the dump into the db container: `docker exec -i supabase_db_<label> psql
  -v ON_ERROR_STOP=1 --single-transaction` (no host `psql`; cross-platform; atomic
  — any error rolls back, DB unchanged). Typed-name confirm + a full **safety
  pre-dump** first. `--latest`, `--db`, `--no-tx`.
- **hooks** (✅) — an optional per-project `supa.hooks` (`restore.pre`,
  `restore.post`, `backup.type`): supa owns the flow, each project declares its own
  migrate/seed steps. One flow, N projects, zero hardcoding.
- **`upgrade <p> --to <ver>`** (✅) — automates the Postgres major-version dance:
  data-only snapshot → stop → bump `major_version` (+ `.bak`) → drop the DB volume
  `supabase_db_<label>` → start fresh → restore (+ hooks). Type-name confirm,
  `--dry-run` to preview; snapshot kept for recovery. Only the DB volume is dropped
  (a storage volume, if any, is preserved).

Delivery: **Phase 1 `backup`** ✅ → **Phase 2 `restore` + hooks** ✅ → **Phase 3
`upgrade`** ✅. The pre-Phase-2 spike is retired: `docker exec … psql` round-trips
fine, and — key finding — a Supabase dump **omits managed schemas/roles**, so
restore targets a Supabase-initialised DB (data-only into a reset/migrated schema
is the clean path; that's what the hooks automate). Live-tested: backup (full +
data-only) and restore (happy path) against a real stack; `upgrade` validated via
`--dry-run` (the destructive full run is left to a real major-version bump).

### M5 — Distribution & scale (🟡 / 🔬)

- GitHub Releases for the binaries (instead of copying `dist/supa.exe` by hand).
- 🔬 Optional TUI dashboard. 🔬 Optional compose-based self-hosted track.

---

## Open questions

- **Metrics depth** — is point-in-time `docker stats` enough, or keep history
  (which pulls toward Multibase's heavier storage)?
- **`rotate` scope** — signing-key rotation covers JWT; do we also want a path to
  rotate storage S3 keys / DB password locally?
