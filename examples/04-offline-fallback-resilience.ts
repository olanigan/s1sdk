/**
 * Example 4: Zero-Credential Offline Simulation & Network Resiliency
 *
 * Demonstrates:
 *   1. Air-gapped offline evaluation via MockEngine (< 2ms, zero dependencies, zero network).
 *   2. Automatic graceful degradation when a remote provider crashes or times out.
 *
 * Run:
 *   bun run examples/04-offline-fallback-resilience.ts
 */

import {
  S1Client,
  JevProviderBase,
  JevProviderError,
  type ProviderMetadata
} from '../src/index.js';
import {
  customerServiceQuestions,
  sampleTickets,
  renderRoutingReceipt
} from './shared/customer-service-schema.js';

/**
 * A simulated faulty remote provider that always throws 503 Service Unavailable
 */
class FailingUpstreamProvider extends JevProviderBase {
  readonly name = 'Simulated Outage Upstream';
  readonly providerId = 'simulated-broken-api';

  async execute(): Promise<any> {
    throw new JevProviderError('503 Service Unavailable: Upstream cluster failure', 503, true);
  }

  async isHealthy(): Promise<boolean> {
    return false;
  }

  getMetadata(): ProviderMetadata {
    return {
      providerId: this.providerId,
      defaultModel: 'broken',
      supportsLocalExecution: false,
      maxConcurrentRequests: 0
    };
  }
}

async function main() {
  console.log('='.repeat(70));
  console.log('PART 1: AIR-GAPPED OFFLINE MOCK ENGINE (ZERO NETWORK / ZERO CREDENTIALS)');
  console.log('='.repeat(70));

  // Initialize client in explicit offline mock mode
  const offlineClient = new S1Client({ useMock: true });
  console.log(`[Init] Offline client resolved provider: "${offlineClient.provider}"\n`);

  for (const [key, ticket] of Object.entries(sampleTickets)) {
    console.log(`>> Routing Ticket Scenario: ${key}...`);
    const decision = await offlineClient.decide({
      state: ticket,
      questions: customerServiceQuestions
    });

    renderRoutingReceipt(ticket, decision);
  }

  console.log('='.repeat(70));
  console.log('PART 2: ZERO-FAILURE RESILIENCE (AUTOMATIC FALLBACK ON UPSTREAM OUTAGE)');
  console.log('='.repeat(70));

  // Initialize client with failing provider and fallbackToMock enabled
  const resilientClient = new S1Client({
    providerInstance: new FailingUpstreamProvider(),
    fallbackToMock: true // Guarantees the application never crashes on network partitions
  });

  const enterpriseTicket = sampleTickets.doubleBillingAngry!;
  console.log(`>> Invoking failing upstream with fallbackToMock: true...`);

  const fallbackDecision = await resilientClient.decide({
    state: enterpriseTicket,
    questions: customerServiceQuestions
  });

  console.log(`\n✅ Resilient Client successfully caught upstream failure and degraded gracefully:`);
  console.log(`   - isFallback:   ${fallbackDecision.isFallback}`);
  console.log(`   - providerUsed: ${fallbackDecision.providerUsed}`);
  console.log(`   - targetDept:   ${fallbackDecision.answers.target_department.choice}`);
  console.log(`   - escalation:   ${(fallbackDecision.answers.is_escalation_risk.noul * 100).toFixed(1)}%`);
  console.log(`\nSystem-1 decision executed without disrupting the caller's event loop!\n`);
}

main().catch((err) => {
  console.error('[Error] Execution failed:', err);
  process.exit(1);
});
