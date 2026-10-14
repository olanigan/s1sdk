/**
 * Jev System-1 Decision Client: Homestead Local S1 Provider
 * Specification: SPEC-002-ollama-systemone-sdm-specification.md
 *
 * Provides zero-runtime-dependency local execution via Homestead's unified
 * S1 decision daemon or direct Ollama /v1/systemone endpoint.
 *
 * Endpoints:
 *  - Homestead Daemon: POST http://127.0.0.1:18765/v1/systemone (default)
 *  - Ollama Daemon:    POST http://127.0.0.1:11434/v1/systemone
 *
 * Supports native SDM models (tev1, nanojev) and adapted SLMs (qwen, smollm2, gliner).
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

export interface HomesteadConfig {
  /**
   * Endpoint URL for Homestead or Ollama System-1 daemon.
   * Defaults to 'http://127.0.0.1:18765/v1/systemone' or env HOMESTEAD_API_URL / HOMESTEAD_S1_URL.
   * If mode is 'ollama', defaults to 'http://127.0.0.1:11434/v1/systemone'.
   */
  readonly endpoint?: string;

  /**
   * Default model ID (e.g., 'local', 'tev1:0.8b', 'tev1', 'qwen3.5:0.8b', 'nanojev').
   * Default: 'local'
   */
  readonly model?: string;

  /**
   * Optional bearer token if Homestead daemon is run in authenticated mode.
   */
  readonly apiKey?: string;

  /**
   * Ollama / Homestead keep_alive duration (e.g. '5m', '1h', -1).
   */
  readonly keepAlive?: string | number;
}

export class HomesteadProvider extends JevProviderBase {
  readonly name: string = 'Homestead Sovereign S1 Provider';
  readonly providerId: string = 'homestead';

  protected readonly endpoint: string;
  protected readonly model: string;
  protected readonly apiKey?: string;
  protected readonly keepAlive?: string | number;

  constructor(config?: HomesteadConfig | string, endpoint?: string, model?: string) {
    super();
    if (typeof config === 'string') {
      this.apiKey = config;
      this.endpoint = endpoint || this.detectDefaultEndpoint();
      this.model = model || 'homerouter-420M';
    } else {
      this.apiKey = config?.apiKey;
      this.endpoint = config?.endpoint || this.detectDefaultEndpoint();
      this.model = config?.model || 'homerouter-420M';
      this.keepAlive = config?.keepAlive;
    }
  }

  private detectDefaultEndpoint(): string {
    const envProcess = typeof process !== 'undefined' ? process : undefined;
    const envUrl =
      envProcess?.env?.HOMESTEAD_API_URL ||
      envProcess?.env?.HOMESTEAD_S1_URL ||
      envProcess?.env?.HOMESTEAD_ENDPOINT;
    if (envUrl) {
      return envUrl.endsWith('/v1/systemone') ? envUrl : `${envUrl.replace(/\/+$/, '')}/v1/systemone`;
    }
    return 'http://127.0.0.1:8080/v1/systemone';
  }

