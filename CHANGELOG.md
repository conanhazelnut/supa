# Changelog

All notable changes to supa are documented here. This project adheres to
[Semantic Versioning](https://semver.org/) and
[Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

- Unit test suite (`supa_test.ts`) for the parsing/formatting core.
- CI (`ci.yml`): fmt, lint, type-check, test, and shellcheck on every push/PR.
- Release integrity: `SHA256SUMS.txt` published with each release and verified by
  the install script; build provenance attestation.
- `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue/PR templates.

### Fixed

- `supa ports` / `add --init` now re-band the edge runtime `inspector_port`
  (default `8083`) into `543<slot>8`, preventing a cross-project collision.

## [0.1.0] — 2026-07-13

Initial release.

### Added
- Manage multiple local Supabase stacks (one per project) via the Supabase CLI —
  no hand-rolled Docker Compose.
- Registry (`name → repo root`); Docker label + live ports derived from each
  project's `supabase/config.toml`.
- **Lifecycle**: `up`, `down [--all]`, `restart`, `switch`, `destroy`
  (typed-name confirm), `rotate` (new JWT signing key).
- **Inspect**: `ls`, `status`, `stats` (CPU/RAM + budget), `logs`, `doctor`,
  `env` (+ `--write` into a dotenv, optional `supa.env.map` rename).
- **Manage**: `add` (+ `--init`), `rm`, `ports` (re-band), `config`.
- Configurable `max-active` concurrency and `ram-budget`.
- Cross-platform: one `supa.ts` compiled to native binaries (`supa`, `supa.exe`).
- **Install**: one-line install scripts (`install.sh` / `install.ps1`) that fetch
  prebuilt binaries; CI (`.github/workflows/release.yml`) builds every platform
  on a version tag and attaches them to the GitHub Release.
