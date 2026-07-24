# Local Supabase — port scheme

Each project is one local Supabase stack managed by the **Supabase CLI**.
Containers, volumes and networks are isolated automatically by `project_id`; the
**only** thing you coordinate by hand is the **host port band** — that's what this
file is for.

`supa` reads whatever each `config.toml` declares, so the only hard rule is
**don't overlap**. A simple convention keeps that easy.

## Scheme — `543<SLOT><SERVICE>`

- **`SLOT`** (4th digit) = the project. `supa` auto-assigns a free digit `1`–`9`
  (slot `0` also works if you set it by hand).
- **`SERVICE`** (5th digit) = fixed by Supabase convention:

| SERVICE digit | Service                |
| ------------- | ---------------------- |
| `1`           | API gateway (Kong)     |
| `2`           | Postgres (direct)      |
| `3`           | Studio                 |
| `4`           | Inbucket / Mailpit     |
| `7`           | Analytics              |
| `0`           | DB shadow              |
| `8`           | Edge runtime inspector |
| `9`           | Pooler                 |

So Postgres for slot `2` = `543` + `2` + `2` = **54322**.

> The edge runtime `inspector_port` defaults to `8083` (off-scheme). `supa ports`
> pulls it into `543<slot>8` so it can't collide across projects.

`supa ls` is the live source of truth for who owns which ports and what's UP.
`supa ports <name> [slot]` re-bands a project's `543XX` ports to a free slot, and
`supa doctor` flags any collisions.

## Allocation (example — keep in sync as you add projects)

| Project  | Slot | Band      | API   | Postgres | Studio                       |
| -------- | ---- | --------- | ----- | -------- | ---------------------------- |
| web      | 1    | `5431X`   | 54311 | 54312    | 54313                        |
| api      | 2    | `5432X`   | 54321 | 54322    | 54323                        |
| _(free)_ | 3…9  | `5433X` … |       |          | reserved for future projects |

> `supa` also resolves a `supabase/config.toml` that lives under `apps/<x>/` or
> `examples/<x>/`, not just the repo root — handy for monorepos.

## Trim each stack to what it uses

A stack only needs to run the services its app actually calls; disabling the rest
saves RAM (an untrimmed stack is ~12 containers / ~1.8 GiB). In that project's
`config.toml`:

```toml
[api]
enabled = false      # PostgREST — off if you talk to Postgres directly
[studio]
enabled = false      # open only when you need the UI
[analytics]
enabled = false
[edge_runtime]
enabled = false
```

`supa stats` shows per-stack RAM; `supa config ram-budget <gb>` warns when the
running total exceeds your budget.

## Adding a project

1. Pick a free slot (see the table); `supa doctor` will flag overlaps.
2. `supa add <name> <path> --init` — registers, runs `supabase init`, and assigns
   a free band. (Or `supa add <name> <path>` then `supa ports <name>` for a repo
   that already has `supabase/`.)
3. Edit that `config.toml` to enable only the services you use.
4. `supa up <name>` — then `supa ls` to confirm the derived label + ports.
