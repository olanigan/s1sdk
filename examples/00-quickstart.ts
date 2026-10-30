/**
 * Example 0: Provider-agnostic quickstart — run this first.
 *
 * It picks the provider from whatever credentials you have and prints why:
 *
 *   TYPESAFE_API_KEY  ->  OpenRouter key  ->  CLOUDFLARE_API_TOKEN + ACCOUNT_ID
 *   ->  local Ollama  ->  local Homestead
 *
 * Requirements: none. With no keys it falls through to a local daemon and shows
 * you the command to start one.
 *
 * Run:
 *   bun run devx                    # doctor + smoke + this example
 *   bun run example:quickstart
 *   S1_PROVIDER=ollama bun run example:quickstart
 *   bun run example:quickstart --ticket apiOutageUrgent
 *   bun run example:quickstart --all
 */

import { parseArgs } from 'node:util';
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
  const { values } = parseArgs({
    options: {
      ticket: { type: 'string', short: 't' },
      all: { type: 'boolean', default: false }
    },
    allowPositionals: true
  });

  const resolved = await resolveProvider();
  console.log('='.repeat(70));
  console.log(' s1sdk quickstart — single forward pass, no autoregressive tokens');
  console.log('='.repeat(70));
  console.log(`Provider: ${describeResolution(resolved)}`);
  for (const note of resolved.notes) console.log(`  note: ${note}`);
  console.log('-'.repeat(70));

  // Any provider works: the questions and answers are produced by the same
  // protocol normalizer, so `answers.target_department.choice` is identical.
  const client = new S1Client(resolved.options);

  const keys = values.all
    ? Object.keys(sampleTickets)
    : [values.ticket ?? 'doubleBillingAngry'];

  for (const key of keys) {
    const ticket = sampleTickets[key];
    if (!ticket) {
      throw new Error(
        `Unknown ticket "${key}". Available: ${Object.keys(sampleTickets).join(', ')}`
      );
    }
    console.log(`\n>> ${key}`);
    const decision = await client.decide({
      state: ticket,
      questions: customerServiceQuestions
    });
    renderRoutingReceipt(ticket, decision);
  }

  console.log(`\nSwap providers with S1_PROVIDER (${'typesafe|openrouter|cloudflare|ollama|homestead'}).`);
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
