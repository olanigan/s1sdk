/**
 * Offline provider for the PR gate example.
 *
 * `--stub` swaps this in so the reducer, policy merge, receipt and CI plumbing
 * can be exercised without credentials. It answers deterministically from the
 * same bounded state the real model receives; the receipt labels the provider
 * as `stub` so a stub run can never be mistaken for a model decision.
 */

import {
  JevProviderBase,
  type JevDecisionRequest,
  type JevDecisionResponse,
  type JevQuestion,
  type ProviderMetadata
} from '../../src/index.js';
import { buildStubDecision } from './pr-gate-schema.js';

export class PrGateStubProvider extends JevProviderBase {
  readonly name = 'PR gate stub (offline)';
  readonly providerId = 'stub';

  public async execute<TState, TQuestions extends Record<string, JevQuestion>>(
    request: JevDecisionRequest<TState, TQuestions>
  ): Promise<JevDecisionResponse<TQuestions>> {
    return buildStubDecision(request as unknown as JevDecisionRequest<unknown, TQuestions>);
  }

  public async isHealthy(): Promise<boolean> {
    return true;
  }

  public getMetadata(): ProviderMetadata {
    return {
      providerId: 'stub',
      defaultModel: 'stub-pr-gate',
      supportsLocalExecution: true,
      maxConcurrentRequests: 1,
      transport: 'none',
      zeroEgress: true,
      supportedTransports: ['none']
    };
  }
}
