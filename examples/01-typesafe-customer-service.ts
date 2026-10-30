/**
 * Example 1: Customer Service Routing with Official TypeSafe AI REST APIs
 *
 * Prefers TypeSafe AI, then falls back down the devx chain
 * (OpenRouter -> Cloudflare -> local Ollama -> local Homestead) so the example
 * still runs when the key is absent.
 *
 * Requirements: none. With `TYPESAFE_API_KEY` set it runs against production.
 *
 * Run:
 *   bun run example:typesafe
 *   S1_PROVIDER=ollama bun run example:typesafe   # force a backend
 */

import { S1Client } from '../src/index.js';
import {
  customerServiceQuestions,
  sampleTickets,
  renderRoutingReceipt
} from './shared/customer-service-schema.js';
import {
  loadDotEnv,
  resolveProvider,
  describeResolution,
  DevxConfigError
} from './shared/provider.js';

loadDotEnv();

async function main() {
  if (!process.env.TYPESAFE_API_KEY) {
    console.warn('\n⚠️  Notice: TYPESAFE_API_KEY is not set — falling back to another provider.\n');
  }

  const resolved = await resolveProvider({ prefer: 'typesafe' });
  console.log(`[Init] ${describeResolution(resolved)}`);
  for (const note of resolved.notes) console.log(`[Init] note: ${note}`);

  const client = new S1Client(resolved.options);

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
  if (err instanceof DevxConfigError) {
    console.error(`\n[devx] ${err.message}`);
    for (const hint of err.hints) console.error(`  -> ${hint}`);
    process.exit(2);
  }
  console.error('[Error] Execution failed:', err);
  process.exit(1);
});
