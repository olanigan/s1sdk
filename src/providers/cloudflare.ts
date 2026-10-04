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
 * and determines if the payload requires an internal model selector (such as Clef).
 */
export function normalizeCloudflareModel(model: string): {
  bindingModel: string;
  payloadModel?: 'clef' | 'clef-flash';
} {
  const trimmed = model.trim();
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
  return {
    bindingModel: trimmed,
    payloadModel: isClef ? (trimmed.includes('flash') ? 'clef-flash' : 'clef') : undefined
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
