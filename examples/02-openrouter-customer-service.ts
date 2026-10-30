/**
 * Example 2: Customer Service Routing with the OpenRouter Decisions API
 *
 * Prefers OpenRouter, then falls back down the devx chain
 * (TypeSafe -> Cloudflare -> local Ollama -> local Homestead) so the example
 * still runs when the key is absent.
 *
 * Requirements: none. With `OPENROUTER_API_KEY` set it runs against production.
 *
 * Run:
 *   bun run example:openrouter
 *   S1_PROVIDER=ollama bun run example:openrouter   # force a backend
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
  if (!process.env.OPENROUTER_API_KEY) {
    console.warn('\n⚠️  Notice: OPENROUTER_API_KEY is not set — falling back to another provider.\n');
  }

  const resolved = await resolveProvider({ prefer: 'openrouter' });
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
