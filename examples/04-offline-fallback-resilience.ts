/**
 * Example 4: Transparent Error Handling & Middleware Failover Resilience
 *
 * Demonstrates:
 *   1. Transparent error propagation: remote failures throw JevProviderError
 *      directly without silent mock degradation.
 *   2. True failover resilience via `onError` middleware: intercepting faults
 *      and recovering with safe fallback decisions or secondary routing.
 *
 * Run:
 *   bun run examples/04-offline-fallback-resilience.ts
 */

import {
  S1Client,
  JevProviderBase,
  JevProviderError,
  type ProviderMetadata,
  type JevDecisionResponse
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
  console.log('PART 1: TRANSPARENT ERROR PROPAGATION (NO SILENT MOCK FALLBACK)');
  console.log('='.repeat(70));

  const directClient = new S1Client({
    providerInstance: new FailingUpstreamProvider()
  });

  console.log(`[Init] Direct client resolved provider: "${directClient.provider}"`);
  console.log(`>> Invoking failing upstream directly...`);

  try {
    await directClient.decide({
      state: sampleTickets.doubleBillingAngry!,
      questions: customerServiceQuestions
    });
    console.error('❌ Error: directClient should have thrown an error!');
  } catch (err: any) {
    console.log(`✅ Caught expected transparent error: [${err.constructor.name}] ${err.message}`);
    console.log(`   (No silent degradation occurred; caller receives exact upstream failure)\n`);
  }

  console.log('='.repeat(70));
  console.log('PART 2: FAILOVER RESILIENCE VIA onError MIDDLEWARE');
  console.log('='.repeat(70));

  // Initialize client with failing provider and onError failover middleware
  const resilientClient = new S1Client({
    providerInstance: new FailingUpstreamProvider()
  });

  resilientClient.use({
    name: 'failover-circuit-breaker',
    onError: async (ctx, error) => {
      console.warn(`⚠️ [Middleware] Intercepted upstream fault: "${error.message}"`);
      console.warn(`🔄 [Middleware] Generating deterministic failover decision...`);

      // Safe fallback response generated deterministically by middleware
      const fallbackResponse: JevDecisionResponse<typeof customerServiceQuestions> = {
        answers: {
          is_escalation_risk: { noul: 0.85 },
          target_department: {
            choice: 'billing',
            confidence: 0.90,
            probabilities: {
              billing: 0.90,
              technical_support: 0.05,
              retention: 0.03,
              general_inquiry: 0.02
            }
          },
          priority_level: {
            score: 4,
            confidence: 0.88
          }
        },
        latencyMs: 1.2,
        providerUsed: 'middleware-failover',
        modelUsed: 'failover-safe-heuristic',
        isFallback: true
      };

      return fallbackResponse;
    }
  });

  const enterpriseTicket = sampleTickets.doubleBillingAngry!;
  console.log(`>> Invoking failing upstream protected by onError middleware...`);

  const fallbackDecision = await resilientClient.decide({
    state: enterpriseTicket,
    questions: customerServiceQuestions
  });

  renderRoutingReceipt(enterpriseTicket, fallbackDecision);

  console.log(`✅ Resilient Client successfully recovered via onError middleware:`);
  console.log(`   - isFallback:   ${fallbackDecision.isFallback}`);
  console.log(`   - providerUsed: ${fallbackDecision.providerUsed}`);
  console.log(`   - targetDept:   ${fallbackDecision.answers.target_department.choice}`);
  console.log(`   - escalation:   ${(fallbackDecision.answers.is_escalation_risk.noul * 100).toFixed(1)}%`);
  console.log(`\nSystem-1 decision executed cleanly without unhandled rejections!\n`);
}

main().catch((err) => {
  console.error('[Error] Execution failed:', err);
  process.exit(1);
});
