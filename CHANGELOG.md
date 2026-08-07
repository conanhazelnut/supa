# Changelog

All notable changes to supa are documented here. This project adheres to
[Semantic Versioning](https://semver.org/) and
[Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Fixed

- `SUPA_HOME` / `SUPA_REGISTRY` / `SUPA_CONFIG` (and `XDG_CONFIG_HOME`) expand `~`
  and resolve relative paths against cwd — same rule as registry roots and
  `backup-dir`, so a quoted `SUPA_HOME='~/…'` no longer points at a literal `~`.
- `supa add --init` rolls back the registry line when `supabase init` fails, so
  a failed init leaves no half-applied entry.
- `supa down --all` warns and skips registered projects that have no
  `config.toml`, instead of refusing to stop anything.
- `supa restart` preflights the whole name list against max-active (like `up`),
  so a batch of stopped stacks cannot start the first and refuse the rest.
- `supa add` / `supa park` store absolute paths in the registry, so a relative
  path no longer breaks later invocations from another working directory.
- `supa restore --latest` recognizes `.sql.gz` dumps (and second-precision
  stamps), not only `.sql`.
- `supa restore --latest` matches only the named project's dumps — a prefix
  name (`app`) no longer steals a longer project's file (`app_web_…`).
- `supa restore --latest` prefers the newest full dump over newer typed parts
  or upgrade snapshots; falls back to typed only when no full dump exists.
- `supa config backup-dir` (and `SUPA_BACKUP_DIR` / `--out`) store/resolve
  absolute paths, same as `add` / `park`.
- `supa add` / `supa park` create the config dir and an empty registry when
  missing (first-run without an install seed); flag values (`--out`, `--db`,
  `--to`, `--slot`) require a following non-flag argument.
- Registry paths are absolutized on read; `supa doctor` flags relative roots
  and multiple `config.toml` candidates under one project.
- `supa restart` / `supa up` of stacks that are already up is allowed even when
  the host is currently over max-active (net-zero; e.g. after lowering the limit).
- `supa backup` rejects unknown flags (e.g. a typo `--data`).
- `supa pg-upgrade` / `supa restore` reject unknown flags so a mistyped
  `--dry-run` (with `--yes`) cannot become a live destructive run.
- `supa up` / `supa restart` deduplicate project names so `supa up web web`
  counts as one start under max-active (not a false refusal).
- `supa help restore` documents `--latest`'s prefer-full / typed-fallback
  behavior (aligned with `docs/SUPA.md`).
- `supa up` / `restart` / named `down` preflight `config.toml` for every name
  before mutating any stack (same as `switch`), so a registered-but-uninit
  project cannot leave earlier stacks half-applied. (`down --all` skips broken
  rows instead — see above.)
- `supa pg-upgrade` step 5 (start after volume drop) prints snapshot +
  `config.toml.bak` recovery hints on failure.
- `supa rm` refuses park-discovered names (use `unpark`); removing an explicit
  override that a parked dir still exposes warns instead of claiming a full
  unregister.
- `project_id` parsing accepts single-quoted TOML values; `destroy` refuses
  when `project_id` cannot be resolved (no silent fallback to the registry name).
- `supa add --init` applies the same slot clash / foreign-container checks as
  `ports`, and dies when no free slot remains (no silent leave-on-54321).
- `supa pg-upgrade` restore hooks after the volume drop print the same recovery
  hints as a failed start (snapshot + `config.toml.bak`).
- Slot-clash errors from `add --init` no longer advertise `--force` (unsupported
  there); `pg-upgrade` `restore.post` failures no longer claim the DB is empty.
- `supa add --init` resolves and asserts the port slot before writing the
  registry (or running init), so a clash leaves no half-applied entry.
- `supa add` may override a park-discovered name (explicit entry wins), matching
  docs / `rm` override semantics.
- Corrupt or misnamed `.sql.gz` feeds no longer make restore/pg-upgrade report
  success when psql only saw empty stdin.
- `supa park` warns when a subdir name is shadowed by an existing entry, instead
  of listing it under `discovered:`.
- `supa switch` refuses a missing/unparseable `project_id` before stopping any
  running stack (same class as destroy's null-label guard).
- `pg-upgrade` step-5 recovery hints also attach when `up.pre` / `up.post` or a
  missing Supabase CLI fails inside `startStack`.
- `ensureSigningKeysPath` (used by `rotate`) recognizes single-quoted
  `signing_keys_path` values, so it no longer inserts a duplicate path / writes
  the new key to the wrong file.
- `supa ports` auto-pick ignores the target project's own slot (and prefers it
  when free), so a full 1–9 map no longer false-refuses the project already on 9.
- `pg-upgrade` post-start recovery hints no longer advise reverting
  `config.toml` after the stack is already on the new major.
- `supa logs` matches services by service token only (not a substring of the
  project label).
- `supa unpark` parses `* |path` spacing the same way as the registry reader.
- `supa add --init` skips init when a nested `apps/*` / `examples/*` config
  already exists, so it does not scaffold a shadowing root stack.

### Changed

- Backup / pre-restore / upgrade snapshot filenames use `YYYY-MM-DD_HHMMSS`
  (seconds) so two dumps in the same minute no longer collide.
- Typed (data/schema/roles) backup filenames use `<name>+<type>_<stamp>.sql`
  (`+` is outside the project-name charset) so they cannot collide with any
  legal project name. Legacy `_type_` / `__type_` files are not selected by
  `--latest` (restore them by explicit path).

## [0.1.3] — 2026-08-07

Hardening for multi-project runs: refuse half-applied up/down lists, make
destroy volume failures visible, flag duplicate docker labels in doctor, and
stream backup dumps instead of buffering them in memory.

### Fixed

- `supa up` / `supa down` validate every name (and `up`'s max-active budget)
  before mutating any stack, so a later failure cannot leave a partial run.
- `supa destroy` reports `docker volume ls` / `rm` failures instead of claiming
  success while data volumes remain.
- `supa doctor` reports two registry names that share the same `project_id`
  (same docker label).

### Changed

- `supa backup` streams dump parts into the `.partial` file instead of holding
  the whole SQL dump in memory; on-disk layout is unchanged.

## [0.1.2] — 2026-07-28

Security hardening pass: secret files are owner-only, two injection vectors are
closed defense-in-depth, and the security policy now tells the truth about
networking and hook trust.

### Added

- `supa doctor` lists registry lines ignored by the name-charset rule, so a
  hand-edited project can't vanish silently.

### Fixed

- `supa park` no longer announces discovered subdirs the registry would reject.

### Security

- Secret-bearing files are now written owner-only (0600 on POSIX; Windows
  unaffected), tightening pre-existing files too: `supa rotate`'s private
  `signing_keys.json`, `supa env --write`'s dotenv, and `supa backup` /
  `pg-upgrade` DB dumps.
- Hand-edited registry names are validated against the same charset `supa add`
  and park discovery already enforce (`[A-Za-z0-9._-]`). Names outside it are
  skipped — they could smuggle shell expansions into bash tab-completion
  (`compgen -W` expands its wordlist).
- `supa upgrade` validates the release tag from the GitHub API (`vX.Y.Z` only)
  before building download URLs.
- `SECURITY.md` corrected: the binary does hold `--allow-net` pinned to four
  GitHub hosts (used only by `supa upgrade`); lifecycle hooks (`up.pre` etc.)
  run on every `supa up`, not just on restore — read a repo's `supa.hooks`
  before its first `supa up`.

## [0.1.1] — 2026-07-27

`supa prune` now stays inside supa's own lane: Supabase images only, and it never
deletes volumes. Before this release it could remove images belonging to anything
else sharing your Docker daemon.

**Behaviour change despite the patch number:** if you script
`supa prune --volumes` / `--all` expecting volumes to be deleted, they no longer
are — the volumes are reported with the `docker volume rm` command instead.

### Changed

- **`supa prune` is now scoped to Supabase images.** It no longer runs a host-wide
  `docker image prune`, which could remove images belonging to anything else on
  the Docker daemon (another project's service, your own local builds). Untagged
  images are attributed by repo digest — a locally built layer has none and is
  never claimed. Other projects' images are counted in the report and left alone.
- **`supa prune` no longer deletes volumes.** Orphan Supabase volumes belong to
  stacks supa doesn't manage, so it reports them plus the `docker volume rm`
  command instead of deleting on a confirmation. `--volumes` / `--all` still
  parse and now produce that report only; `supa destroy` remains the supported
  way to delete a registered stack's data.
- Image removal never passes `--force`: Docker's own refusal to delete an
  in-use image (running or stopped container) is reported, not overridden.

### Added

- `supa ports` / `supa add --init` skip a `543xX` band that a non-Supabase
  container already publishes on, and `supa doctor` reports any overlap.
- `docs/SUPA.md` documents the Docker-host scope boundary per command.

### Fixed

- Windows installer: checksum verification under PowerShell 5.1.
- `runningLabels()` now filters on `label=com.supabase.cli.project` instead of
  listing every container on the host.

## [0.1.0] — 2026-07-24

Initial public release — a thin, cross-platform CLI for running multiple local
Supabase stacks (one per project) on top of the official Supabase CLI.

### Added

- **Lifecycle** — `up`, `down [--all]`, `restart`, `switch` (stop others, run
  one), `destroy` (typed-name confirm, deletes volumes), `rotate` (new JWT
  signing key), `pg-upgrade` (Postgres major-version migration: snapshot → bump
  → rebuild → restore).
- **Data** — `backup` (full, or `--data-only` / `--schema-only` /
  `--roles-only`; atomic write), `restore` (`--latest`, single transaction,
  safety pre-dump, `.sql.gz` support), per-project `supa.hooks`
  (backup / restore / lifecycle steps).
- **Inspect** — `ls`, `status`, `stats` (CPU/RAM + budget), `logs`, `doctor`,
  `env [--write]` (dotenv merge, secret masking, optional `supa.env.map`
  rename). `--json` on `ls` / `status` / `config` for scripting.
- **Resources** — per-project `supa.limits` (per-container memory/cpu caps via
  `docker update`), `supa limit` to re-apply to a running stack, `supa prune`
  (reclaim Docker disk: images / volumes / `--dry-run`). Configurable
  `max-active` concurrency and `ram-budget`.
- **Manage** — `add [--init]` (scaffold `supabase init` + assign a free `543XX`
  band), `rm`, `ports` (re-band with a collision guard), `park` / `unpark`
  (auto-discover Supabase subdirs), `config`, `upgrade` (self-update from GitHub
  Releases, checksum-verified). `supa completion bash|zsh|pwsh`.
- **Foundation** — registry (`name|path`); Docker label + live ports derived
  from each project's `supabase/config.toml` every call. Cross-platform native
  binaries (`supa`, `supa.exe`) via `deno compile`. One-line install scripts
  with checksum verification and a signed build-provenance attestation. Unit +
  CLI integration tests; CI runs fmt / lint / check / test on Linux and Windows.

[0.1.3]: https://github.com/conanhazelnut/supa/releases/tag/v0.1.3
[0.1.2]: https://github.com/conanhazelnut/supa/releases/tag/v0.1.2
[0.1.1]: https://github.com/conanhazelnut/supa/releases/tag/v0.1.1
[0.1.0]: https://github.com/conanhazelnut/supa/releases/tag/v0.1.0
