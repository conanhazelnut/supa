# Quick start — zero to a running stack in ~10 minutes

supa has a short command list, but your first day needs six. This walkthrough takes you
from nothing to one running Supabase stack, with expected output at each step so
you know it worked. Everything else lives in `supa help` and the
[full guide](./SUPA.md).

## 0 · Prerequisites

Two things must be installed (supa itself needs nothing else):

- **[Docker](https://www.docker.com/)** — Desktop or Engine, and it must be
  _running_.
- **[Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started)**
  — supa wraps it; every container is still owned by the official CLI.

## 1 · Install supa

Downloads a prebuilt, checksum-verified binary — no compiler, no Deno.

**macOS / Linux**

```sh
curl -fsSL https://raw.githubusercontent.com/conanhazelnut/supa/main/install.sh | sh
```

**Windows (PowerShell)**

```powershell
irm https://raw.githubusercontent.com/conanhazelnut/supa/main/install.ps1 | iex
```

## 2 · Check your environment

```sh
supa doctor
```

Expected (versions will differ):

```text
supa doctor
  ✓ docker daemon        v28.0.1
  ✓ supabase CLI         2.30.4
  ✓ registry             /Users/you/.config/supa/supa.registry
  ✗ projects registered  0
  ✓ registry names valid
  ✓ registry paths absolute
  ✓ no port collisions
  ✓ no duplicate project_id labels
  · max_active = 1 (default)
```

The `✗` on `projects registered` is expected — you haven't registered one yet;
that's the next step. A `✗` on the first two lines means Docker isn't running
or the Supabase CLI isn't on your PATH — fix that before continuing.

## 3 · Register a project

The registry maps a friendly name → a project's repo root. Pick whichever fits:

```sh
# a) You already have a project with supabase/config.toml in it:
supa add web ~/code/web

# b) Brand new — scaffold `supabase init` and assign a free slot on this machine:
supa add myapp ~/code/myapp --init

# c) Every immediate subdirectory that already has supabase/config.toml:
supa park ~/code
```

## 4 · Start it

```sh
supa up web
```

You'll see `>> starting web  (/Users/you/code/web)` followed by the Supabase
CLI's own output. **The first start pulls Docker images — give it a few minutes**; when
it finishes, the CLI prints your stack's URLs and keys.

By default only **one** stack runs at a time (`max_active = 1`, sane for
RAM-bound laptops). Raise it with `supa config max-active 2`.

## 5 · Verify

```sh
supa ls
```

```text
NAME     LABEL     API     DB      STUDIO  STATUS  ROOT
api      api       54521   54522   54523   down    /Users/you/code/api
web      web       54421   54422   54423   UP      /Users/you/code/web
```

Open Studio at `http://127.0.0.1:<STUDIO port>` — here `54423`. Those numbers
are this machine's slot (`54421 + slot×100`), not the `54321` written in
`config.toml`. See [PORTS.md](./PORTS.md).

## 6 · Wire your app to it

```sh
supa env web            # print the stack's env vars (API URL, keys, DB URL)
supa env web --write    # merge them into the project's .env.local
```

## Daily driving

```sh
supa switch api      # stop other registered stacks, run only this one
supa down web        # stop a stack (down --all stops every registered one)
supa stats           # CPU/RAM per stack + total
supa logs web db -f  # follow one service's logs
```

## Where to go next

- `supa help` / `supa help <command>` — the command reference.
- `supa completion bash|zsh|pwsh` — tab-completion, including project names.
- **[SUPA.md](./SUPA.md)** — the mental model, backups/restore, Postgres
  upgrades, resource limits, hooks, troubleshooting.
- **[PORTS.md](./PORTS.md)** — the port scheme in depth.
