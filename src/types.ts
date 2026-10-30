/**
 * Jev System-1 Decision Client: Core Primitives & Type System
 * Specification: SPEC-001-jev-sdk-core-client.md
 * ADR: ADR-001-modular-decoupling-jevsdk-and-jevops.md
 *
 * Wire-compatible with:
 *  1. Cloudflare Workers AI bindings (@cf/typesafe/jev)
 *  2. TypeSafe AI REST APIs (POST https://api.typesafe.ai/v1/systemone)
 *  3. OpenRouter Decisions API (POST https://openrouter.ai/api/alpha/decisions)
 *  4. Homestead / Ollama local silicon runtime
 */

// ==========================================
// 1. Question Primitives
// ==========================================

export interface JevNoulCriteria {
  readonly true?: string;
  readonly false?: string;
}

export interface JevNoulQuestion {
  readonly type: 'noul';
  readonly instructions: string;
  readonly criteria?: JevNoulCriteria;
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
  readonly criteria?: readonly (string | number)[];
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
  | 'homestead'
  | 'ollama'
  | 'local'
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
  readonly abortSignal?: AbortSignal;
  /** Minimum calibrated confidence threshold for operational decision gates (e.g. 0.90) */
  readonly minConfidence?: number;
}

export interface JevImageData {
  readonly content_type: string;
  readonly base64: string;
}

export type JevImageInput = string | JevImageData;

export const CLOUDFLARE_MODELS = {
  JEV: 'typesafe/jev',
  CLEF: '@cf/cloudflare/clef',
  CLEF_FLASH: '@cf/cloudflare/clef-flash',
  CLAIRIC: '@cf/cloudflare/clairic'
} as const;

export type CloudflareDecisionModel =
  | (typeof CLOUDFLARE_MODELS)[keyof typeof CLOUDFLARE_MODELS]
  | (string & {});

export interface JevDecisionRequest<
  TState = unknown,
  TQuestions extends Record<string, JevQuestion> = Record<string, JevQuestion>
