# Changelog

All notable changes to supa are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

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
