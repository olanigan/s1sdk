/**
 * Example 1: Customer Service Routing with Official TypeSafe AI REST APIs
 *
 * Requirements:
 *   export TYPESAFE_API_KEY="ts-..."
 *
 * Run:
 *   bun run examples/01-typesafe-customer-service.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { S1Client } from '../src/index.js';
import {
  customerServiceQuestions,
  sampleTickets,
  renderRoutingReceipt
} from './shared/customer-service-schema.js';

// Auto-load .env if present in current or parent directories
function loadEnv() {
  if (process.env.TYPESAFE_API_KEY) return;
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '../../.env'),
    path.resolve(process.cwd(), '../.env')
  ];
  for (const f of candidates) {
    if (fs.existsSync(f)) {
      const content = fs.readFileSync(f, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const [k, ...v] = trimmed.split('=');
        if (k && v.length > 0 && !process.env[k.trim()]) {
          process.env[k.trim()] = v.join('=').trim().replace(/^["']|["']$/g, '');
        }
      }
      break;
    }
  }
}
loadEnv();

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
    model: 'jev-latest',
    timeoutMs: 10_000,
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
