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
- **Least privilege.** The compiled binary requests only
  `--allow-read --allow-write --allow-env --allow-run`.
- **Secrets stay local.** `supa env --write` writes into your project's dotenv
  and masks secrets in its console output; `supa rotate` reminds you to gitignore
  the private `signing_keys.json`. supa never transmits any of this anywhere.
- **Release integrity.** Every release ships `SHA256SUMS.txt`. The install script
  verifies the downloaded binary against it before installing. Binaries are not
  code-signed yet (see the README for the macOS/Windows first-run note).

## Trust boundaries

supa operates entirely on your machine against your own registry, project
configs, and local Docker. It has no network calls of its own beyond the install
script fetching a release binary over HTTPS.
