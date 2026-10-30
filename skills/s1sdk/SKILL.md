---
name: s1sdk
description: Use when a workflow needs a bounded, calibrated decision instead of generated text — intent routing, ticket triage, tool selection, priority scoring, or structured field extraction from a document. Wraps System-1 (single forward pass, zero output tokens) models behind one TypeScript API across TypeSafe AI, OpenRouter, Cloudflare Workers AI (binding or REST), and local Ollama/Homestead. Triggers: route this to one of N actions, classify this into a fixed set, score this 1-5, extract these fields with confidence, gate on calibrated confidence, pick a provider without changing code. Not for open-ended summarisation, drafting, or multi-step reasoning.
version: 0.1.1
---

# s1sdk — System-1 decisions from an agent

A System-1 model evaluates `state` against JSON-schema questions in one forward pass and returns
calibrated numbers. It emits **zero generation tokens**, so `usage.outputTokens === 0` is the
signature of a real decision and a mocked one is obvious immediately.

Reach for it when the answer is one of a finite set, a probability, or an ordinal score. Reach for a
frontier LLM when the answer is prose or requires chaining steps.

## 1. The decision, not the code

Before writing anything, decide which primitive the task actually is:

| Task shape | Primitive | Answer field |
|---|---|---|
| yes/no with a probability (churn risk, is this malicious, is this in scope) | `noul` | `.noul` `[0,1]` |
| one of N labelled options (department, tool, intent, tier) | `choice` | `.choice`, `.confidence`, `.probabilities` |
| ordinal 1–5 (priority, severity, urgency) | `score` | `.score`, `.confidence` |
| typed fields out of a document (invoice, ticket, contract) | `extract*` | `.value`, `.confidence`, `.span` |

If a proposed question has no finite answer set, it is not a System-1 question. Escalate the design
instead of encoding a prompt.

```ts
import { S1Client, noul, choice, score } from 's1sdk';

const s1 = new S1Client(); // provider resolved from env; see §3

const { answers } = await s1.decide({
  state: { ticketId: 'TCK-9481', tier: 'enterprise', message: '…double charge…' },
  questions: {
    is_escalation_risk: noul('Is the customer threatening churn or legal action?'),
    target_department: choice('Route to department', {
      billing: 'Refunds, disputes, double charges',
      technical_support: 'Outages, bugs, integration defects',
      retention: 'Cancellation threats, downgrades',
      general_inquiry: 'Docs, receipts, account settings'
    }),
    priority_level: score('Priority 1–5', [1, 2, 3, 4, 5])
  }
});

answers.target_department.choice;      // "billing"
answers.target_department.confidence;  // 0.97 — calibrated
answers.is_escalation_risk.noul;       // 0.96
```

Criteria strings are the class definitions the model tests against. Vague criteria produce
miscalibrated confidence, not errors — the failure is silent in the output and loud in the audit.

## 2. Gate on confidence, never on the winner alone

`choice` always returns a winner. Low confidence means the winner is noise.

```ts
const decision = await s1.decide({ state, questions });
const { choice: winner, confidence } = decision.answers.target_department;

if (confidence >= 0.90) {
  await dispatch(winner);
} else {
  await escalateToHuman(decision.answers.target_department.probabilities);
}
```

`client.route(state, candidates)` does the same in one call and returns
`{ winner, confidence, probabilities, passedGate }` with `minConfidence` (default `0.90`) applied.
Use it for tool dispatch; use `decide` when several questions must be answered in one pass.

## 3. Provider selection without code changes

One API, five backends. Credentials pick the backend; `S1_PROVIDER` pins it.

```bash
TYPESAFE_API_KEY=…                # hosted REST, ~35ms
OPENROUTER_API_KEY=…              # hosted REST, ~45ms
CLOUDFLARE_API_TOKEN=… + CLOUDFLARE_ACCOUNT_ID=…   # Workers AI over REST
# inside a Worker: new S1Client({ aiBinding: env.AI })  → in-process, zero egress
OLLAMA_HOST=127.0.0.1:11434       # local, free, out=0 tokens
HOMESTEAD_API_URL=http://127.0.0.1:8080
```

Rules that hold across all five:

* `answers` has the same shape everywhere — swapping providers must not change call sites.
* Set `timeoutMs: 30000` for Ollama; the first call loads the model.
* Do **not** supply a mock provider to "make the example pass". A failed provider must throw
  (`JevProviderError`, `JevTimeoutError`, `JevAuthenticationError`). Recover with `onError`
  middleware and set `isFallback: true`, so the receipt shows the decision was not model-derived.

## 4. Structured extraction (Clairic)

```ts
import { extractText, extractNumber, extractDate, extractList, extractEstimate } from 's1sdk';

const { answers } = await s1.extract({
  state: invoiceText,
  fields: {
    vendor: extractText('Vendor organisation'),
    total: extractNumber({ decimals: 2, unit: 'USD' }),
    issuedDate: extractDate('Issue date'),
    lineItems: extractList('text', 'Purchased items'),
    confidenceBand: extractEstimate(0, 1, { step: 0.01 })
  },
  model: 'clairic'   // required: extract() never swaps a decision model for Clairic
});
```

Each answer carries `value`, `confidence`, `p_null` and a `span: [start, end]` into `state`.
`confidence` and `p_null` are **omitted** by Clairic for `estimate`/`forecast` answers; treat an
absent score as "not reported", never as 1.0. Extraction requires Cloudflare (`binding` or REST).

## 5. Reading a result honestly

* `latencyMs` is the provider's number; measure wall-clock separately before quoting speedups.
* `transport` (`binding` / `rest` / `local-http`) tells you whether the call left the process.
  Never compare latency across transports without saying which one ran.
* `usage.outputTokens === 0` proves no generation happened. `0` on a hosted provider is the
  expected value for System-1, not a bug.
* `isFallback: true` means a middleware answered, not a model.

## 6. Local dev loop

```bash
bun install
cp .env.example .env      # fill in ONE provider group
bun run devx              # doctor (what's visible) + smoke (one real decision)
bun run devx example 0    # provider-agnostic quickstart
bun run devx examples     # every runnable example
bun run check             # typecheck + 128 tests + build
```

`just doctor|smoke|examples|check|pack|release` and `make doctor|smoke|examples|check` mirror the
same commands for people who prefer a task runner.

## 7. Invariants this library enforces

* Zero runtime dependencies; Node 18+, Bun, Deno, Workers.
* No silent mock degradation: provider faults are thrown, never converted into plausible answers.
* No implicit transport swap: a broken `env.AI` binding does not fall through to a billed REST call.
* No implicit model swap: `extract()` refuses a non-Clairic model rather than billing a different one.
* Cloudflare is never auto-selected from `CLOUDFLARE_API_TOKEN` alone; it must be asked for.

## 8. Failure modes worth checking first

| Symptom | Cause |
|---|---|
| `JEV_TIMEOUT_ERROR` on first local call | model load; raise `timeoutMs` to 30000 |
| `JEV_AUTHENTICATION_ERROR` with a key set | wrong provider pinned, or key for another vendor |
| `connection failed at …:11434` | `ollama serve` not running, or model not pulled |
| `UNSUPPORTED_OPERATION` from `extract()` | active provider is not Cloudflare |
| confidence always ~0.25 on a 4-way `choice` | criteria strings too vague to separate classes |