> {
  readonly state: TState;
  readonly questions: TQuestions;
  readonly model?: string;
  readonly images?: readonly JevImageInput[];
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

export function noul(
  instructions: string,
  criteria?: JevNoulCriteria
): JevNoulQuestion {
  return Object.freeze(
    criteria ? { type: 'noul', instructions, criteria } : { type: 'noul', instructions }
  );
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
  return Object.freeze({ type: 'score', instructions, levels, criteria: levels });
}

// ==========================================
// 8. Canonical S1 SDK Type Aliases
// ==========================================

export type S1NoulCriteria = JevNoulCriteria;
export type S1NoulQuestion = JevNoulQuestion;
export type S1ChoiceQuestion<TCriteria extends Record<string, string> = Record<string, string>> = JevChoiceQuestion<TCriteria>;
export type S1ScoreQuestion = JevScoreQuestion;
export type S1Question = JevQuestion;
export type S1ImageData = JevImageData;
export type S1ImageInput = JevImageInput;
export const S1_CLOUDFLARE_MODELS = CLOUDFLARE_MODELS;
export type S1CloudflareDecisionModel = CloudflareDecisionModel;

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

// ==========================================
// 9. Extraction Primitives & Types (Clairic)
// ==========================================

export type S1ExtractFieldType =
  | 'text'
  | 'number'
  | 'date'
  | 'time'
  | 'datetime'
  | 'duration'
  | 'list'
  | 'estimate'
  | 'forecast';

/**
 * Options shared by every Clairic field type. `nullThreshold` is the null
 * probability above which the API returns `value: null` (schema default 0.5).
 */
export interface S1ExtractFieldOptions {
  readonly instructions?: string;
  readonly nullThreshold?: number;
}

export interface S1ExtractTextField extends S1ExtractFieldOptions {
  readonly type: 'text';
}

export interface S1ExtractNumberOptions extends S1ExtractFieldOptions {
  readonly decimals?: number;
  readonly unit?: string;
  /** Emit whole numbers only (schema `integer`). */
  readonly integer?: boolean;
}

export interface S1ExtractNumberField extends S1ExtractNumberOptions {
  readonly type: 'number';
}

export interface S1ExtractDateField extends S1ExtractFieldOptions {
  readonly type: 'date';
}

export interface S1ExtractTimeField extends S1ExtractFieldOptions {
  readonly type: 'time';
}

export interface S1ExtractDateTimeField extends S1ExtractFieldOptions {
  readonly type: 'datetime';
}

export interface S1ExtractDurationField extends S1ExtractFieldOptions {
  readonly type: 'duration';
  /** One of seconds, minutes, hours, days, weeks, months, years (API default seconds). */
  readonly unit?: string;
  readonly integer?: boolean;
  readonly decimals?: number;
}

export interface S1ExtractListField extends S1ExtractFieldOptions {
  readonly type: 'list';
  readonly itemType: 'text' | 'number' | 'date';
  readonly integer?: boolean;
  readonly decimals?: number;
}

export type S1ExtractGridStep = number | 'month' | 'year';
export type S1ExtractScale = 'linear' | 'log';

export interface S1ExtractEstimateField extends S1ExtractFieldOptions {
  readonly type: 'estimate';
  readonly min: number | string;
  readonly max: number | string;
  readonly step?: S1ExtractGridStep;
  readonly scale?: S1ExtractScale;
}

export type S1ExtractForecastInterval =
  | 'step'
  | 'minute'
  | 'hour'
  | 'day'
  | 'week'
  | 'month'
  | 'quarter'
  | 'year';

export interface S1ExtractForecastField extends S1ExtractFieldOptions {
  readonly type: 'forecast';
  readonly min: number | string;
  readonly max: number | string;
  /** Number of steps to forecast (schema 1–64). */
  readonly horizon?: number;
  readonly interval?: S1ExtractForecastInterval;
  readonly step?: S1ExtractGridStep;
  readonly scale?: S1ExtractScale;
}

export type S1ExtractField =
  | S1ExtractTextField
  | S1ExtractNumberField
  | S1ExtractDateField
  | S1ExtractTimeField
  | S1ExtractDateTimeField
  | S1ExtractDurationField
  | S1ExtractListField
  | S1ExtractEstimateField
  | S1ExtractForecastField;

/**
 * Clairic returns spans as a two-element array, not an object:
 * `"span": [8, 16]`. Keep the tuple shape so offset math works without an
 * adapter layer.
 */
export type S1ExtractSpan = readonly [start: number, end: number];

export interface S1ExtractAnswer<T = any> {
  readonly value: T | null;
  /**
   * Calibrated confidence score [0.0, 1.0].
   *
   * Omitted when the backend reports neither `confidence` nor `p_null` —
   * Clairic `estimate` / `forecast` answers carry quantiles only. Calibration
   * audits must treat an absent score as "not reported", never as 1.0.
   */
  readonly confidence?: number;
  /**
   * Calibrated probability that the field is absent or null [0.0, 1.0].
   * Same omission rule as `confidence`.
   */
  readonly p_null?: number;
  /** Best-effort value when `value` is null/ambiguous */
  readonly guess?: T | null;
  /** Exact character offset span in the input state */
  readonly span?: S1ExtractSpan;
  /** Per-item spans for list fields */
  readonly spans?: readonly S1ExtractSpan[];
  /** Mean evaluation for numeric estimate fields */
  readonly mean?: number;
  /** Median evaluation for numeric estimate fields */
  readonly median?: number;
  /** 10th percentile for numeric estimate fields */
  readonly p10?: number;
  /** 90th percentile for numeric estimate fields */
  readonly p90?: number;
  /** 80% credible interval [p10, p90] for numeric estimate fields */
  readonly interval_80?: readonly [number, number];
  /** Probability the estimate is below the grid minimum */
  readonly p_below?: number;
  /** Probability the estimate is above the grid maximum */
  readonly p_above?: number;
  /** 99 percentiles when `includeQuantiles` is requested */
  readonly quantiles?: readonly number[];
  /** Per-step estimates for forecast fields */
  readonly steps?: readonly unknown[];
  /** Catch-all for extra backend metadata */
  readonly [key: string]: any;
}

export type InferExtractValue<F extends S1ExtractField> =
  F extends S1ExtractTextField
    ? string
    : F extends S1ExtractNumberField
    ? number
    : F extends S1ExtractDateField
    ? string
    : F extends S1ExtractTimeField
    ? string
    : F extends S1ExtractDateTimeField
    ? string
    : F extends S1ExtractDurationField
    ? string
    : F extends S1ExtractListField
    ? (F['itemType'] extends 'number' ? number[] : string[])
    : F extends S1ExtractEstimateField
    ? number
    : F extends S1ExtractForecastField
    ? number | Record<string, any>
    : any;

export type InferExtractAnswer<F extends S1ExtractField> = S1ExtractAnswer<InferExtractValue<F>>;

/** Clairic-only request options (schema `options`). */
export interface S1ExtractOptions {
  /** Return 99 percentiles for estimate fields. */
  readonly includeQuantiles?: boolean;
  /** Return the exact text that spans index into. */
  readonly returnStateText?: boolean;
}

export interface S1ExtractRequest<
  TState = unknown,
  TFields extends Record<string, S1ExtractField> = Record<string, S1ExtractField>
> {
  readonly state: TState;
  readonly fields: TFields;
  /** Must resolve to Clairic; `extract()` no longer swaps decision models implicitly. */
  readonly model?: string;
  readonly images?: readonly JevImageInput[];
  /** ISO date that anchors dates written without a year. */
  readonly referenceDate?: string;
  /** Clairic payload options (`include_quantiles`, `return_state_text`). */
  readonly extractOptions?: S1ExtractOptions;
  /** Execution options (timeout, retries, abort). */
  readonly options?: JevExecutionOptions;
}

export interface S1ExtractUsage extends JevTokenUsage {
  readonly state_tokens?: number;
  readonly image_tokens?: number;
  readonly schema_tokens?: number;
  readonly passes?: number;
  readonly stateTokens?: number;
  readonly imageTokens?: number;
  readonly schemaTokens?: number;
}

export interface S1ExtractResponse<
  TFields extends Record<string, S1ExtractField> = Record<string, S1ExtractField>
> {
  readonly answers: {
    [K in keyof TFields]: InferExtractAnswer<TFields[K]>;
  };
  readonly latencyMs: number;
  readonly latency_ms: number;
  readonly providerUsed: string;
  readonly provider: string;
  readonly modelUsed: string;
  readonly isFallback: boolean;
  /** True when Clairic split the state or schema and hit the pass limit. */
  readonly truncated: boolean;
  /** Present when `extractOptions.returnStateText` is set. */
  readonly state_text?: string;
  readonly usage?: S1ExtractUsage;
  readonly timestamp: number;
}

// Extraction Constructor Helpers
export function extractText(instructions?: string): S1ExtractTextField {
  return Object.freeze(instructions ? { type: 'text', instructions } : { type: 'text' });
}

export function extractNumber(
  options?: S1ExtractNumberOptions | string
): S1ExtractNumberField {
  if (typeof options === 'string') {
    return Object.freeze({ type: 'number', instructions: options });
  }
  const { instructions, decimals, unit, integer, nullThreshold } = options || {};
  return Object.freeze({
    type: 'number',
    ...(instructions ? { instructions } : {}),
    ...(decimals !== undefined ? { decimals } : {}),
    ...(unit !== undefined ? { unit } : {}),
    ...(integer !== undefined ? { integer } : {}),
    ...(nullThreshold !== undefined ? { nullThreshold } : {})
  });
}

export function extractDate(instructions?: string): S1ExtractDateField {
  return Object.freeze(instructions ? { type: 'date', instructions } : { type: 'date' });
}

export function extractTime(instructions?: string): S1ExtractTimeField {
  return Object.freeze(instructions ? { type: 'time', instructions } : { type: 'time' });
}

export function extractDateTime(instructions?: string): S1ExtractDateTimeField {
  return Object.freeze(instructions ? { type: 'datetime', instructions } : { type: 'datetime' });
}

export function extractDuration(instructions?: string): S1ExtractDurationField {
  return Object.freeze(instructions ? { type: 'duration', instructions } : { type: 'duration' });
}

export interface S1ExtractListOptions extends S1ExtractFieldOptions {
  readonly integer?: boolean;
  readonly decimals?: number;
}

export function extractList(
  itemType: 'text' | 'number' | 'date' = 'text',
  instructions?: string,
  options?: S1ExtractListOptions
): S1ExtractListField {
  return Object.freeze({
    type: 'list',
    itemType,
    ...(instructions ? { instructions } : {}),
    ...(options?.integer !== undefined ? { integer: options.integer } : {}),
    ...(options?.decimals !== undefined ? { decimals: options.decimals } : {}),
    ...(options?.nullThreshold !== undefined ? { nullThreshold: options.nullThreshold } : {})
  });
}

export interface S1ExtractEstimateOptions {
  readonly step?: S1ExtractGridStep;
  readonly scale?: S1ExtractScale;
  readonly nullThreshold?: number;
  readonly instructions?: string;
}

export function extractEstimate(
  min: number | string,
  max: number | string,
  stepOrOptions?: S1ExtractGridStep | S1ExtractEstimateOptions,
  instructions?: string
): S1ExtractEstimateField {
  const options: S1ExtractEstimateOptions =
    stepOrOptions !== null && typeof stepOrOptions === 'object'
      ? stepOrOptions
      : {
          ...(stepOrOptions !== undefined ? { step: stepOrOptions } : {}),
          ...(instructions ? { instructions } : {})
        };
  return Object.freeze({
    type: 'estimate',
    min,
    max,
    ...(options.step !== undefined ? { step: options.step } : {}),
    ...(options.scale !== undefined ? { scale: options.scale } : {}),
    ...(options.nullThreshold !== undefined ? { nullThreshold: options.nullThreshold } : {}),
    ...(options.instructions ? { instructions: options.instructions } : {})
  });
}

export interface S1ExtractForecastOptions {
  readonly min: number | string;
  readonly max: number | string;
  readonly horizon?: number;
  readonly interval?: S1ExtractForecastInterval;
  readonly step?: S1ExtractGridStep;
  readonly scale?: S1ExtractScale;
  readonly nullThreshold?: number;
  readonly instructions?: string;
}

export function extractForecast(options: S1ExtractForecastOptions): S1ExtractForecastField;
export function extractForecast(
  min: number | string,
  max: number | string,
  options?: Omit<S1ExtractForecastOptions, 'min' | 'max'>
): S1ExtractForecastField;
export function extractForecast(
  minOrOptions: number | string | S1ExtractForecastOptions,
  max?: number | string,
  options?: Omit<S1ExtractForecastOptions, 'min' | 'max'>
): S1ExtractForecastField {
  const resolved: S1ExtractForecastOptions =
    typeof minOrOptions === 'object'
      ? minOrOptions
      : { min: minOrOptions, max: max as number | string, ...(options || {}) };
  return Object.freeze({
    type: 'forecast',
    min: resolved.min,
    max: resolved.max,
    ...(resolved.horizon !== undefined ? { horizon: resolved.horizon } : {}),
    ...(resolved.interval !== undefined ? { interval: resolved.interval } : {}),
    ...(resolved.step !== undefined ? { step: resolved.step } : {}),
    ...(resolved.scale !== undefined ? { scale: resolved.scale } : {}),
    ...(resolved.nullThreshold !== undefined ? { nullThreshold: resolved.nullThreshold } : {}),
    ...(resolved.instructions ? { instructions: resolved.instructions } : {})
  });
}

// Jev Extraction Aliases
export type JevExtractFieldType = S1ExtractFieldType;
export type JevExtractTextField = S1ExtractTextField;
export type JevExtractNumberOptions = S1ExtractNumberOptions;
export type JevExtractNumberField = S1ExtractNumberField;
export type JevExtractDateField = S1ExtractDateField;
export type JevExtractListField = S1ExtractListField;
export type JevExtractEstimateField = S1ExtractEstimateField;
export type JevExtractForecastField = S1ExtractForecastField;
export type JevExtractField = S1ExtractField;
export type JevExtractSpan = S1ExtractSpan;
export type JevExtractOptions = S1ExtractOptions;
export type JevExtractUsage = S1ExtractUsage;
export type JevExtractAnswer<T = any> = S1ExtractAnswer<T>;
export type InferJevExtractValue<F extends S1ExtractField> = InferExtractValue<F>;
export type InferJevExtractAnswer<F extends S1ExtractField> = InferExtractAnswer<F>;
export type JevExtractRequest<
  TState = unknown,
  TFields extends Record<string, S1ExtractField> = Record<string, S1ExtractField>
> = S1ExtractRequest<TState, TFields>;
export type JevExtractResponse<
  TFields extends Record<string, S1ExtractField> = Record<string, S1ExtractField>
> = S1ExtractResponse<TFields>;

