# Contract fixtures

Dated snapshots of the upstream JSON Schemas that `s1sdk` validates against.
Fixtures are committed so contract tests fail locally when the SDK drifts from
the published contract, without a network fetch in CI.

| File | Source | Fetched |
|---|---|---|
| `clairic-input.json` | https://developers.cloudflare.com/workers-ai/models/clairic/schema-input.json | 2026-10-28 |
| `clairic-output.json` | https://developers.cloudflare.com/workers-ai/models/clairic/schema-output.json | 2026-10-28 |

Re-fetch before a release and diff against these snapshots:

```bash
curl -s https://developers.cloudflare.com/workers-ai/models/clairic/schema-input.json \
  | diff - test/fixtures/contracts/clairic-input.json
curl -s https://developers.cloudflare.com/workers-ai/models/clairic/schema-output.json \
  | diff - test/fixtures/contracts/clairic-output.json
```

All Cloudflare Workers AI models are previews; a diff is expected over time.
Update the fixture and the fetch date together, and update the contract tests
that encode the change.
