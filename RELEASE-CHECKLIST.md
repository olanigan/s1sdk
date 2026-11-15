# Release checklist — `s1sdk`

The automated gate covers code, artifact and dependency surface. The steps marked **human** cannot
be delegated to an agent: tagging, publishing, merging and deprecating are human actions.

A check that cannot be run is recorded as **skipped**, never as passed.

## 0. Preconditions

- [ ] Working tree is clean and you are on the release branch (`git status -sb`).
- [ ] `package.json` version and `CHANGELOG.md` agree, with no leftover `Unreleased` section.
- [ ] The release branch is merged into `main` before tagging. `.github/workflows/release.yml`
      publishes from a `v*` tag, and the tag must equal `package.json` (the workflow asserts this).

## 1. Automated gate (must be green)

```bash
bun install --frozen-lockfile
bun run check                     # typecheck + test:coverage + build
```

- [ ] Typecheck passes (`tsc --noEmit`, `strict` + `noUncheckedIndexedAccess`).
- [ ] 204 tests pass, including `test/package-smoke.test.ts`.
- [ ] Coverage thresholds pass: ≥85% statements/lines, ≥78% branches, ≥85% functions over `src/`
      (`vitest.config.ts`). Report is uploaded as the `coverage` CI artifact.
- [ ] `bun run build` produced `dist/index.{js,cjs,d.ts}` and `dist/providers/index.{js,cjs,d.ts}`.

If coverage fails, add tests. Do not lower the thresholds to make the gate green.

## 2. Dependency surface

```bash
bun audit --production                       # CI job: supply-chain
node -e "const p=require('./package.json');const d=Object.keys(p.dependencies||{});if(d.length){console.error(d);process.exit(1)}"
```

- [ ] `No vulnerabilities found`.
- [ ] `dependencies` is still `{}`. A runtime dependency is an architectural decision, not a
      version bump — it needs review before it lands.
- [ ] Optional, if `osv-scanner` is installed: `osv-scanner scan source -r .`.

> `.onecoder/policy.toml` is agent-write-protected and its `supply_chain.scanner_cmd` is empty, so
> OneCoder's supply-chain triage reports **skipped** (`on_missing_scanner = "warn"`). The two checks
> above are the substitute; a human owns executing them.

## 3. Cloudflare contract fixtures (manual, network)

Workers AI models are previews: schemas and error codes drift. Re-capture **before every release**
following `test/fixtures/contracts/cloudflare-rest/README.md`, then:

- [ ] Update the capture date and the table in that README if anything changed.
- [ ] `git diff` the fixtures; a diff is a wire-contract change and must be reviewed, not rubber-stamped.
- [ ] `bunx vitest run test/cloudflare-rest-transport.test.ts test/cloudflare-clairic.test.ts`.

## 4. Live provider smoke (manual, credentials)

CI never holds provider keys. Run one real decision per provider you claim to support:

```bash
just doctor                       # which credentials/daemons are visible, and who wins
just smoke typesafe
just smoke openrouter
just smoke cloudflare             # or: just worker-dev, then S1_PROVIDER=cloudflare just smoke
just smoke ollama
just smoke homestead
```

- [ ] Each smoke prints a decision, latency and token counts (no mocks, no fixtures).
- [ ] Record provider, model, wall-clock latency, tokens and the date in the release PR.
- [ ] `bun run devx examples` runs every provider-agnostic example.

## 5. Artifact inspection

```bash
npm publish --dry-run --access public      # or: just pack / make pack
```

- [ ] ~97 files, ~135 kB packed, ~600 kB unpacked.
- [ ] Contains `dist/` (both formats + declarations), `src/`, `examples/`, `skills/`, `scripts/`,
      `CHANGELOG.md`, `README.md`, `LICENSE`.
- [ ] Contains no `test/`, `.env*`, `node_modules/`, `.wrangler/`, or sqlite files.

## 6. Tag and publish (**human**)

- [ ] Merge the release branch into `main` and push `main`.
- [ ] `git tag -a vX.Y.Z -m "s1sdk vX.Y.Z" && git push origin vX.Y.Z`
- [ ] Release workflow: gate → tag/version match → `npm publish --access public --provenance`.
      Preferred auth is npm trusted publishing (OIDC); `NPM_TOKEN` is the documented fallback.
- [ ] `workflow_dispatch` with `dry_run: true` is the rehearsal path — it packs but does not upload.

## 7. Post-publish verification

```bash
npm view s1sdk@X.Y.Z version dist.integrity dist.attestations
T=$(mktemp -d) && cd "$T" && npm init -y >/dev/null && npm i s1sdk@X.Y.Z --no-audit --no-fund
node -e "const s=require('s1sdk'); if(typeof s.S1Client!=='function') process.exit(1); console.log('cjs ok')"
node --input-type=module -e "import { S1Client } from 's1sdk'; if(typeof S1Client!=='function') process.exit(1); console.log('esm ok')"
```

- [ ] Version, integrity hash and provenance attestation are visible on the registry.
- [ ] The freshly published tarball installs and loads under both module systems.

## 8. If the release is wrong

- [ ] `npm deprecate s1sdk@X.Y.Z "reason"` and publish a patch. Never delete or re-tag a published
      version; consumers may already have pinned it.
