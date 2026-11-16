# Changelog

All notable changes to `s1sdk`. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org/). While the package is `0.x`, breaking changes ship in
minor versions and are called out under **Changed**.

## [Unreleased]

### Added

- **`devx` provider picker**: when more than one provider is usable in an interactive terminal,
  `devx` now asks which one to run against instead of silently taking the first rung of the
  preference ladder. `--pick`/`--select` forces the prompt, `--no-pick`/`--auto` keeps the ladder,
  and `--provider`/`S1_PROVIDER` still bypass it as a strict pin. Backed by a new
  `listProviderChoices()` resolver helper that reports each candidate's readiness.

## [0.1.1] — 2026-10-30

Experimental developer preview. Wire specs and model identifiers may still change.

### Added

- **`client.extract()` / Clairic structured extraction** carried over from #3: typed fields with
  calibrated confidence, `p_null`, and character spans. Requires Cloudflare Workers AI
  (`env.AI` binding or REST); `extract()` refuses to swap a decision model for Clairic implicitly.
- **Cloudflare transport seam**: one vendor, two transports (`binding` in-process, `rest`), chosen
  once at construction with no silent cross-transport fallback.
- **`devx` developer entrypoint** (`bun run devx`, `scripts/devx.ts`): one command for the whole
  local loop — `doctor` (which credentials and daemons are visible, and which provider wins),
  `smoke` (one real decision with latency and token counts), `example <id>`, `examples`.
- **Env-driven provider resolver** (`examples/shared/provider.ts`): strict priority
  TypeSafe → OpenRouter → Cloudflare → local Ollama → local Homestead, with a reachability probe
  before any local daemon is selected. `S1_PROVIDER` pins a backend without code changes and
  `S1_MODEL` overrides the default model.
- **`examples/00-quickstart.ts`**: provider-agnostic example that runs with no credentials.
- **`justfile` and `Makefile`**: identical targets (`doctor`, `smoke`, `example`, `examples`,
  `check`, `pack`, `release`) for whichever task runner the developer already has.
- **`.env.example`**: one annotated block per provider, plus the optional `S1_*` tuning variables.
- **Agent skill** (`skills/s1sdk/SKILL.md`): when a task is a System-1 decision, how to gate on
  calibrated confidence, how to read a result honestly, and the failure modes to check first.
- 19 new tests covering env loading, secret masking, candidate ordering, strict pinning, probe
  behaviour and offline fallback (128 total).
- **Release QA surface**: 76 further tests for `S1Judge` arbitration, OpenRouter/TypeSafe
  dispatch and error taxonomy, provider `decide()`/health aliases, and a packaged-artifact smoke
  test that packs the tarball, installs it, and exercises `require()`, `import()` and `tsc`
  (204 total).
- **[`RELEASE-CHECKLIST.md`](./RELEASE-CHECKLIST.md)**: the human + automated steps between a green
  branch and a published version, including fixture re-capture and live provider smoke.

### Changed

- Examples 01 and 02 no longer build a hardcoded client: they prefer their own provider and fall
  back down the chain, so a clone with a single key runs every example.
- `X-Client` is now built from `clientHeader()` everywhere instead of a hardcoded version string
  (`typesafe`, `homestead` were pinned at `0.1.0` while the package was `0.1.1`).
- `prepublishOnly` now runs the full gate (typecheck + tests + build) rather than build + tests.
- `bun run check` enforces coverage thresholds (`vitest.config.ts`: ≥85% statements/lines, ≥78%
  branches, ≥85% functions over `src/`); CI adds a Node 18/20/22 matrix and a dependency-surface
  job (zero runtime dependencies + `bun audit --production`).
- npm tarball also ships `examples/`, `skills/`, `scripts/` and this changelog.

### Fixed

- `S1Judge` matched destructive keywords as substrings of the proposed choice, so a read turn
  proposing `confirm` (contains `rm`) or `performance_report` was penalised as destructive, and
  `skill_lookup` matched `kill`. Keywords now match on normalized token boundaries, while
  `delete_file`, `deleteAll`, `drop-table` and `rm` are still detected.
- `devx example 0` resolved to `01-*` because a numeric target matched any file starting with the
  same first character.
- Probing disabled (`S1_SKIP_PROBE=1`) returned the first unverified local candidate instead of
  only trusting explicitly configured endpoints.

## [0.1.0] — 2026-10-04

First public preview: `S1Client` (`decide`, `systemOne`, `route`), `noul` / `choice` / `score`
primitives, middleware pipeline, transparent error propagation with no mock engine, and TypeSafe,
OpenRouter, Cloudflare and Homestead/Ollama providers.
