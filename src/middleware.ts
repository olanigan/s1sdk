/**
 * Jev System-1 Decision Client: Middleware Pipeline
 * Specification: SPEC-001-jev-sdk-core-client.md & ADR-001
 *
 * Guarantees zero-overhead, non-blocking execution where middleware exceptions
 * cannot terminate or disrupt the core System-1 inference path.
 */

import type {
  JevQuestion,
  JevDecisionResponse,
  JevExecutionOptions
} from './types.js';

export interface JevRequestContext<TState = unknown> {
  readonly id: string;
  readonly timestamp: number;
  readonly state: TState;
  readonly questions: Record<string, JevQuestion>;
  readonly options?: JevExecutionOptions;
  readonly provider?: string;
  metadata: Record<string, unknown>;
  readonly abortSignal?: AbortSignal;
}

export interface JevResponseContext<TAnswers = unknown> {
  readonly id: string;
  readonly latencyMs: number;
  readonly answers: TAnswers;
  readonly providerUsed: string;
  readonly isFallback: boolean;
  readonly raw?: unknown;
}

export interface JevMiddleware {
  readonly name: string;
  readonly version?: string;

  /**
   * Executed prior to forwarding the request to the active provider.
   * Can inspect/modify context.metadata, or optionally short-circuit
   * by returning a cached/synthetic JevDecisionResponse.
   */
  beforeRequest?(
    ctx: JevRequestContext
  ): Promise<void | JevDecisionResponse<any>> | void | JevDecisionResponse<any>;

  /**
   * SPEC-001 plugin alias for beforeRequest
   */
  onBeforeExecute?(
    ctx: JevRequestContext
  ): Promise<void | JevDecisionResponse<any>> | void | JevDecisionResponse<any>;

  /**
   * Executed upon successful evaluation by the provider or mock engine.
   * Ideal for non-blocking asynchronous metrics flush (OTel, ClickHouse, logs).
   */
  afterResponse?(
    ctx: JevRequestContext,
    res: JevDecisionResponse<any>
  ): Promise<void> | void;

  /**
   * SPEC-001 plugin alias for afterResponse
   */
  onAfterExecute?(
    ctx: JevRequestContext,
    res: JevDecisionResponse<any>
  ): Promise<void> | void;

  /**
   * Executed when an error is thrown in provider evaluation.
   * If this hook returns a JevDecisionResponse, the error is recovered
   * and the client returns the recovered response instead of throwing.
   */
  onError?(
    ctx: JevRequestContext,
    error: Error
  ): Promise<void | JevDecisionResponse<any>> | void | JevDecisionResponse<any>;
}

/**
 * Execute beforeRequest hooks across registered middlewares.
 * Non-blocking: Middleware errors are safely absorbed to protect hot decision path.
 * Returns a response if any middleware short-circuited.
 */
export async function executeBeforeRequest(
  middlewares: readonly JevMiddleware[],
  ctx: JevRequestContext
): Promise<JevDecisionResponse<any> | undefined> {
  for (const mw of middlewares) {
    try {
      const hook = mw.beforeRequest ?? mw.onBeforeExecute;
      if (typeof hook === 'function') {
        const shortCircuit = await hook.call(mw, ctx);
        if (shortCircuit) {
          return shortCircuit;
        }
      }
    } catch (err) {
      // Non-blocking guarantee: Middleware crashes must never disrupt client execution
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (typeof console !== 'undefined' && console.warn) {
        console.warn(`[s1sdk] Middleware "${mw.name}" beforeRequest failed safely: ${errorMsg}`);
      }
    }
  }
  return undefined;
}

/**
 * Execute afterResponse hooks across registered middlewares.
 * Non-blocking: Middleware errors are safely absorbed to protect hot decision path.
 */
export async function executeAfterResponse(
  middlewares: readonly JevMiddleware[],
  ctx: JevRequestContext,
  res: JevDecisionResponse<any>
): Promise<void> {
  for (const mw of middlewares) {
    try {
      const hook = mw.afterResponse ?? mw.onAfterExecute;
      if (typeof hook === 'function') {
        await hook.call(mw, ctx, res);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (typeof console !== 'undefined' && console.warn) {
        console.warn(`[s1sdk] Middleware "${mw.name}" afterResponse failed safely: ${errorMsg}`);
      }
    }
  }
}

/**
 * Execute onError hooks across registered middlewares.
 * Non-blocking: Can optionally recover with a fallback response.
 */
export async function executeOnError(
  middlewares: readonly JevMiddleware[],
  ctx: JevRequestContext,
  error: Error
): Promise<JevDecisionResponse<any> | undefined> {
  for (const mw of middlewares) {
    try {
      if (typeof mw.onError === 'function') {
        const recovered = await mw.onError.call(mw, ctx, error);
        if (recovered) {
          return recovered;
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (typeof console !== 'undefined' && console.warn) {
        console.warn(`[s1sdk] Middleware "${mw.name}" onError failed safely: ${errorMsg}`);
      }
    }
  }
  return undefined;
}

// Canonical S1 Middleware Aliases
export type S1RequestContext<TState = unknown> = JevRequestContext<TState>;
export type S1ResponseContext<TAnswers = unknown> = JevResponseContext<TAnswers>;
export type S1Middleware = JevMiddleware;
