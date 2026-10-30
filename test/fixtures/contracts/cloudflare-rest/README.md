# Cloudflare Workers AI — REST transport envelopes

Dated, **verbatim** response bodies from
`POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/{model}`,
captured with a live account-scoped token on **2026-10-29**.

These are **transport envelopes**, not model schemas. Model input/output schemas live
one directory up (`clairic-input.json`, `clairic-output.json`). The two fixture sets
answer different questions:

| Fixture set | Question it answers |
|---|---|
| `../clairic-*.json` | Is our *payload* shaped like the published model contract? |
| `cloudflare-rest/*.json` | Is our *dispatch* handling the HTTP envelope, status, and error taxonomy correctly? |

The decisive property, verified here: **`envelope.result` is byte-for-byte the same
object shape that `env.AI.run()` returns.** That is why one normalizer can serve both
transports, and why `test/cloudflare-rest-transport.test.ts` can assert parity between
them using these files.

## Captured cases

| File | HTTP | `success` | `errors[0].code` | Notes |
|---|---|---|---|---|
| `clairic-extract-success.json` | 200 | `true` | — | text/number/date/list/estimate; `reference_date` honoured (`"March 4"` → `2026-03-04`); `usage.passes: 3` |
| `clef-flash-decision-success.json` | 200 | `true` | — | choice (dict criteria) + score; `usage` has only `input_tokens`/`output_tokens` |
| `error-401-bad-token.json` | 401 | `false` | `10000` | `Authentication error` |
| `error-400-bad-field-type.json` | 400 | `false` | `5006` | `enum bogus-type not in text,number,…` |
| `error-400-unknown-model.json` | 400 | `false` | `7000` | `No route for that URI` |
| `error-400-missing-required-keys.json` | 400 | `false` | `5006` | required property names echoed back |
| `error-400-choice-criteria-array.json` | 400 | `false` | `5006` | **see landmine below** |

## Landmines these fixtures exist to prevent

1. **`choice.criteria` must be a dictionary.** Passing an array
   (`"criteria": ["refund", "replacement"]`) returns HTTP 400 code `5006` with
   *"required properties at '/' are 'model,state,questions'"* — a message that blames
   the root object, which is in fact correct. Anyone debugging from the server message
   will "fix" the wrong thing. `sanitizeQuestionsForCloudflare` therefore rejects array
   criteria client-side with a `JevValidationError` naming the real shape.
2. **`success: false` is not always accompanied by a non-2xx status**, so the transport
   must inspect the envelope before trusting `res.ok`. Only the 4xx cases here were
   capturable; the 200-with-`success:false` branch is handled defensively and tested
   with a synthetic fixture in the unit suite rather than claimed as observed.
3. **`errors[0].code` is the stable identifier; `message` is prose and drifts.** Mapping
   keys on `code` + HTTP status, and treats `message` as display text only.
4. **`result` is `{}` on some errors and `null` on others.** Never `Object.keys(result)`
   without a null/empty guard.
5. **`usage.passes: 3`** in the extract fixture is the standing counter-example to the
   "single forward pass" marketing claim. Cost math must use it.

## Re-capture policy

All Workers AI models are previews; schemas and error codes drift. Re-capture **before
a release**, diff the result, and update this table and the capture date together:

```bash
set -a; . ./.env; set +a
BASE="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/run"

# success (extraction)
curl -sS -X POST "$BASE/@cf/cloudflare/clairic" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"model":"clairic","state":"Acme Health Inc.\nInvoice INV-1042","fields":{"a":{"type":"text"}}}'

# auth failure (deliberately bad token — must never use the real one)
curl -sS -X POST "$BASE/@cf/cloudflare/clairic" \
  -H "Authorization: Bearer not-a-real-token" -H 'Content-Type: application/json' \
  -d '{"model":"clairic","state":"x","fields":{"a":{"type":"text"}}}'
```

Fixtures contain no credentials. Do not add `cf-ray`, account IDs, or timestamps to the
bodies — they make diffs unreadable and are not part of the contract.
