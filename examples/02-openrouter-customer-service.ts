/**
 * Example 2: Customer Service Routing with OpenRouter Decisions API
 *
 * Requirements:
 *   export OPENROUTER_API_KEY="sk-or-..."
 *
 * Run:
 *   bun run examples/02-openrouter-customer-service.ts
 */

import { S1Client } from '../src/index.js';
import {
  customerServiceQuestions,
  sampleTickets,
  renderRoutingReceipt
} from './shared/customer-service-schema.js';

async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    console.warn('\n⚠️  Notice: OPENROUTER_API_KEY environment variable is not set.');
    console.warn('   Running with automatic fallback to deterministic MockEngine.');
    console.warn('   To run against live OpenRouter: export OPENROUTER_API_KEY="sk-or-..."\n');
  }

  // Initialize S1Client for OpenRouter
  const client = new S1Client({
    provider: 'openrouter',
    apiKey: apiKey || '',
    model: 'typesafe/jev-latest',
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
