# `s1sdk`

> **Zero-overhead TypeScript/JavaScript client for System-1 discrete decision routing.**

[![npm version](https://img.shields.io/npm/v/s1sdk.svg)](https://www.npmjs.com/package/s1sdk)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](#zero-dependencies)
[![Release Status](https://img.shields.io/badge/status-experimental--alpha-orange.svg)](#)

> [!WARNING]
> **EXPERIMENTAL DEVELOPER PREVIEW (v0.1.1) — NOT FOR PRODUCTION USE**  
> `s1sdk` is currently an experimental developer preview undergoing active protocol and architecture development. Wire specifications, model identifiers, and provider bindings are subject to breaking changes. **Do NOT deploy this release in mission-critical or unmonitored production environments.**

---

## 1. What is S1 SDK (`s1sdk`)?

Frontier autoregressive LLMs (Claude 3.5 Sonnet, GPT-4o) generate multi-token text over multi-second streaming connections costing \$3.00–\$15.00 / Mtok.

**System-1 (S1) models** evaluate structured inputs directly against discrete token/logit distributions without autoregressive generation:
* **Single Forward Pass:** Sub-50ms execution.
* **Bounded Output Schemas:** Calibrated scalar probabilities $[0.0, 1.0]$, categorical softmax distributions, and ordinal scores.
* **Predictable Economics:** Targeting **\$0.042 per 1,000,000 decisions** with \$0.00 output token generation costs.

`s1sdk` is the official client library with **zero production runtime dependencies** (`dependencies: {}`).

---

## 2. Installation

```bash
# npm
npm install s1sdk

# bun
bun add s1sdk

# pnpm
pnpm add s1sdk
```

---

## 3. Decision Primitives

System-1 queries are modeled through three canonical decision primitives:

```typescript
import { S1Client, noul, choice, score } from 's1sdk';

const s1 = new S1Client();

// 1. noul: Binary calibrated probability [0.0, 1.0] (with optional true/false criteria)
const safetyCheck = await s1.decide({
  state: 'rm -rf /var/log/*',
  questions: {
    is_malicious: noul('Check if the bash command is destructive or unauthorized', {
      true: 'Destructive system command',
      false: 'Benign standard operation'
    })
  }
});
console.log(safetyCheck.answers.is_malicious.noul); // 0.9600

// 2. choice: Discrete categorical classification with full probability distribution
const toolRouting = await s1.decide({
  state: 'Find all occurrences of "ECONNREFUSED" in error.log',
  questions: {
    tool: choice('Route user prompt to best tool', {
      terminal: 'Execute shell commands on server',
      web_search: 'Search Google/web for answers',
      read_file: 'Inspect local file contents'
    })
  }
});
console.log(toolRouting.answers.tool.choice); // "terminal"
console.log(toolRouting.answers.tool.probabilities);
// { terminal: 0.88, web_search: 0.06, read_file: 0.06 }

// 3. score: Bounded ordinal regression over discrete levels
const qualityEvaluation = await s1.decide({
  state: 'Generated response: 240 words, citing 3 verified sources',
  questions: {
    faithfulness: score('Rate citation faithfulness', [1, 2, 3, 4, 5])
  }
});
console.log(qualityEvaluation.answers.faithfulness.score); // 4
```

---

## 4. Polymorphic Provider Runtimes

`s1sdk` dynamically adapts to its host environment:

### In-Process Cloudflare Workers AI (`env.AI`)
Supports `@cf/cloudflare/clef-flash` (default fast hot-path, 38.8ms), `@cf/cloudflare/clef` (27B), and `typesafe/jev`:

```typescript
import { S1Client, CLOUDFLARE_MODELS } from 's1sdk';

export default {
  async fetch(req: Request, env: Env) {
    const s1 = new S1Client({
      aiBinding: env.AI,
      model: CLOUDFLARE_MODELS.CLEF_FLASH // '@cf/cloudflare/clef-flash'
    });

    const res = await s1.decide({ ... });
    return Response.json(res);
  }
}
```

### Remote OpenRouter Decisions API
```typescript
import { S1Client } from 's1sdk';

const s1 = new S1Client({
  provider: 'openrouter',
  apiKey: process.env.OPENROUTER_API_KEY
});
```

### TypeSafe AI REST API
```typescript
import { S1Client } from 's1sdk';

const s1 = new S1Client({
  provider: 'typesafe',
  apiKey: process.env.TYPESAFE_API_KEY
});
```

### Local Silicon / Homestead Engine
```typescript
import { S1Client } from 's1sdk';

// Zero-runtime-dependency local execution via Homestead daemon (<1.2ms)
const s1 = new S1Client({
  provider: 'homestead',
  model: 'homerouter-420M'
});
```

### Structured Extraction (`@cf/cloudflare/clairic`)

`client.extract()` is the only extraction entry point. It requires an
**explicit Clairic model** — decision models (`clef`, `clef-flash`, `jev`) are
never swapped implicitly, so a configured model cannot silently become a
different bill.

```typescript
import { S1Client, CLOUDFLARE_MODELS } from 's1sdk';
import {
  extractText,
  extractNumber,
  extractDate,
  extractList,
  extractEstimate
} from 's1sdk';

const s1 = new S1Client({
  aiBinding: env.AI,
  model: CLOUDFLARE_MODELS.CLAIRIC // required for extract()
});

const res = await s1.extract({
  state: 'Invoice INV-1042 from Acme Health Inc., total USD 4500.50, due 2026-03-04',
  referenceDate: '2026-01-01',            // anchors dates written without a year
  fields: {
    vendor: extractText('Vendor organization name'),
    total: extractNumber({ decimals: 2, unit: 'USD' }),
    dueDate: extractDate(),
    tags: extractList('text', 'Invoice tags'),
    confidenceBand: extractEstimate(0, 1, { step: 0.01 })
  },
  extractOptions: { returnStateText: true }
});

// Spans are [start, end] tuples, matching the API.
const [start, end] = res.answers.vendor.span ?? [0, 0];
console.log(res.state_text?.slice(start, end)); // "Acme Health Inc."
console.log(res.truncated);                      // true if passes were cut
console.log(res.usage?.passes);                  // e.g. 3 for a split schema
```

Field types: `text`, `number`, `date`, `time`, `datetime`, `duration`, `list`,
`estimate`, `forecast`. Field options map to the API contract:
`integer`, `decimals`, `unit`, `scale`, `nullThreshold`, `step`, `horizon`,
`interval`. Lists emit `items`; estimates expose `p10`/`p90` plus a derived
`interval_80`; responses surface `guess`, `truncated`, `state_text`, and the
full usage breakdown (`state_tokens`, `image_tokens`, `schema_tokens`,
`passes`).

Images are validated client-side before dispatch: at most 4, 4 MiB each,
8 MiB decoded total, as base64 data URLs or `{ content_type, base64 }`.
Nothing is estimated locally — `res.usage` is the server-reported usage.

---

## 5. Non-Blocking Middleware Pipeline

Attach audit, OTel, security, or FinOps telemetry hooks via `client.use(middleware)`. Middleware failures are isolated and will never crash decision execution:

```typescript
import { S1Client, type S1Middleware } from 's1sdk';

const telemetryPlugin: S1Middleware = {
  name: 'finops-telemetry',
  beforeRequest(ctx) {
    ctx.metadata.startTime = performance.now();
  },
  afterResponse(ctx, res) {
    console.log(`[FinOps] ${res.providerUsed} executed in ${res.latencyMs}ms`);
  },
  onError(ctx, error) {
    console.warn(`[Failover] Alerting on-call: ${error.message}`);
  }
};

const s1 = new S1Client();
s1.use(telemetryPlugin);
```

---

## 6. Transparent Error Handling & Middleware Failover

`s1sdk` eliminates silent degradation. If remote providers fail (HTTP 502, network partition, rate limits exhausted), `client.decide()` throws `JevProviderError` or `JevTimeoutError` directly and transparently.

To handle outages gracefully without crashing the critical path, use `onError` middleware:

```typescript
s1.use({
  name: 'resilience-fallback',
  onError(ctx, error) {
    console.warn(`[Failover] Upstream failure: ${error.message}. Returning cached fallback.`);
    return {
      answers: {
        department: { choice: 'general_inquiry', confidence: 1.0, probabilities: { general_inquiry: 1.0 } }
      },
      latencyMs: 0.1,
      providerUsed: 'middleware-cache-fallback',
      modelUsed: 'rule-fallback',
      isFallback: true
    };
  }
});
```

---

## 7. Backwards Compatibility

For existing applications migrating from `jev-sdk`:
* `JevClient` is fully preserved as a canonical alias for `S1Client`:
  ```typescript
  import { JevClient, type JevClientOptions } from 's1sdk';
  ```
* All legacy types (`JevQuestion`, `JevDecisionRequest`, etc.) remain fully exported and compatible with `S1Client`.

---

## 8. Production Examples

Explore the complete multi-provider customer service routing application in [`examples/`](./examples):

* [**01-typesafe-customer-service.ts**](./examples/01-typesafe-customer-service.ts): Official TypeSafe AI REST APIs
* [**02-openrouter-customer-service.ts**](./examples/02-openrouter-customer-service.ts): OpenRouter Decisions API
* [**03-cloudflare-worker-customer-service/**](./examples/03-cloudflare-worker-customer-service): Sub-15ms edge routing via `env.AI` binding
* [**04-offline-fallback-resilience.ts**](./examples/04-offline-fallback-resilience.ts): Transparent error handling & middleware failover
* [**05-homerouter-v1-1-agentic-dispatch.ts**](./examples/05-homerouter-v1-1-agentic-dispatch.ts): Sub-1.2ms local agentic dispatch via HomeRouter S1 v1.1
* [**07-clairic-invoice-extraction.ts**](./examples/07-clairic-invoice-extraction.ts): Typed invoice extraction with Clairic spans, estimates and usage

Run the resilience failover demo:
```bash
bun run example:resilience
```

---

## 9. License

Apache-2.0 © Homestead Labs
