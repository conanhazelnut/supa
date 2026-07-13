# supa — roadmap

Feature backlog, largely inspired by **[osobh/multibase](https://github.com/osobh/multibase)**
(a heavier "run many self-hosted Supabase instances" tool with a web dashboard).

## Guiding principle — stay a thin CLI

Multibase's reach is also its weight: React dashboard + Node backend + Python CLI

- its own Docker Compose. supa's value is the opposite — a single binary that
  **wraps the official Supabase CLI**. Adopt Multibase's _capabilities_ without its
  _bulk_: prefer CLI/TUI over a web app, derive-don't-store, and lean on `supabase`
- `docker` instead of reimplementing them.

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

- secret masking). All shipped and tested (fake-shim + real smoke).

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

### M4 — Distribution & scale (🟡 / 🔬)

- GitHub Releases for the binaries (instead of copying `dist/supa.exe` by hand).
- 🔬 Optional TUI dashboard. 🔬 Optional compose-based self-hosted track.

---

## Open questions

- **Metrics depth** — is point-in-time `docker stats` enough, or keep history
  (which pulls toward Multibase's heavier storage)?
- **`rotate` scope** — signing-key rotation covers JWT; do we also want a path to
  rotate storage S3 keys / DB password locally?
