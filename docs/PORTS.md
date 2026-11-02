# Local Supabase — port scheme

Each project is one local Supabase stack managed by the **Supabase CLI**.
Containers, volumes and networks are isolated automatically by `project_id`; the
**only** thing you coordinate by hand is the **host port band** — that's what this
file is for.

`supa` reads whatever each `config.toml` declares, so the only hard rule is
**don't overlap**. A simple convention keeps that easy.

## Scheme

Stock `config.toml` ports (the `54321` set, including `inspector_port = 8083`)
are not rewritten. `supa` remembers a slot in `<project>/.supa/ports` and passes
it to the Supabase CLI as environment variables. Slot `0` is API `54421`,
Postgres `54422`, Studio `54423`; each next slot adds `100`. Slots run `0`–`111`.

A host port that was edited into `54300`–`54399`, or any other non-stock value,
is a committed band. `supa` uses the file and does not overlay it.

The service offsets inside a slot match the official template:

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

Postgres for slot `2` is **54622** (`54422 + 2×100`). Inspector for that slot is **54628**.

`supa ls` shows the effective ports. `supa ports <name> [slot]` moves an auto slot
and does not edit `config.toml`. `supa doctor` flags collisions.

## Allocation (example)

| Project | Slot | API   | Postgres | Studio |
| ------- | ---- | ----- | -------- | ------ |
| web     | 0    | 54421 | 54422    | 54423  |
| api     | 1    | 54521 | 54522    | 54523  |

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
