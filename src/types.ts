/**
 * Jev System-1 Decision Client: Core Primitives & Type System
 * Specification: SPEC-001-jev-sdk-core-client.md
 * ADR: ADR-001-modular-decoupling-jevsdk-and-jevops.md
 *
 * Wire-compatible with:
 *  1. Cloudflare Workers AI bindings (@cf/typesafe/jev)
 *  2. TypeSafe AI REST APIs (POST https://api.typesafe.ai/v1/systemone)
 *  3. OpenRouter Decisions API (POST https://openrouter.ai/api/alpha/decisions)
 *  4. In-process offline deterministic MockEngine
 */

// ==========================================
// 1. Question Primitives
// ==========================================

export interface JevNoulQuestion {
  readonly type: 'noul';
  readonly instructions: string;
}

export interface JevChoiceQuestion<
  TCriteria extends Record<string, string> = Record<string, string>
> {
  readonly type: 'choice';
  readonly instructions: string;
  readonly criteria: TCriteria;
}

export interface JevScoreQuestion {
  readonly type: 'score';
  readonly instructions: string;
  readonly levels?: readonly (string | number)[];
}

export type JevQuestion =
  | JevNoulQuestion
  | JevChoiceQuestion<Record<string, string>>
  | JevScoreQuestion;

// ==========================================
// 2. Answer Primitives
// ==========================================

export interface JevNoulAnswer {
  /** Calibrated scalar probability [0.0000, 1.0000] */
  readonly noul: number;
  /** Raw logit before sigmoid activation if supported by backend */
  readonly raw_logit?: number;
}

export interface JevChoiceAnswer<K extends string = string> {
  /** The selected discrete classification key */
  readonly choice: K;
  /** Softmax probability of top choice [0.0, 1.0] */
  readonly confidence: number;
  /** Full categorical probability distribution across all criteria keys, summing to 1.0 */
  readonly probabilities: Record<K, number>;
  /** Optional Shannon entropy across the categorical distribution in nats or bits */
  readonly entropy?: number;
}

export interface JevScoreAnswer {
  /** Evaluated ordinal score */
  readonly score: number;
  /** Confidence score [0.0, 1.0] */
  readonly confidence: number;
  /** Optional distribution over score levels */
  readonly probabilities?: Record<string | number, number>;
}

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;

/**
 * Type-level inference mapping a JevQuestion type to its corresponding JevAnswer type
 */
export type InferJevAnswer<T extends JevQuestion> =
  T extends JevNoulQuestion
    ? JevNoulAnswer
    : T extends JevChoiceQuestion<infer C>
    ? JevChoiceAnswer<Extract<keyof C, string>>
    : T extends JevScoreQuestion
    ? JevScoreAnswer
    : JevAnswer;

// ==========================================
// 3. Provider Identifiers
// ==========================================

export type JevProviderType =
  | 'auto'
  | 'openrouter'
  | 'typesafe'
  | 'typesafe-sdk'
  | 'cloudflare'
  | 'cloudflare-worker'
  | 'cloudflare-workers-ai'
  | 'mock'
  | (string & {});

// ==========================================
// 4. Request & Execution Envelope
// ==========================================

export interface JevExecutionOptions {
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly provider?: JevProviderType;
  readonly model?: string;
  readonly tenantId?: string;
  readonly traceId?: string;
  readonly tags?: Record<string, string>;
  readonly fallbackToMock?: boolean;
  readonly abortSignal?: AbortSignal;
}

export interface JevDecisionRequest<
  TState = unknown,
  TQuestions extends Record<string, JevQuestion> = Record<string, JevQuestion>
> {
  readonly state: TState;
  readonly questions: TQuestions;
  readonly model?: string;
  readonly options?: JevExecutionOptions;
}

/** SPEC-001 alias for JevDecisionRequest */
export type JevSystemOneRequest<
  TState = unknown,
  TQuestions extends Record<string, JevQuestion> = Record<string, JevQuestion>
> = JevDecisionRequest<TState, TQuestions>;

// ==========================================
// 5. Response Envelope & Telemetry
// ==========================================

export interface JevTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly input_tokens?: number;
  readonly output_tokens?: number;
}

export interface JevDecisionResponse<
  TQuestions extends Record<string, JevQuestion> = Record<string, JevQuestion>
> {
  readonly answers: {
    [K in keyof TQuestions]: InferJevAnswer<TQuestions[K]>;
  };
  readonly latencyMs: number;
  /** Ergonomic alias for backward compatibility */
  readonly latency_ms: number;
  readonly providerUsed: string;
  /** Ergonomic alias for backward compatibility */
  readonly provider: string;
  readonly modelUsed: string;
  readonly isFallback: boolean;
  readonly usage?: JevTokenUsage;
  readonly timestamp: number;
}

/** SPEC-001 alias for JevDecisionResponse */
export type JevSystemOneResponse<
  TQuestions extends Record<string, JevQuestion> = Record<string, JevQuestion>
> = JevDecisionResponse<TQuestions>;

// ==========================================
// 6. Error Hierarchy
// ==========================================

