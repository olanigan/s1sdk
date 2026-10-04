# `s1sdk` Production Examples: Multi-Provider Customer Service Routing

This directory contains production-ready examples demonstrating how to implement the **same Customer Service Routing application** across three runtime providers:

1. **TypeSafe AI Official REST APIs** (`01-typesafe-customer-service.ts`)
2. **OpenRouter Decisions API** (`02-openrouter-customer-service.ts`)
3. **Cloudflare Workers AI Edge Service** (`03-cloudflare-worker-customer-service/`)
4. **Air-Gapped Offline Mock & Fallback Resilience** (`04-offline-fallback-resilience.ts`)

---

## 1. Problem Space: Single-Pass Customer Service Routing

Rather than incurring \$3.00–\$15.00 / Mtok and 2,500ms latency on multi-token LLMs for simple classification, `s1sdk` evaluates the ticket in a single sub-25ms forward pass across three canonical System-1 primitives:

| Primitive | Question | Return Type | Business Purpose |
| :--- | :--- | :--- | :--- |
| **`noul`** | `is_escalation_risk` | Scalar $[0.0, 1.0]$ | Churn risk / immediate executive de-escalation |
| **`choice`** | `target_department` | Categorical Softmax | Operational routing (`billing`, `technical_support`, `retention`, `general_inquiry`) |
| **`score`** | `priority_level` | Ordinal Tier $[1..5]$ | Incident priority rating (1 = routine, 5 = critical emergency) |

---

## 2. Quickstart: Running the Examples

### Option A: Zero-Credential Offline Simulation (No API keys needed)
Instantly runs deterministic local heuristics without network calls:
```bash
bun run example:mock
# or
bun run examples/04-offline-fallback-resilience.ts
```

### Option B: TypeSafe AI Official REST API
```bash
export TYPESAFE_API_KEY="ts-..."
bun run example:typesafe
# or
bun run examples/01-typesafe-customer-service.ts
```

### Option C: OpenRouter Decisions API
```bash
export OPENROUTER_API_KEY="sk-or-..."
bun run example:openrouter
# or
bun run examples/02-openrouter-customer-service.ts
```

### Option D: Cloudflare Workers AI Edge Service
```bash
cd examples/03-cloudflare-worker-customer-service
npx wrangler dev
```

---

## 3. Provider Architecture Comparison

| Feature | TypeSafe AI | OpenRouter | Cloudflare Workers AI | Offline Mock Engine |
| :--- | :--- | :--- | :--- | :--- |
| **Execution Path** | HTTPS REST | HTTPS REST | In-process V8 (`env.AI`) | Local In-Memory |
| **Network Overhead** | TLS Handshake | TLS Handshake | **0ms (V8 Memory)** | **0ms (Local)** |
| **Typical Latency** | ~35ms | ~45ms | **< 12ms** | **< 2ms** |
| **Default Model** | `jev-1` | `typesafe/jev-latest` | `@cf/typesafe/jev` | Deterministic FNV-1a |
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
