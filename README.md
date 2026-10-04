# `s1sdk`

> **Zero-overhead TypeScript/JavaScript client for System-1 discrete decision routing.**

[![npm version](https://img.shields.io/npm/v/s1sdk.svg)](https://www.npmjs.com/package/s1sdk)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](#zero-dependencies)
[![Release Status](https://img.shields.io/badge/status-experimental--alpha-orange.svg)](#)

> [!WARNING]
> **EXPERIMENTAL DEVELOPER PREVIEW (v0.1.0) — NOT FOR PRODUCTION USE**  
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

// 1. noul: Binary calibrated probability [0.0, 1.0] (e.g., safety, truth likelihood)
const safetyCheck = await s1.decide({
  state: 'rm -rf /var/log/*',
  questions: {
    is_malicious: noul('Check if the bash command is destructive or unauthorized')
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
```typescript
import { S1Client } from 's1sdk';

export default {
  async fetch(req: Request, env: Env) {
    const s1 = new S1Client({
      aiBinding: env.AI,
      model: '@cf/typesafe/jev'
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

### Air-Gapped Offline Mock Engine
```typescript
import { S1Client } from 's1sdk';

// Instant evaluation (<2ms) with zero network requests
const s1 = new S1Client({ useMock: true });
```

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

## 6. Zero-Failure Fallback Guarantee

If remote APIs fail (HTTP 502, network partition, rate limits exhausted):
1. The client automatically catches the error and evaluates the decision locally using `MockEngine`.
2. The response is stamped with `isFallback: true` and `providerUsed: 'mock-engine-fallback'`.
3. Execution on your critical path continues uninterrupted.

To disable fallback and rethrow errors:
```typescript
const s1 = new S1Client({ fallbackToMock: false });
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
* [**04-offline-fallback-resilience.ts**](./examples/04-offline-fallback-resilience.ts): Zero-credential air-gapped simulation & failover

Run the zero-credential offline demo immediately:
```bash
bun run example:mock
```

---

## 9. License

Apache-2.0 © Homestead Labs
