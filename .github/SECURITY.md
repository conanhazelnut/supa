# Security Policy

## Reporting a vulnerability

Please report security issues **privately** via GitHub Security Advisories:
[Report a vulnerability](https://github.com/conanhazelnut/supa/security/advisories/new).
Do not open a public issue for a security problem.

You can expect an initial response within a few days.

## Supported versions

Only the latest release receives fixes. supa is pre-1.0; expect breaking changes
between minor versions.

## Security model

- **No shell — with one deliberate exception.** supa runs `docker` / `supabase`
  via `new Deno.Command(cmd, {args})`, never through a shell — registry paths and
  project names can't be used for command injection. The exception is a project's
  own hooks (`supa.hooks`): those commands **are** run with the system shell
  (`sh -c` / `cmd /c`) in the project directory, by design — see
  [Trust boundaries](#trust-boundaries).
- **Scoped permissions, no phoning home.** The compiled binary requests
  `--allow-read --allow-write --allow-env --allow-run`, plus `--allow-net`
  pinned to four GitHub hosts (`api.github.com`, `github.com`,
  `objects.githubusercontent.com`, `release-assets.githubusercontent.com`) used
  by exactly one command — `supa upgrade`, the checksum-verified self-update —
  and only when you run it. No other command touches the network; there is no
  telemetry.
- **Scoped Docker operations.** Every container / volume / image operation is
  filtered by the Supabase CLI's project label or a Supabase image repository —
  other workloads sharing the Docker daemon are never stopped, capped, or
  pruned. See
  [SUPA.md — Scope](../docs/SUPA.md#scope--what-supa-touches-on-your-docker-host).
- **Secrets stay local.** `supa env --write` writes into your project's dotenv
  and masks secrets in its console output; `supa rotate` reminds you to gitignore
  the private `signing_keys.json`. supa never transmits any of this anywhere.
- **Release integrity.** Every release ships `SHA256SUMS.txt`, and both install
  scripts (`install.sh`, `install.ps1`) verify the downloaded binary against it
  before installing. Release binaries also carry a signed build-provenance
  attestation — verify it with
  `gh attestation verify <binary> --repo conanhazelnut/supa`. Binaries are not
  yet OS-code-signed (see SUPA.md for the macOS/Windows first-run note).

## Trust boundaries

supa operates entirely on your machine against your own registry, project
configs, and local Docker. Its only network calls are the install scripts and
`supa upgrade`, both fetching releases from GitHub over HTTPS.

**Registering a project means trusting its repo.** A project's `supa.hooks` are
shell commands supa executes in that project's directory: `up.pre` / `up.post`
and `down.pre` / `down.post` run on every `supa up` / `supa down` (also via
`restart`, `switch`, `rotate`, `pg-upgrade`), and `restore.pre` /
`restore.post` run on `supa restore` and `supa pg-upgrade`. That is the same
trust you extend to a repo's Makefile or npm scripts — don't register or park a
repo you wouldn't run scripts from, and read its `supa.hooks` **before the
first `supa up`** of a freshly cloned project. supa prints each hook command
before running it.
