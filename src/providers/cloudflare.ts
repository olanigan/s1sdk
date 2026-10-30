/**
 * Jev System-1 Decision Client: Cloudflare Workers AI Provider
 * Specification: SPEC-001-jev-sdk-core-client.md (Section 3.2 #1)
 *
 * Direct V8 in-process memory bridge executing @cf/typesafe/jev via env.AI binding.
 */

import { JevProviderBase, type ProviderMetadata } from './base.js';
import {
  type JevQuestion,
  type JevDecisionRequest,
  type JevDecisionResponse,
  type JevExecutionOptions,
  type InferJevAnswer,
  type S1ExtractField,
  type S1ExtractRequest,
  type S1ExtractResponse,
  type S1ExtractAnswer,
  type S1ExtractSpan,
  type S1ExtractUsage,
  type InferExtractAnswer,
  CLOUDFLARE_MODELS,
  JevProviderError,
  JevValidationError
} from '../types.js';

export interface CloudflareAiBinding {
  run(model: string, input: any): Promise<any>;
}

export interface CloudflareWorkerProviderConfig {
  readonly aiBinding?: CloudflareAiBinding;
  readonly model?: string;
  readonly fallbackProvider?: JevProviderBase;
}

/**
 * Normalizes user-specified model strings to Cloudflare Workers AI catalog identifiers
 * and determines if the payload requires an internal model selector (such as Clef or Clairic).
 */
export function normalizeCloudflareModel(model: string): {
  bindingModel: string;
  payloadModel?: 'clef' | 'clef-flash' | 'clairic';
} {
  const trimmed = model.trim();
  if (trimmed === 'clairic' || trimmed === '@cf/cloudflare/clairic') {
    return { bindingModel: CLOUDFLARE_MODELS.CLAIRIC, payloadModel: 'clairic' };
  }
  if (trimmed === 'clef' || trimmed === '@cf/cloudflare/clef') {
    return { bindingModel: CLOUDFLARE_MODELS.CLEF, payloadModel: 'clef' };
  }
  if (trimmed === 'clef-flash' || trimmed === '@cf/cloudflare/clef-flash') {
    return { bindingModel: CLOUDFLARE_MODELS.CLEF_FLASH, payloadModel: 'clef-flash' };
  }
  if (trimmed === 'jev' || trimmed === 'typesafe/jev' || trimmed === '@cf/typesafe/jev') {
    return { bindingModel: CLOUDFLARE_MODELS.JEV };
  }
  const isClef = trimmed.includes('clef');
  const isClairic = trimmed.includes('clairic');
  return {
    bindingModel: trimmed,
    payloadModel: isClef
      ? (trimmed.includes('flash') ? 'clef-flash' : 'clef')
      : isClairic
      ? 'clairic'
      : undefined
  };
}

/**
 * Strips non-schema properties (such as redundant `levels` on score)
 * to satisfy Cloudflare Workers AI's strict additionalProperties: false schema validation.
 */
export function sanitizeQuestionsForCloudflare(
  questions: Record<string, JevQuestion>
): Record<string, any> {
  const sanitized: Record<string, any> = {};
  for (const [key, q] of Object.entries(questions)) {
    if (q.type === 'noul') {
      sanitized[key] = q.criteria
        ? { type: 'noul', instructions: q.instructions, criteria: q.criteria }
        : { type: 'noul', instructions: q.instructions };
    } else if (q.type === 'choice') {
      sanitized[key] = {
        type: 'choice',
        instructions: q.instructions,
        criteria: q.criteria
      };
    } else if (q.type === 'score') {
      const criteria = q.criteria || q.levels || [1, 2, 3, 4, 5];
      sanitized[key] = {
        type: 'score',
        instructions: q.instructions,
        criteria
      };
    } else {
      sanitized[key] = q;
    }
  }
  return sanitized;
}

/**
 * Strips non-schema properties and normalizes extraction fields
 * to satisfy Cloudflare Workers AI Clairic schema validation.
 */
