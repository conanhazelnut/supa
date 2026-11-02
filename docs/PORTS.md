# Local Supabase — port scheme

Each project is one local Supabase stack managed by the **Supabase CLI**.
Containers, volumes and networks are isolated by `project_id`. Stock host
ports are not something you copy into git: this machine assigns them.

## Scheme

Stock host ports stay in `config.toml`. This machine picks a free slot on
`supa add --init`, `supa up`, or `supa ports` (`54421 + slot × 100`, slots
`0`–`111`) and remembers it in `~/.config/supa/slots`. That file is not part of
the project. The same numbers are written to `supabase/.env.local` for a
hand-run CLI; gitignore that file.

A host port you change away from the official default is used as written.
The other stock ports on that file are still assigned on this machine.

The service offsets inside a slot match the official template:

| SERVICE digit | Service                |
| ------------- | ---------------------- |
| `1`           | API gateway (Kong)     |
| `2`           | Postgres (direct)      |
| `3`           | Studio                 |
| `4`           | local SMTP (Mailpit)   |
| `5`           | SMTP (only if set)     |
| `6`           | POP3 (only if set)     |
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

`supa stats` shows per-stack RAM. `supa config ram-budget <gb>` makes `up`,
`restart`, and `switch` refuse when the estimate would pass it. `supa stats`
still prints the running total against that budget.

## Adding a project

1. `supa add <name> <path> --init` — registers, runs `supabase init`, and
   assigns a free slot on this machine. Stock ports stay in `config.toml`.
   (`supa add` without `--init` waits until `supa up` or `supa ports`.)
2. Edit that `config.toml` to enable only the services you use. Change a host
   port only when that one service must keep a fixed number.
3. `supa up <name>` — then `supa ls` to confirm the label and this machine's ports.
