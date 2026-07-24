# Changelog

All notable changes to supa are documented here. This project adheres to
[Semantic Versioning](https://semver.org/) and
[Keep a Changelog](https://keepachangelog.com/).

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

[0.1.0]: https://github.com/conanhazelnut/supa/releases/tag/v0.1.0