export function sanitizeFieldsForCloudflare(
  fields: Record<string, S1ExtractField>
): Record<string, any> {
  const sanitized: Record<string, any> = {};
  for (const [key, field] of Object.entries(fields)) {
    const entry: Record<string, any> = { type: field.type };
    if (field.instructions) {
      entry.instructions = field.instructions;
    }
    // Schema default is 0.5; only send when explicitly configured.
    if (field.nullThreshold !== undefined) {
      entry.null_threshold = field.nullThreshold;
    }
    if (field.type === 'number') {
      if (field.decimals !== undefined) entry.decimals = field.decimals;
      if (field.unit !== undefined) entry.unit = field.unit;
      if (field.integer !== undefined) entry.integer = field.integer;
    } else if (field.type === 'duration') {
      if (field.unit !== undefined) entry.unit = field.unit;
      if (field.integer !== undefined) entry.integer = field.integer;
      if (field.decimals !== undefined) entry.decimals = field.decimals;
    } else if (field.type === 'list') {
      // The API requires `items`; the SDK helper accepts `itemType`.
      const itemType = field.itemType || (field as any).item_type || 'text';
      entry.items = itemType;
      if (field.integer !== undefined) entry.integer = field.integer;
      if (field.decimals !== undefined) entry.decimals = field.decimals;
    } else if (field.type === 'estimate') {
      entry.min = field.min;
      entry.max = field.max;
      if (field.step !== undefined) entry.step = field.step;
      if (field.scale !== undefined) entry.scale = field.scale;
    } else if (field.type === 'forecast') {
      entry.min = field.min;
      entry.max = field.max;
      if (field.horizon !== undefined) entry.horizon = field.horizon;
      if (field.interval !== undefined) entry.interval = field.interval;
      if (field.step !== undefined) entry.step = field.step;
      if (field.scale !== undefined) entry.scale = field.scale;
    }
    sanitized[key] = entry;
  }
  return sanitized;
}

/** Clairic media limits from the published input schema. */
export const CLAIRIC_MEDIA_LIMITS = {
  maxImages: 4,
  maxImageBytes: 4 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024
} as const;

