# Changelog

All notable changes to supa are documented here. This project adheres to
[Semantic Versioning](https://semver.org/) and
[Keep a Changelog](https://keepachangelog.com/).

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
