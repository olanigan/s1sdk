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

export class CloudflareWorkerProvider extends JevProviderBase {
  readonly name = 'Cloudflare Workers AI';
  readonly providerId = 'cloudflare-workers-ai';

  private readonly aiBinding?: CloudflareAiBinding;
  private readonly model: string;
  private readonly fallbackProvider?: JevProviderBase;

  constructor(
    aiBindingOrConfig?: CloudflareAiBinding | CloudflareWorkerProviderConfig,
    model = '@cf/typesafe/jev'
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
    const effectiveModel = request.model || options?.model || this.model;

    if (this.aiBinding && typeof this.aiBinding.run === 'function') {
      try {
        const result = await this.aiBinding.run(effectiveModel, {
          state: request.state,
          questions: request.questions
        });

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
          modelUsed: effectiveModel,
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