function decodedBase64Bytes(value: string): number {
  const clean = value.replace(/\s+/g, '');
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

/**
 * Validates Clairic image inputs client-side so callers get a typed error
 * instead of an opaque Workers AI 400. Accepts data URLs and
 * `{ content_type, base64 }` objects; remote URLs are rejected by the schema.
 */
export function validateClairicImages(images: readonly unknown[] | undefined): void {
  if (images === undefined) return;
  if (!Array.isArray(images)) {
    throw new JevValidationError('Clairic "images" must be an array.');
  }
  if (images.length > CLAIRIC_MEDIA_LIMITS.maxImages) {
    throw new JevValidationError(
      `Clairic accepts at most ${CLAIRIC_MEDIA_LIMITS.maxImages} images; received ${images.length}.`
    );
  }

  let totalBytes = 0;
  images.forEach((image, index) => {
    let base64: string;
    if (typeof image === 'string') {
      const match = /^data:image\/[a-z0-9.+-]+;base64,(.*)$/is.exec(image);
      if (!match) {
        throw new JevValidationError(
          `Clairic image[${index}] must be a base64 data URL (data:image/...;base64,...); remote URLs are not accepted.`
        );
      }
      base64 = match[1] ?? '';
    } else if (
      image !== null &&
      typeof image === 'object' &&
      typeof (image as any).content_type === 'string' &&
      typeof (image as any).base64 === 'string'
    ) {
      if (!/^image\//i.test((image as any).content_type)) {
        throw new JevValidationError(
          `Clairic image[${index}].content_type must start with "image/"; received "${(image as any).content_type}".`
        );
      }
      base64 = (image as any).base64;
    } else {
      throw new JevValidationError(
        `Clairic image[${index}] must be a data URL or { content_type, base64 }.`
      );
    }

    const bytes = decodedBase64Bytes(base64);
    if (bytes > CLAIRIC_MEDIA_LIMITS.maxImageBytes) {
      throw new JevValidationError(
        `Clairic image[${index}] is ${bytes} bytes decoded; the per-image limit is ${CLAIRIC_MEDIA_LIMITS.maxImageBytes} bytes.`
      );
    }
    totalBytes += bytes;
  });

  if (totalBytes > CLAIRIC_MEDIA_LIMITS.maxTotalBytes) {
    throw new JevValidationError(
      `Clairic images total ${totalBytes} bytes decoded; the combined limit is ${CLAIRIC_MEDIA_LIMITS.maxTotalBytes} bytes.`
    );
  }
}

/**
 * Normalizes a Clairic answer: span tuples, quantiles -> interval_80,
 * guess fallback, and telemetry fields.
 */
export function normalizeClairicAnswer(raw: any): S1ExtractAnswer<any> {
  // The backend keeps `confidence` and `p_null` complementary, so deriving one
  // from the other is safe. Fabricating a score when the backend reported
  // *neither* is not: Clairic estimate/forecast answers carry quantiles only,
  // and inventing `confidence: 1.0` would corrupt calibration auditing.
  const hasConfidence = typeof raw.confidence === 'number';
  const hasPNull = typeof raw.p_null === 'number';
  const confidence = hasConfidence
    ? raw.confidence
    : hasPNull
    ? Math.max(0, 1 - raw.p_null)
    : undefined;
  const pNull = hasPNull
    ? raw.p_null
    : hasConfidence
    ? Math.max(0, 1 - raw.confidence)
    : undefined;

  const normalizeSpan = (span: any): S1ExtractSpan | undefined =>
    Array.isArray(span) && span.length === 2 ? [span[0], span[1]] : undefined;

  const span = normalizeSpan(raw.span);
  const spans = Array.isArray(raw.spans)
    ? raw.spans
        .map((s: any) => normalizeSpan(s))
        .filter((s: S1ExtractSpan | undefined): s is S1ExtractSpan => s !== undefined)
    : undefined;

  const interval80 =
    raw.interval_80 ??
    raw.interval80 ??
    (typeof raw.p10 === 'number' && typeof raw.p90 === 'number'
      ? ([raw.p10, raw.p90] as const)
      : undefined);

  return {
    ...raw,
    value:
      raw.value !== undefined
        ? raw.value
        : raw.guess !== undefined
        ? raw.guess
        : raw.text !== undefined
        ? raw.text
        : null,
    ...(confidence !== undefined ? { confidence } : {}),
    ...(pNull !== undefined ? { p_null: pNull } : {}),
    ...(span ? { span } : {}),
    ...(spans && spans.length > 0 ? { spans } : {}),
    ...(interval80 !== undefined ? { interval_80: interval80 } : {})
  };
}

function normalizeExtractUsage(raw: any): S1ExtractUsage {
  // Never fabricate extraction usage: report the server breakdown, or zero
  // when the endpoint omits it. Cost/telemetry must stay auditable.
  const inputTokens = raw?.input_tokens ?? raw?.inputTokens ?? 0;
  const outputTokens = raw?.output_tokens ?? raw?.outputTokens ?? 0;

  const usage: Record<string, number> = {
    inputTokens,
    outputTokens,
    input_tokens: inputTokens,
    output_tokens: outputTokens
  };

  const tokenPairs = [
    ['state_tokens', 'stateTokens'],
    ['image_tokens', 'imageTokens'],
    ['schema_tokens', 'schemaTokens']
  ] as const;
  for (const [snake, camel] of tokenPairs) {
    if (typeof raw?.[snake] === 'number') {
      usage[snake] = raw[snake];
      usage[camel] = raw[snake];
    }
  }
  if (typeof raw?.passes === 'number') {
    usage.passes = raw.passes;
  }

  return usage as unknown as S1ExtractUsage;
}

export class CloudflareWorkerProvider extends JevProviderBase {
  readonly name = 'Cloudflare Workers AI';
  readonly providerId = 'cloudflare-workers-ai';

  private readonly aiBinding?: CloudflareAiBinding;
  private readonly model: string;
  private readonly fallbackProvider?: JevProviderBase;

  constructor(
    aiBindingOrConfig?: CloudflareAiBinding | CloudflareWorkerProviderConfig,
    model: string = CLOUDFLARE_MODELS.CLEF_FLASH
  ) {
    super();
    if (aiBindingOrConfig && 'run' in aiBindingOrConfig && typeof (aiBindingOrConfig as any).run === 'function') {
      this.aiBinding = aiBindingOrConfig as CloudflareAiBinding;
      this.model = model;
    } else if (aiBindingOrConfig) {
      const cfg = aiBindingOrConfig as CloudflareWorkerProviderConfig;
      this.aiBinding = cfg.aiBinding;
      this.model = cfg.model || model;
      this.fallbackProvider = cfg.fallbackProvider;
    } else {
      this.model = model;
    }
  }

  public async execute<TState, TQuestions extends Record<string, JevQuestion>>(
    request: JevDecisionRequest<TState, TQuestions>,
    options?: JevExecutionOptions
  ): Promise<JevDecisionResponse<TQuestions>> {
    if (!request.questions || typeof request.questions !== 'object') {
      throw new JevValidationError(
        'execute() requires a "questions" object; use extract() for "fields" extraction.'
      );
    }
    const startTime = performance.now();
    const rawModel = request.model || options?.model || this.model;
    const { bindingModel, payloadModel } = normalizeCloudflareModel(rawModel);

    if (this.aiBinding && typeof this.aiBinding.run === 'function') {
      try {
        const payload: Record<string, any> = {
          state: request.state,
          questions: sanitizeQuestionsForCloudflare(request.questions)
        };

        if (payloadModel) {
          payload.model = payloadModel;
        }

        if (request.images && Array.isArray(request.images) && request.images.length > 0) {
          payload.images = request.images;
        }

        const result = await this.aiBinding.run(bindingModel, payload);

        if (result?.error) {
          throw new JevProviderError(
            `Cloudflare Workers AI returned error: ${typeof result.error === 'string' ? result.error : JSON.stringify(result.error)}`,
            500,
            true
          );
        }

        const elapsed = Math.max(1, Math.round(performance.now() - startTime));
        const rawAnswers = result?.answers || result;
        const inputTokens =
          result?.usage?.input_tokens ??
          result?.usage?.inputTokens ??
          (typeof request.state === 'string' ? Math.ceil(request.state.length / 4) : 100);
        const outputTokens = result?.usage?.output_tokens ?? result?.usage?.outputTokens ?? 0;

        return {
          answers: rawAnswers as { [K in keyof TQuestions]: InferJevAnswer<TQuestions[K]> },
          latencyMs: elapsed,
          latency_ms: elapsed,
          providerUsed: this.providerId,
          provider: this.providerId,
          modelUsed: bindingModel,
          isFallback: false,
          usage: {
            inputTokens,
            outputTokens,
            input_tokens: inputTokens,
            output_tokens: outputTokens
          },
          timestamp: Date.now()
        };
      } catch (err: any) {
        if (this.fallbackProvider) {
          if (typeof console !== 'undefined' && console.warn) {
            console.warn('[CloudflareWorkerProvider] Workers AI binding failed, delegating to fallback:', err);
          }
          return this.fallbackProvider.execute(request, options);
        }
        throw new JevProviderError(
          `Cloudflare Workers AI execution failed: ${err?.message || String(err)}`,
          500,
          true,
          err instanceof Error ? err : undefined
        );
      }
    }

    if (this.fallbackProvider) {
      return this.fallbackProvider.execute(request, options);
    }

    throw new JevProviderError(
      'Cloudflare Workers AI binding (env.AI) is missing or does not implement run().',
      500,
      false
    );
  }

  public async decide<TState, TQuestions extends Record<string, JevQuestion>>(
    request: JevDecisionRequest<TState, TQuestions>
  ): Promise<JevDecisionResponse<TQuestions>> {
    return this.execute(request);
  }

  public override async extract<TState, TFields extends Record<string, S1ExtractField>>(
    request: S1ExtractRequest<TState, TFields>,
    options?: JevExecutionOptions
  ): Promise<S1ExtractResponse<TFields>> {
    const startTime = performance.now();
    const rawModel = request.model || options?.model || this.model;
    const { bindingModel, payloadModel } = normalizeCloudflareModel(rawModel);

    // D1a: extraction requires an explicit Clairic model. Silently swapping a
    // configured clef/jev model bills a different model than the caller chose.
    const isClairic =
      bindingModel === CLOUDFLARE_MODELS.CLAIRIC ||
      payloadModel === 'clairic' ||
      bindingModel.includes('clairic');
    if (!isClairic) {
      throw new JevValidationError(
        `extract() requires an explicit Clairic model ("clairic" or "${CLOUDFLARE_MODELS.CLAIRIC}"); received "${rawModel}". Implicit model switching from clef/jev is disabled — pass { model: "clairic" }.`
      );
    }

    validateClairicImages(request.images);

    if (this.aiBinding && typeof this.aiBinding.run === 'function') {
      try {
        const payload: Record<string, any> = {
          model: 'clairic',
          state: request.state,
          fields: sanitizeFieldsForCloudflare(request.fields)
        };

        if (request.images && request.images.length > 0) {
          payload.images = request.images;
        }
        if (request.referenceDate !== undefined) {
          payload.reference_date = request.referenceDate;
        }
        if (request.extractOptions) {
          payload.options = {
            ...(request.extractOptions.includeQuantiles !== undefined
              ? { include_quantiles: request.extractOptions.includeQuantiles }
              : {}),
            ...(request.extractOptions.returnStateText !== undefined
              ? { return_state_text: request.extractOptions.returnStateText }
              : {})
          };
        }

        const result = await this.aiBinding.run(bindingModel, payload);

        if (result?.error) {
          throw new JevProviderError(
            `Cloudflare Workers AI returned error: ${typeof result.error === 'string' ? result.error : JSON.stringify(result.error)}`,
            500,
            true
          );
        }

        const elapsed = Math.max(1, Math.round(performance.now() - startTime));
        const rawAnswers = result?.answers || result?.result?.answers || result?.result || result;

        const normalizedAnswers: Record<string, S1ExtractAnswer<any>> = {};
        for (const [key] of Object.entries(request.fields)) {
          const raw = rawAnswers?.[key];
          if (raw !== undefined && raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
            normalizedAnswers[key] = normalizeClairicAnswer(raw);
          } else if (raw !== undefined) {
            normalizedAnswers[key] = {
              value: raw,
              confidence: 1.0,
              p_null: 0.0
            };
          } else {
            normalizedAnswers[key] = {
              value: null,
              confidence: 0.0,
              p_null: 1.0
            };
          }
        }

        return {
          answers: normalizedAnswers as { [K in keyof TFields]: InferExtractAnswer<TFields[K]> },
          latencyMs: elapsed,
          latency_ms: elapsed,
          providerUsed: this.providerId,
          provider: this.providerId,
          modelUsed: bindingModel,
          isFallback: false,
          truncated: result?.truncated === true,
          ...(typeof result?.state_text === 'string' ? { state_text: result.state_text } : {}),
          usage: normalizeExtractUsage(result?.usage),
          timestamp: Date.now()
        };
      } catch (err: any) {
        if (err instanceof JevValidationError) {
          throw err;
        }
        if (this.fallbackProvider && typeof (this.fallbackProvider as any).extract === 'function') {
          if (typeof console !== 'undefined' && console.warn) {
            console.warn('[CloudflareWorkerProvider] Workers AI binding failed, delegating to fallback:', err);
          }
          return (this.fallbackProvider as any).extract(request, options);
        }
        throw new JevProviderError(
          `Cloudflare Workers AI extraction failed: ${err?.message || String(err)}`,
          500,
          true,
          err instanceof Error ? err : undefined
        );
      }
    }

    if (this.fallbackProvider && typeof (this.fallbackProvider as any).extract === 'function') {
      return (this.fallbackProvider as any).extract(request, options);
    }

    throw new JevProviderError(
      'Cloudflare Workers AI binding (env.AI) is missing or does not implement run().',
      500,
      false
    );
  }

  public async isHealthy(): Promise<boolean> {
    return Boolean(this.aiBinding && typeof this.aiBinding.run === 'function');
  }

  public getMetadata(): ProviderMetadata {
    return {
      providerId: this.providerId,
      defaultModel: this.model,
      supportsLocalExecution: true,
      maxConcurrentRequests: 10_000
    };
  }
}
