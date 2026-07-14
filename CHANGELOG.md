# Changelog

All notable changes to supa are documented here. This project adheres to
[Semantic Versioning](https://semver.org/) and
[Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

- `supa backup <p>` — dump the local DB to a timestamped `.sql`. Default is a full
  snapshot (roles + schema + data); `--data-only` / `--schema-only` / `--roles-only`
  for a single part, plus `--use-copy` and `--out <dir>`. Atomic write (temp →
  rename); the stack must be up. Restore (`supa restore`) is planned next.
- `supa config backup-dir <path>` (and `SUPA_BACKUP_DIR`) — set where dumps land.
  Resolution: `--out` → `backup_dir` → `<project-root>/backups/`.

## [0.1.0] — 2026-07-13

Initial release.

### Added

- Manage multiple local Supabase stacks (one per project) via the Supabase CLI —
  no hand-rolled Docker Compose.
- Registry (`name → repo root`); Docker label + live ports derived from each
  project's `supabase/config.toml`.
- **Lifecycle**: `up`, `down [--all]`, `restart`, `switch`, `destroy`
  (typed-name confirm), `rotate` (new JWT signing key, written as a JWK array).
- **Inspect**: `ls`, `status`, `stats` (CPU/RAM + budget), `logs`, `doctor`,
  `env` (+ `--write` into a dotenv, optional `supa.env.map` rename), `version`.
- **Manage**: `add` (+ `--init` / `--slot`), `rm`, `ports` (re-band, incl. the
  edge `inspector_port`), `config`.
- Configurable `max-active` concurrency and `ram-budget`.
- Cross-platform: TypeScript (`main.ts` + `src/`) compiled to native binaries
  (`supa`, `supa.exe`).
- **Install**: one-line install scripts (`install.sh` / `install.ps1`) that fetch
  and **checksum-verify** prebuilt binaries (fail-closed); CI builds every
  platform on a version tag, publishes `SHA256SUMS.txt`, and attaches a
  build-provenance attestation.
- Unit + CLI integration test suite; CI runs fmt, lint, type-check, test, and
  shellcheck on every push/PR.
- `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue/PR templates.

[0.1.0]: https://github.com/conanhazelnut/supa/releases/tag/v0.1.0
