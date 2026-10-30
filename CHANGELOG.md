# Changelog

All notable changes to `s1sdk`. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org/). While the package is `0.x`, breaking changes ship in
minor versions and are called out under **Changed**.

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

### Changed

- Examples 01 and 02 no longer build a hardcoded client: they prefer their own provider and fall
  back down the chain, so a clone with a single key runs every example.
- `X-Client` is now built from `clientHeader()` everywhere instead of a hardcoded version string
  (`typesafe`, `homestead` were pinned at `0.1.0` while the package was `0.1.1`).
- `prepublishOnly` now runs the full gate (typecheck + tests + build) rather than build + tests.
- npm tarball also ships `examples/`, `skills/`, `scripts/` and this changelog.

### Fixed

- `devx example 0` resolved to `01-*` because a numeric target matched any file starting with the
  same first character.
- Probing disabled (`S1_SKIP_PROBE=1`) returned the first unverified local candidate instead of
  only trusting explicitly configured endpoints.

## [0.1.0] — 2026-10-04

First public preview: `S1Client` (`decide`, `systemOne`, `route`), `noul` / `choice` / `score`
primitives, middleware pipeline, transparent error propagation with no mock engine, and TypeSafe,
OpenRouter, Cloudflare and Homestead/Ollama providers.
