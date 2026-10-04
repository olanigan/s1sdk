/**
 * Jev System-1 Decision Client: OpenRouter Decisions API Provider
 * Specification: SPEC-001-jev-sdk-core-client.md (Section 3.2 #3)
 *
 * Endpoint: POST https://openrouter.ai/api/alpha/decisions
 * Default Model: typesafe/jev-latest
 */

import { JevProviderBase, type ProviderMetadata } from './base.js';
import {
  type JevQuestion,
  type JevDecisionRequest,
  type JevDecisionResponse,
  type JevExecutionOptions,
  type InferJevAnswer,
  JevAuthenticationError,
  JevRateLimitError,
  JevTimeoutError,
  JevProviderError
} from '../types.js';

export interface OpenRouterConfig {
  readonly apiKey?: string;
  readonly endpoint?: string;
  readonly model?: string;
}

export class OpenRouterProvider extends JevProviderBase {
  readonly name = 'OpenRouter Decisions API';
  readonly providerId = 'openrouter';

  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly model: string;

  constructor(apiKeyOrConfig: string | OpenRouterConfig, endpoint?: string, model?: string) {
    super();
    if (typeof apiKeyOrConfig === 'string') {
      this.apiKey = apiKeyOrConfig;
      this.endpoint = endpoint || 'https://openrouter.ai/api/alpha/decisions';
      this.model = model || 'typesafe/jev-latest';
    } else {
      this.apiKey = apiKeyOrConfig.apiKey || '';
      this.endpoint = apiKeyOrConfig.endpoint || 'https://openrouter.ai/api/alpha/decisions';
      this.model = apiKeyOrConfig.model || 'typesafe/jev-latest';
    }
  }

  public async execute<TState, TQuestions extends Record<string, JevQuestion>>(
    request: JevDecisionRequest<TState, TQuestions>,
    options?: JevExecutionOptions
  ): Promise<JevDecisionResponse<TQuestions>> {
    const startTime = performance.now();
    const effectiveModel = request.model || options?.model || this.model;

    if (!this.apiKey) {
      throw new JevAuthenticationError(
        'OpenRouter API key is missing. Set OPENROUTER_API_KEY or pass apiKey in constructor.'
      );
    }

    const payload = {
      model: effectiveModel,
      state: request.state,
      questions: request.questions
    };

    const signal = options?.abortSignal;
    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/olanigan/s1sdk',
          'X-Title': 's1sdk'
        },
        body: JSON.stringify(payload),
        signal
      });
    } catch (netErr: any) {
      if (netErr?.name === 'AbortError' || netErr?.code === 'ETIMEDOUT') {
        throw new JevTimeoutError(options?.timeoutMs ?? 10_000);
      }
      throw new JevProviderError(
        `OpenRouter network dispatch failed: ${netErr?.message || String(netErr)}`,
        503,
        true,
        netErr instanceof Error ? netErr : undefined
      );
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      const sanitizedErr = errText.length > 500 ? `${errText.slice(0, 500)}... (truncated)` : errText;
      if (res.status === 401 || res.status === 403) {
        throw new JevAuthenticationError(`OpenRouter unauthorized: ${sanitizedErr || res.statusText}`, res.status);
      }
      if (res.status === 429) {
        const retryAfterHeader = res.headers.get('retry-after');
        const retryAfterMs = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : undefined;
        throw new JevRateLimitError(`OpenRouter rate limit exceeded: ${sanitizedErr || res.statusText}`, retryAfterMs);
      }
      if (res.status === 408 || res.status === 504) {
        throw new JevTimeoutError(options?.timeoutMs ?? 10_000);
      }
      throw new JevProviderError(
        `OpenRouter Decisions API error [${res.status}]: ${sanitizedErr || res.statusText}`,
        res.status,
        res.status >= 500
      );
    }

    let data: any;
    try {
      data = await res.json();
    } catch (parseErr: any) {
      throw new JevProviderError(
        `Failed to parse OpenRouter response as JSON: ${parseErr?.message || String(parseErr)}`,
        res.status,
        res.status >= 500,
        parseErr instanceof Error ? parseErr : undefined
      );
    }
    const elapsed = Math.round(performance.now() - startTime);

    const rawAnswers = data.answers || data;
    const inputTokens =
      data.usage?.input_tokens ??
      data.usage?.inputTokens ??
      (typeof request.state === 'string' ? Math.ceil(request.state.length / 4) : 100);
    const outputTokens = data.usage?.output_tokens ?? data.usage?.outputTokens ?? 0;

    return {
      answers: rawAnswers as { [K in keyof TQuestions]: InferJevAnswer<TQuestions[K]> },
      latencyMs: data.latency_ms || elapsed,
      latency_ms: data.latency_ms || elapsed,
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
  }

  /** Ergonomic alias matching existing codebase calls */
  public async decide<TState, TQuestions extends Record<string, JevQuestion>>(
    request: JevDecisionRequest<TState, TQuestions>
  ): Promise<JevDecisionResponse<TQuestions>> {
    return this.execute(request);
  }

  public async isHealthy(): Promise<boolean> {
    return Boolean(this.apiKey && this.apiKey.length > 0);
  }

  public getMetadata(): ProviderMetadata {
    return {
      providerId: this.providerId,
      defaultModel: this.model,
      supportsLocalExecution: false,
      maxConcurrentRequests: 250
    };
  }
}
