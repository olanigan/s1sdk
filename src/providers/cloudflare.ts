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
  type InferExtractAnswer,
  CLOUDFLARE_MODELS,
  JevProviderError
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
    if (field.type === 'number') {
      if (field.decimals !== undefined) entry.decimals = field.decimals;
      if (field.unit !== undefined) entry.unit = field.unit;
    } else if (field.type === 'list') {
      const itemType = (field as any).itemType || (field as any).item_type || 'text';
      entry.item_type = itemType;
    } else if (field.type === 'estimate') {
      entry.min = field.min;
      entry.max = field.max;
      if (field.step !== undefined) entry.step = field.step;
    } else if (field.type === 'forecast') {
      if ((field as any).horizon !== undefined) entry.horizon = (field as any).horizon;
    }
    sanitized[key] = entry;
  }
  return sanitized;
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
    if (!(request as any).questions && (request as any).fields) {
      return this.extract(request as any, options) as any;
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

    // If model wasn't explicitly Clairic and defaults to clef-flash / clef / jev, use CLAIRIC for extract()
    const targetBindingModel =
      bindingModel === CLOUDFLARE_MODELS.CLEF_FLASH ||
      bindingModel === CLOUDFLARE_MODELS.CLEF ||
      bindingModel === CLOUDFLARE_MODELS.JEV
        ? CLOUDFLARE_MODELS.CLAIRIC
        : bindingModel;
    const targetPayloadModel =
      targetBindingModel === CLOUDFLARE_MODELS.CLAIRIC ? 'clairic' : payloadModel;

    if (this.aiBinding && typeof this.aiBinding.run === 'function') {
      try {
        const payload: Record<string, any> = {
          state: request.state,
          fields: sanitizeFieldsForCloudflare(request.fields)
        };

        if (targetPayloadModel) {
          payload.model = targetPayloadModel;
        }

        if (request.images && Array.isArray(request.images) && request.images.length > 0) {
          payload.images = request.images;
        }

        const result = await this.aiBinding.run(targetBindingModel, payload);

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
            const confidence =
              typeof raw.confidence === 'number'
                ? raw.confidence
                : typeof raw.p_null === 'number'
                ? Math.max(0, 1 - raw.p_null)
                : 1.0;
            const pNull =
              typeof raw.p_null === 'number'
                ? raw.p_null
                : typeof raw.confidence === 'number'
                ? Math.max(0, 1 - raw.confidence)
                : 0.0;

            normalizedAnswers[key] = {
              ...raw,
              value: raw.value !== undefined ? raw.value : (raw.text !== undefined ? raw.text : null),
              confidence,
              p_null: pNull,
              ...(raw.span ? { span: raw.span } : {}),
              ...(raw.median !== undefined ? { median: raw.median } : {}),
              ...(raw.interval_80 !== undefined
                ? { interval_80: raw.interval_80 }
                : (raw.interval80 !== undefined ? { interval_80: raw.interval80 } : {}))
            };
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

        const inputTokens =
          result?.usage?.input_tokens ??
          result?.usage?.inputTokens ??
          (typeof request.state === 'string' ? Math.ceil(request.state.length / 4) : 100);
        const outputTokens = result?.usage?.output_tokens ?? result?.usage?.outputTokens ?? 0;

        return {
          answers: normalizedAnswers as { [K in keyof TFields]: InferExtractAnswer<TFields[K]> },
          latencyMs: elapsed,
          latency_ms: elapsed,
          providerUsed: this.providerId,
          provider: this.providerId,
          modelUsed: targetBindingModel,
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
