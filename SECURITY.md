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

- **No shell.** supa runs `docker` / `supabase` via `new Deno.Command(cmd, {args})`,
  never through a shell — registry paths and project names can't be used for
  command injection.
- **Scoped permissions, no network.** The compiled binary requests
  `--allow-read --allow-write --allow-env --allow-run` and **not** `--allow-net`
  — it reads/writes your configs and runs `docker` / `supabase`, and makes no
  network calls of its own.
- **Secrets stay local.** `supa env --write` writes into your project's dotenv
  and masks secrets in its console output; `supa rotate` reminds you to gitignore
  the private `signing_keys.json`. supa never transmits any of this anywhere.
- **Release integrity.** Every release ships `SHA256SUMS.txt`, and both install
  scripts (`install.sh`, `install.ps1`) verify the downloaded binary against it
  before installing. Release binaries also carry a signed build-provenance
  attestation — verify it with
  `gh attestation verify <binary> --repo conanhazelnut/supa`. Binaries are not
  yet OS-code-signed (see the README for the macOS/Windows first-run note).

## Trust boundaries

supa operates entirely on your machine against your own registry, project
configs, and local Docker. It has no network calls of its own beyond the install
script fetching a release binary over HTTPS.
