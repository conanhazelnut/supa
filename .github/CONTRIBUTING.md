# Contributing to supa

Thanks for your interest! supa is a small, focused tool — contributions that keep
it that way are very welcome.

## Design principles (please keep these)

- **One codebase, one binary.** A thin `main.ts` dispatches into `src/` modules
  (util → parse → config → supabase → commands), compiled with `deno compile`. No
  runtime dependencies for the user beyond Docker and the Supabase CLI — supa is a
  thin coordinator, not a container runtime.
- **Cross-platform.** It must work on macOS, Linux, and Windows. Use forward
  slashes, avoid shelling through a shell (always `new Deno.Command(cmd, {args})`,
  never `sh -c`), and don't assume a Unix-only path layout.
- **Derive, don't store.** Docker labels and ports come from each project's
  `supabase/config.toml` at call time. supa's own state is just the registry
  (`name|path`) and a tiny config (`max_active`, `ram_budget_gb`).
- **Pure logic is tested.** Parsing/formatting functions are exported and covered
  in `src/lib_test.ts` (unit) and `cli_test.ts` (integration). Add a test with any
  logic change.

## Dev setup

You need [Deno](https://deno.com). Then:

```sh
deno task hooks         # one-time: install the pre-push gate (core.hooksPath)
deno task ok            # fmt --check + lint + type-check + test (run before pushing)
deno task test          # tests only
deno task dev ls        # run supa without compiling
deno task build         # compile local binaries into dist/
```

**The gate is a local pre-push hook** (`.githooks/pre-push`): `deno task hooks`
installs it once, then every `git push` runs `deno task ok` + `shellcheck` and
blocks if anything fails. GitHub Actions CI (`.github/workflows/ci.yml`) runs
the same checks on every push and PR, on both Linux and Windows.

## Pull requests

1. Keep changes small and focused; one concern per PR.
2. Run `deno task ok` locally first.
3. Add/update tests for any behaviour change.
4. Update the docs that describe the behaviour (`README.md`, `SUPA.md`,
   `PORTS.md`, and the `cmdHelp` text in `src/commands.ts`) so they stay in sync.
5. Update `CHANGELOG.md` under an `## [Unreleased]` heading.

## Releases (maintainers)

Tag `vX.Y.Z`; CI (`.github/workflows/release.yml`) cross-compiles every platform,
writes `SHA256SUMS.txt`, and attaches them to the GitHub Release. To cut one by
hand: `deno run -A build.ts release` then `gh release create vX.Y.Z dist/supa-* dist/SHA256SUMS.txt`.