export class JevError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;
  override readonly cause?: Error;

  constructor(
    message: string,
    code = 'JEV_ERROR',
    retryable = false,
    cause?: Error
  ) {
    super(message);
    this.name = 'JevError';
    this.code = code;
    this.retryable = retryable;
    this.cause = cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class JevAuthenticationError extends JevError {
  public readonly status: number;

  constructor(message = 'Invalid or missing API key for Jev provider', status = 401) {
    super(message, 'JEV_AUTHENTICATION_ERROR', false);
    this.name = 'JevAuthenticationError';
    this.status = status;
    Object.setPrototypeOf(this, JevAuthenticationError.prototype);
  }
}

export class JevRateLimitError extends JevError {
  public readonly status: number;
  public readonly retryAfterMs?: number;

  constructor(
    message = 'Rate limit exceeded for Jev provider',
    retryAfterMs?: number,
    status = 429
  ) {
    super(message, 'JEV_RATE_LIMIT_ERROR', true);
    this.name = 'JevRateLimitError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    Object.setPrototypeOf(this, JevRateLimitError.prototype);
  }
}

export class JevTimeoutError extends JevError {
  public readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`System-1 decision timed out after ${timeoutMs}ms`, 'JEV_TIMEOUT_ERROR', true);
    this.name = 'JevTimeoutError';
    this.timeoutMs = timeoutMs;
    Object.setPrototypeOf(this, JevTimeoutError.prototype);
  }
}

export class JevValidationError extends JevError {
  constructor(message: string) {
    super(message, 'JEV_VALIDATION_ERROR', false);
    this.name = 'JevValidationError';
    Object.setPrototypeOf(this, JevValidationError.prototype);
  }
}

export class JevProviderError extends JevError {
  public readonly status: number;

  constructor(
    message: string,
    status = 500,
    retryable = false,
    cause?: Error
  ) {
    super(message, 'JEV_PROVIDER_ERROR', retryable, cause);
    this.name = 'JevProviderError';
    this.status = status;
    Object.setPrototypeOf(this, JevProviderError.prototype);
  }
}

export class JevCircuitBreakerOpenError extends JevError {
  constructor(providerName: string) {
    super(`Circuit breaker open for provider: ${providerName}`, 'JEV_CIRCUIT_OPEN', false);
    this.name = 'JevCircuitBreakerOpenError';
    Object.setPrototypeOf(this, JevCircuitBreakerOpenError.prototype);
  }
}

// ==========================================
// 7. Constructor Helper Functions
// ==========================================

export function noul(instructions: string): JevNoulQuestion {
  return Object.freeze({ type: 'noul', instructions });
}

export function choice<const T extends Record<string, string>>(
  instructions: string,
  criteria: T
): JevChoiceQuestion<T> {
  return Object.freeze({ type: 'choice', instructions, criteria });
}

export function score(
  instructions: string,
  levels: readonly (string | number)[] = [1, 2, 3, 4, 5]
): JevScoreQuestion {
  return Object.freeze({ type: 'score', instructions, levels });
}

// ==========================================
// 8. Canonical S1 SDK Type Aliases
// ==========================================

export type S1NoulQuestion = JevNoulQuestion;
export type S1ChoiceQuestion<TCriteria extends Record<string, string> = Record<string, string>> = JevChoiceQuestion<TCriteria>;
export type S1ScoreQuestion = JevScoreQuestion;
export type S1Question = JevQuestion;

export type S1NoulAnswer = JevNoulAnswer;
export type S1ChoiceAnswer<K extends string = string> = JevChoiceAnswer<K>;
export type S1ScoreAnswer = JevScoreAnswer;
export type S1Answer = JevAnswer;
export type InferS1Answer<T extends S1Question> = InferJevAnswer<T>;

export type S1ProviderType = JevProviderType;
export type S1ExecutionOptions = JevExecutionOptions;
export type S1DecisionRequest<TState = unknown, TQuestions extends Record<string, S1Question> = Record<string, S1Question>> = JevDecisionRequest<TState, TQuestions>;
export type S1SystemOneRequest<TState = unknown, TQuestions extends Record<string, S1Question> = Record<string, S1Question>> = JevSystemOneRequest<TState, TQuestions>;
export type S1TokenUsage = JevTokenUsage;
export type S1DecisionResponse<TQuestions extends Record<string, S1Question> = Record<string, S1Question>> = JevDecisionResponse<TQuestions>;
export type S1SystemOneResponse<TQuestions extends Record<string, S1Question> = Record<string, S1Question>> = JevSystemOneResponse<TQuestions>;

export const S1Error = JevError;
export type S1Error = JevError;
export const S1AuthenticationError = JevAuthenticationError;
export type S1AuthenticationError = JevAuthenticationError;
export const S1RateLimitError = JevRateLimitError;
export type S1RateLimitError = JevRateLimitError;
export const S1TimeoutError = JevTimeoutError;
export type S1TimeoutError = JevTimeoutError;
export const S1ValidationError = JevValidationError;
export type S1ValidationError = JevValidationError;
export const S1ProviderError = JevProviderError;
export type S1ProviderError = JevProviderError;
export const S1CircuitBreakerOpenError = JevCircuitBreakerOpenError;
export type S1CircuitBreakerOpenError = JevCircuitBreakerOpenError;
