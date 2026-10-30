# `s1sdk` Production Examples: Multi-Provider Customer Service Routing

This directory contains production-ready examples demonstrating how to implement the **same Customer Service Routing application** across three runtime providers:

0. **Provider-Agnostic Quickstart** (`00-quickstart.ts`)
1. **TypeSafe AI Official REST APIs** (`01-typesafe-customer-service.ts`)
2. **OpenRouter Decisions API** (`02-openrouter-customer-service.ts`)
3. **Cloudflare Workers AI Edge Service** (`03-cloudflare-worker-customer-service/`)
4. **Failover Resilience via onError Middleware** (`04-offline-fallback-resilience.ts`)

All of them resolve their provider through [`shared/provider.ts`](./shared/provider.ts), so the
snippets below show the code you would ship, not a credential checklist.

---

## 1. Problem Space: Single-Pass Customer Service Routing

Rather than incurring $3.00–$15.00 / Mtok and 2,500ms latency on multi-token LLMs for simple classification, `s1sdk` evaluates the ticket in a single sub-25ms forward pass across three canonical System-1 primitives:

| Primitive | Question | Return Type | Business Purpose |
| :--- | :--- | :--- | :--- |
| **`noul`** | `is_escalation_risk` | Scalar $[0.0, 1.0]$ | Churn risk / immediate executive de-escalation |
| **`choice`** | `target_department` | Categorical Softmax | Operational routing (`billing`, `technical_support`, `retention`, `general_inquiry`) |
| **`score`** | `priority_level` | Ordinal Tier $[1..5]$ | Incident priority rating (1 = routine, 5 = critical emergency) |

---

## 2. Quickstart: Running the Examples

### Option 0 (recommended): let devx pick a provider

```bash
bun install
cp .env.example .env      # fill in ONE group, or skip it entirely for local Ollama
bun run devx              # doctor + smoke
bun run devx examples     # run every example below
```

`devx` resolves a provider from the environment and prints why it won. Order:

```
TYPESAFE_API_KEY -> OPENROUTER_API_KEY -> CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
                 -> local Ollama (127.0.0.1:11434) -> local Homestead (127.0.0.1:8080)
```

Local daemons must answer a probe before they are selected. `S1_PROVIDER=<id>` pins a backend
strictly (no silent vendor switch), `S1_MODEL=<id>` overrides the default model.

| Command | Effect |
| :--- | :--- |
| `bun run devx doctor` | credentials present, daemons up, resolution result |
| `bun run devx smoke` | one real decision + latency + token counts |
| `bun run devx example 0` | run one example through the resolver |
| `bun run devx list` | list runnable examples |

`just doctor|smoke|example 0|examples` and `make doctor|smoke|example ID=0|examples` are equivalent.

### Option A: Failover Resilience via Middleware
No credentials needed — the demo uses a simulated failing upstream.
```bash
bun run example:resilience
```

### Option B: TypeSafe AI Official REST API
Prefers TypeSafe, falls back down the chain if the key is absent.
```bash
bun run example:typesafe
```

### Option C: OpenRouter Decisions API
Prefers OpenRouter, same fallback behaviour.
```bash
bun run example:openrouter
```

### Option D: Cloudflare Workers AI Edge Service (real `env.AI` binding)
```bash
set -a && . ./.env && set +a
bunx wrangler@4 dev --config examples/03-cloudflare-worker-customer-service/wrangler.clairic.jsonc --port 8791
# or: just worker-dev
```

### Option E: Local Ollama (free, no key)
```bash
ollama serve &
ollama pull tev1:0.8b
S1_PROVIDER=ollama bun run devx smoke
```

---

## 3. Provider Architecture Comparison

| Feature | TypeSafe AI | OpenRouter | Cloudflare Workers AI | Homestead (Local) |
| :--- | :--- | :--- | :--- | :--- |
| **Execution Path** | HTTPS REST | HTTPS REST | In-process V8 (`env.AI`) | Local HTTP Daemon |
| **Network Overhead** | TLS Handshake | TLS Handshake | **0ms (V8 Memory)** | **< 1ms (Localhost)** |
| **Typical Latency** | ~35ms | ~45ms | **< 12ms** | **< 2ms** |
| **Default Model** | `jev-1` | `typesafe/jev-latest` | `@cf/typesafe/jev` | `homerouter-420M` |
| **Credentials** | `TYPESAFE_API_KEY` | `OPENROUTER_API_KEY` | None (Cloudflare Binding) | None |
| **Air-Gap Capable** | No | No | Edge Cloud | **Yes (Full Air-Gap)** |

---

## 4. Shared Decision Schema

All examples share the common schema in [`shared/customer-service-schema.ts`](./shared/customer-service-schema.ts):

```typescript
import { S1Client, noul, choice, score } from 's1sdk';

const s1 = new S1Client();

const decision = await s1.decide({
  state: {
    ticketId: 'TCK-9481',
    tier: 'enterprise',
    message: 'We noticed two unauthorized charges of $4,800 on our corporate card...'
  },
  questions: {
    is_escalation_risk: noul('Determine if customer is furious or threatening churn'),
    target_department: choice('Route ticket to department', {
      billing: 'Refunds and disputes',
      technical_support: 'Outages and bugs',
      retention: 'Cancellations and churn',
      general_inquiry: 'Account FAQs'
    }),
    priority_level: score('Priority score 1-5', [1, 2, 3, 4, 5])
  }
});

console.log(decision.answers.target_department.choice); // "billing"
console.log(decision.answers.is_escalation_risk.noul);   // 0.9600
console.log(decision.answers.priority_level.score);     // 5
```
