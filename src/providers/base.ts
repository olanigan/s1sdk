/**
 * Jev System-1 Decision Client: Abstract Provider Base
 * Specification: SPEC-001-jev-sdk-core-client.md
 */

import type {
  JevQuestion,
  JevDecisionRequest,
  JevDecisionResponse,
  JevExecutionOptions
} from '../types.js';

export interface ProviderMetadata {
  readonly providerId: string;
  readonly defaultModel: string;
  readonly supportsLocalExecution: boolean;
  readonly maxConcurrentRequests: number;
}

export abstract class JevProviderBase {
  abstract readonly name: string;
  abstract readonly providerId: string;

  /**
   * Primary invocation method for executing structured System-1 decisions
   */
  abstract execute<
    TState,
    TQuestions extends Record<string, JevQuestion>
  >(
    request: JevDecisionRequest<TState, TQuestions>,
    options?: JevExecutionOptions
  ): Promise<JevDecisionResponse<TQuestions>>;

  /**
   * Health check for circuit breaking and failover monitors
   */
  abstract isHealthy(): Promise<boolean>;

  /**
   * Capability and configuration metadata for this provider
   */
  abstract getMetadata(): ProviderMetadata;
}
