/**
 * Jev System-1 Decision Client: Abstract Provider Base
 * Specification: SPEC-001-jev-sdk-core-client.md
 */

import type {
  JevQuestion,
  JevDecisionRequest,
  JevDecisionResponse,
  JevExecutionOptions,
  S1ExtractField,
  S1ExtractRequest,
  S1ExtractResponse
} from '../types.js';

export interface ProviderMetadata {
  readonly providerId: string;
  readonly defaultModel: string;
  readonly supportsLocalExecution: boolean;
  readonly maxConcurrentRequests: number;
  /** Transport actually in use, when the provider has more than one (e.g. Cloudflare binding vs REST). */
  readonly transport?: string;
  /** True only when the active transport provably makes no outbound network calls. */
  readonly zeroEgress?: boolean;
  /** Transports this provider can be configured with, for capability discovery. */
  readonly supportedTransports?: readonly string[];
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
   * Optional structured System-1 extraction method (e.g. Cloudflare Clairic)
   */
  extract?<
    TState,
    TFields extends Record<string, S1ExtractField>
  >(
    request: S1ExtractRequest<TState, TFields>,
    options?: JevExecutionOptions
  ): Promise<S1ExtractResponse<TFields>>;

  /**
   * Health check for circuit breaking and failover monitors
   */
  abstract isHealthy(): Promise<boolean>;

  /**
   * Capability and configuration metadata for this provider
   */
  abstract getMetadata(): ProviderMetadata;
}
