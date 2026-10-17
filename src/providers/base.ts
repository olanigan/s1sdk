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

/**
 * Parses a Retry-After header: delay-seconds ("2", "0.5") or an HTTP-date. Returns milliseconds, or undefined
 * when the header is absent or unreadable so the caller falls back to its own backoff.
 */
export function parseRetryAfterMs(header: string | null | undefined, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const value = header.trim();
  if (/^\d+(\.\d+)?$/.test(value)) return Math.round(parseFloat(value) * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/** A usage.cost the API reported, if it is a finite non-negative number. Anything else is dropped, never guessed. */
export function parseCost(cost: unknown): number | undefined {
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
}

/** True when fetch refused to follow a redirect (`redirect: 'error'`). The message differs by runtime. */
export function isRedirectRefusal(err: unknown): boolean {
  const e = err as { message?: unknown; cause?: { message?: unknown; code?: unknown } } | null;
  return /redirect/i.test([e?.message, e?.cause?.message, e?.cause?.code].filter((x) => typeof x === 'string').join(' '));
}

export const REDIRECT_REFUSED =
  'refused to follow an HTTP redirect (redirects are disabled so credentials are never forwarded to another host)';