  public async execute<TState, TQuestions extends Record<string, JevQuestion>>(
    request: JevDecisionRequest<TState, TQuestions>,
    options?: JevExecutionOptions
  ): Promise<JevDecisionResponse<TQuestions>> {
    const startTime = performance.now();
    const effectiveModel = request.model || options?.model || this.model;

    const payload: Record<string, unknown> = {
      model: effectiveModel,
      state: request.state,
      questions: request.questions
    };

    if (this.keepAlive !== undefined) {
      payload.keep_alive = this.keepAlive;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Client': 's1sdk/0.1.0'
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const signal = options?.abortSignal;
    let res: Response;
    const isDefaultPort = this.endpoint.includes(':8080/');
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal
      });
    } catch (netErr: any) {
      if (isDefaultPort) {
        const altEndpoint = this.endpoint.replace(':8080/', ':18765/');
        try {
          res = await fetch(altEndpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal
          });
        } catch {
          if (netErr?.name === 'AbortError' || netErr?.code === 'ETIMEDOUT') {
            throw new JevTimeoutError(options?.timeoutMs ?? 10_000);
          }
          throw new JevProviderError(
            `Homestead S1 daemon connection failed at ${this.endpoint} (and fallback ${altEndpoint}): ${netErr?.message || String(netErr)}. Ensure 'homestead serve homerouter' is running locally.`,
            503,
            true,
            netErr instanceof Error ? netErr : undefined
          );
        }
      } else {
        if (netErr?.name === 'AbortError' || netErr?.code === 'ETIMEDOUT') {
          throw new JevTimeoutError(options?.timeoutMs ?? 10_000);
        }
        throw new JevProviderError(
          `Homestead S1 daemon connection failed at ${this.endpoint}: ${netErr?.message || String(netErr)}. Ensure 'homestead serve homerouter' is running locally.`,
          503,
          true,
          netErr instanceof Error ? netErr : undefined
        );
      }
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      const sanitizedErr = errText.length > 500 ? `${errText.slice(0, 500)}... (truncated)` : errText;

      if (res.status === 401 || res.status === 403) {
        throw new JevAuthenticationError(`Homestead daemon unauthorized: ${sanitizedErr || res.statusText}`, res.status);
      }
      if (res.status === 429) {
        throw new JevRateLimitError(`Homestead daemon rate limit exceeded: ${sanitizedErr || res.statusText}`);
      }
      if (res.status === 408 || res.status === 504) {
        throw new JevTimeoutError(options?.timeoutMs ?? 10_000);
      }
      throw new JevProviderError(
        `Homestead S1 execution error [${res.status}]: ${sanitizedErr || res.statusText}`,
        res.status,
        res.status >= 500
      );
    }

    let data: any;
    try {
      data = await res.json();
    } catch (parseErr: any) {
      throw new JevProviderError(
        `Failed to parse Homestead S1 response as JSON: ${parseErr?.message || String(parseErr)}`,
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
      data.prompt_eval_count ??
      (typeof request.state === 'string' ? Math.ceil(request.state.length / 4) : 100);

    const outputTokens =
      data.usage?.output_tokens ??
      data.usage?.outputTokens ??
      data.eval_count ??
      Object.keys(request.questions).length;

    const latencyMs = data.latency_ms ?? data.latencyMs ?? elapsed;

    return {
      answers: rawAnswers as { [K in keyof TQuestions]: InferJevAnswer<TQuestions[K]> },
      latencyMs,
      latency_ms: latencyMs,
      providerUsed: data.provider || this.providerId,
      provider: data.provider || this.providerId,
      modelUsed: data.model || effectiveModel,
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
    try {
      const baseUrl = this.endpoint.replace(/\/v1\/systemone$/, '');
      const healthUrl = `${baseUrl}/health`;
      const res = await fetch(healthUrl, { method: 'GET', signal: AbortSignal.timeout(1500) });
      return res.ok;
    } catch {
      return false;
    }
  }

  public getMetadata(): ProviderMetadata {
    return {
      providerId: this.providerId,
      defaultModel: this.model,
      supportsLocalExecution: true,
      maxConcurrentRequests: 100
    };
  }
}

/**
 * Direct Ollama System-1 Provider.
 * Connects directly to Ollama's native `/v1/systemone` endpoint for tev1 / tev1:0.8b.
 */
export class OllamaProvider extends HomesteadProvider {
  override readonly name = 'Ollama System-1 Provider';
  override readonly providerId = 'ollama';

  constructor(config?: HomesteadConfig | string, endpoint?: string, model?: string) {
    if (typeof config === 'string') {
      super(config, endpoint || 'http://127.0.0.1:11434/v1/systemone', model || 'tev1:0.8b');
    } else {
      super({
        ...config,
        endpoint: config?.endpoint || 'http://127.0.0.1:11434/v1/systemone',
        model: config?.model || 'tev1:0.8b'
      });
    }
  }

  override getMetadata(): ProviderMetadata {
    return {
      providerId: this.providerId,
      defaultModel: this.model,
      supportsLocalExecution: true,
      maxConcurrentRequests: 64
    };
  }
}
