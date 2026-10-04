/**
 * Example 1: Customer Service Routing with Official TypeSafe AI REST APIs
 *
 * Requirements:
 *   export TYPESAFE_API_KEY="ts-..."
 *
 * Run:
 *   bun run examples/01-typesafe-customer-service.ts
 */

import { S1Client } from '../src/index.js';
import {
  customerServiceQuestions,
  sampleTickets,
  renderRoutingReceipt
} from './shared/customer-service-schema.js';

async function main() {
  const apiKey = process.env.TYPESAFE_API_KEY;

  if (!apiKey) {
    console.warn('\n⚠️  Notice: TYPESAFE_API_KEY environment variable is not set.');
    console.warn('   Running with automatic fallback to deterministic MockEngine.');
    console.warn('   To run against production TypeSafe AI: export TYPESAFE_API_KEY="ts-..."\n');
  }

  // Initialize S1Client for TypeSafe AI
  const client = new S1Client({
    provider: 'typesafe',
    apiKey: apiKey || '',
    endpoint: process.env.TYPESAFE_ENDPOINT || 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-1',
    timeoutMs: 5_000,
    fallbackToMock: true // Degrade gracefully to MockEngine if remote credentials are missing or upstream is offline
  });

  console.log(`[Init] S1Client resolved provider: "${client.provider}"\n`);

  for (const [key, ticket] of Object.entries(sampleTickets)) {
    console.log(`>> Routing Ticket Scenario: ${key}...`);
    const decision = await client.decide({
      state: ticket,
      questions: customerServiceQuestions
    });

    renderRoutingReceipt(ticket, decision);
  }
}

main().catch((err) => {
  console.error('[Error] Execution failed:', err);
  process.exit(1);
});
