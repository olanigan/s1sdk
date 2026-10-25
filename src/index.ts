/**
 * Jev System-1 Decision Client: Core SDK Entrypoint
 * Specification: SPEC-001-jev-sdk-core-client.md
 * ADR: ADR-001-modular-decoupling-jevsdk-and-jevops.md
 *
 * Universal, zero-runtime-dependency TypeScript client for System-1 decision routing.
 */

import {
  type JevQuestion,
  type JevDecisionRequest,
  type JevDecisionResponse,
  type JevExecutionOptions,
  type JevProviderType,
  type S1ExtractField,
  type S1ExtractRequest,
  type S1ExtractResponse,
  JevError,
  JevTimeoutError,
  noul,
  choice,
  score,
  extractText,
  extractNumber,
  extractDate,
  extractTime,
  extractDateTime,
  extractDuration,
  extractList,
  extractEstimate,
  extractForecast
} from './types.js';

import {
  type JevMiddleware,
  type JevRequestContext,
  executeBeforeRequest,
  executeAfterResponse,
  executeOnError
} from './middleware.js';

import {
  JevProviderBase,
  OpenRouterProvider,
  TypeSafeProvider,
  CloudflareWorkerProvider,
  HomesteadProvider,
  OllamaProvider,
  type CloudflareAiBinding
} from './providers/index.js';

export interface S1ClientOptions {
  /** Target provider mode ('auto', 'openrouter', 'typesafe', 'cloudflare', 'homestead', 'ollama', 'local') */
  readonly provider?: JevProviderType;
  /** Explicit custom provider instance */
  readonly providerInstance?: JevProviderBase;
  /** API key for authenticated remote providers */
  readonly apiKey?: string;
  /** Custom endpoint URL */
  readonly endpoint?: string;
  /** Default model ID to invoke */
  readonly model?: string;
  /** Cloudflare Workers AI env.AI in-process binding */
  readonly aiBinding?: CloudflareAiBinding;
  /** Ollama / Homestead daemon keep_alive duration (e.g. '5m', '1h', -1) */
  readonly keepAlive?: string | number;
  /** Execution timeout in milliseconds (default: 10,000ms) */
  readonly timeoutMs?: number;
  /** Max retries for retryable network faults (default: 0) */
  readonly maxRetries?: number;
  /** Initial middlewares to register */
  readonly middlewares?: readonly JevMiddleware[];
}

export type JevClientOptions = S1ClientOptions;

export class S1Client {
  private activeProvider: JevProviderBase;
  private readonly defaultOptions: S1ClientOptions;
  private readonly middlewares: JevMiddleware[] = [];

  constructor(options: S1ClientOptions = {}) {
    const isOllama = options.provider === 'ollama';
    this.defaultOptions = {
      timeoutMs: options.timeoutMs ?? (isOllama ? 30_000 : 10_000),
      maxRetries: 0,
      ...options
    };

    if (options.middlewares) {
      this.middlewares.push(...options.middlewares);
    }

    this.activeProvider = this.resolveProvider(options);
  }

  /**
   * Auto-resolve or instantiate the active decision provider
   */
  private resolveProvider(options: S1ClientOptions): JevProviderBase {
    if (options.providerInstance) {
      return options.providerInstance;
    }

    const envProcess = typeof process !== 'undefined' ? process : undefined;
    const envOpenRouterKey = envProcess?.env?.OPENROUTER_API_KEY;
    const envTypeSafeKey = envProcess?.env?.TYPESAFE_API_KEY;
    const envHomesteadUrl =
      envProcess?.env?.HOMESTEAD_API_URL ||
      envProcess?.env?.HOMESTEAD_S1_URL ||
      envProcess?.env?.HOMESTEAD_ENDPOINT;
    const envOllamaHost = envProcess?.env?.OLLAMA_HOST;

    const requested = options.provider;

    if (requested && requested !== 'auto') {
      switch (requested) {
        case 'openrouter':
          return new OpenRouterProvider(options.apiKey || envOpenRouterKey || '', options.endpoint, options.model);
        case 'typesafe':
        case 'typesafe-sdk':
          return new TypeSafeProvider(options.apiKey || envTypeSafeKey || '', options.endpoint, options.model);
        case 'cloudflare':
        case 'cloudflare-worker':
        case 'cloudflare-workers-ai':
          return new CloudflareWorkerProvider(options.aiBinding, options.model);
        case 'homestead':
        case 'local':
          return new HomesteadProvider({
            apiKey: options.apiKey,
            endpoint: options.endpoint,
            model: options.model,
            keepAlive: options.keepAlive
          });
        case 'ollama':
          return new OllamaProvider({
            apiKey: options.apiKey,
            endpoint: options.endpoint || envOllamaHost,
            model: options.model,
            keepAlive: options.keepAlive
          });
        default:
          throw new JevError(`Unsupported or unrecognized provider: "${requested}"`);
      }
    }

    // Auto-discovery heuristics: explicit client options take priority
    if (options.aiBinding) {
      return new CloudflareWorkerProvider(options.aiBinding, options.model);
    }

    if (options.apiKey) {
      return new OpenRouterProvider(options.apiKey, options.endpoint, options.model);
    }

    if (envOllamaHost && !envHomesteadUrl) {
      return new OllamaProvider({
        apiKey: options.apiKey,
        endpoint: options.endpoint || envOllamaHost,
        model: options.model,
        keepAlive: options.keepAlive
      });
    }

    // Default: Batteries-Included Homestead engine serving homerouter-420M locally
    return new HomesteadProvider({
      apiKey: options.apiKey,
      endpoint: options.endpoint || envHomesteadUrl,
      model: options.model || 'homerouter-420M',
      keepAlive: options.keepAlive
    });
  }

  /**
   * Active provider identifier
   */
  public get provider(): string {
    return this.activeProvider.providerId;
  }

  /**
   * Access the resolved provider instance
   */
  public get providerInstance(): JevProviderBase {
    return this.activeProvider;
  }

  /**
   * Register a middleware interceptor in the decision pipeline.
   * Chainable for fluent builder syntax: client.use(mw1).use(mw2)
   */
  public use(middleware: JevMiddleware): this {
    this.middlewares.push(middleware);
    return this;
  }

  /**
   * Primary single-forward-pass System-1 decision execution
   */
  public async decide<
    TState = unknown,
    TQuestions extends Record<string, JevQuestion> = Record<string, JevQuestion>
  >(
    request: JevDecisionRequest<TState, TQuestions>,
    overrideOptions?: JevExecutionOptions
  ): Promise<JevDecisionResponse<TQuestions>> {
    const options: JevExecutionOptions = {
      timeoutMs: this.defaultOptions.timeoutMs,
      maxRetries: this.defaultOptions.maxRetries,
      ...request.options,
      ...overrideOptions
    };

    const requestId =
      options.traceId ||
      `s1_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    const context: JevRequestContext<TState> = {
      id: requestId,
      timestamp: Date.now(),
      state: request.state,
      questions: request.questions,
      options,
      provider: this.activeProvider.providerId,
      metadata: {}
    };

    // 1. Run beforeRequest middlewares (non-blocking)
    const shortCircuit = await executeBeforeRequest(this.middlewares, context);
    if (shortCircuit) {
      await executeAfterResponse(this.middlewares, context, shortCircuit);
      return shortCircuit as JevDecisionResponse<TQuestions>;
    }

    // 2. Execute decision with active provider (handling retries & timeout)
    let response: JevDecisionResponse<TQuestions>;
    try {
      response = await this.executeWithRetry(this.activeProvider, request, options);
    } catch (err: any) {
      const error = err instanceof Error ? err : new JevError(String(err));

      // 3. Run onError middlewares (can recover)
      const recovered = await executeOnError(this.middlewares, context, error);
      if (recovered) {
        await executeAfterResponse(this.middlewares, context, recovered);
        return recovered as JevDecisionResponse<TQuestions>;
      }

      // 4. Transparent error propagation: throw error directly
      throw error;
    }

    // 5. Run afterResponse middlewares (non-blocking)
    await executeAfterResponse(this.middlewares, context, response);

    return response;
  }

  /**
   * SPEC-001 canonical alias for decide()
   */
  public async systemOne<
    TState = unknown,
    TQuestions extends Record<string, JevQuestion> = Record<string, JevQuestion>
  >(
    request: JevDecisionRequest<TState, TQuestions>,
    overrideOptions?: JevExecutionOptions
  ): Promise<JevDecisionResponse<TQuestions>> {
    return this.decide(request, overrideOptions);
  }

  /**
   * High-level single-pass intent routing across discrete candidate actions.
   * Ergonomic batteries-included method for agent tools, workflows, and triage loops.
   */
  public async route(
    state: string | Record<string, unknown>,
    candidates: readonly string[] | Record<string, string>,
    options?: JevExecutionOptions & { questionId?: string; prompt?: string }
  ): Promise<{
    winner: string;
    confidence: number;
    probabilities: Record<string, number>;
    passedGate: boolean;
    latencyMs: number;
    raw: JevDecisionResponse<Record<string, JevQuestion>>;
  }> {
    const qId = options?.questionId || 'route';
    const prompt = options?.prompt || 'Select the most appropriate next action';
    const criteria: Record<string, string> = Array.isArray(candidates)
      ? Object.fromEntries(candidates.map((c) => [c, String(c)]))
      : candidates;

    const response = await this.decide(
      {
        state,
        questions: {
          [qId]: choice(prompt, criteria)
        }
      },
      options
    );

    const ans = response.answers[qId] as any;
    const requestedCandidates = Array.isArray(candidates) ? candidates : Object.keys(candidates);
    const rawProbabilities = (ans?.probabilities ?? {}) as Record<string, number>;

    // Filter and renormalize across requested candidates if returned set is a superset
    let filteredProbabilities: Record<string, number> = {};
    let hasMatching = false;
    for (const c of requestedCandidates) {
      if (rawProbabilities[c] !== undefined) {
        filteredProbabilities[c] = rawProbabilities[c];
        hasMatching = true;
      }
    }

    if (hasMatching) {
      const sum = Object.values(filteredProbabilities).reduce((a, b) => a + b, 0);
      if (sum > 0) {
        for (const k of Object.keys(filteredProbabilities)) {
          filteredProbabilities[k] = Number(((filteredProbabilities[k] ?? 0) / sum).toFixed(4));
        }
      }
    } else {
      filteredProbabilities = rawProbabilities;
    }

    let winner = requestedCandidates[0] || 'unknown';
    let maxP = -1;
    for (const [k, p] of Object.entries(filteredProbabilities)) {
      if (p > maxP) {
        maxP = p;
        winner = k;
      }
    }

    const confidence = maxP >= 0 ? maxP : (typeof ans?.confidence === 'number' ? ans.confidence : 0);
    const threshold = options?.minConfidence ?? 0.90;

    return {
      winner,
      confidence,
      probabilities: filteredProbabilities,
      passedGate: confidence >= threshold,
      latencyMs: response.latencyMs,
      raw: response
    };
  }

  /**
   * Primary single-forward-pass System-1 structured field extraction (Clairic).
   * Extracts typed fields directly from state with calibrated probabilities and span offsets.
   * Supports both (state, fields, options) and (request, options) invocation styles.
   */
  public async extract<
    TState = unknown,
    TFields extends Record<string, S1ExtractField> = Record<string, S1ExtractField>
  >(
    stateOrRequest: TState | S1ExtractRequest<TState, TFields>,
    fieldsOrOptions?: TFields | JevExecutionOptions,
    overrideOptions?: JevExecutionOptions
  ): Promise<S1ExtractResponse<TFields>> {
    let request: S1ExtractRequest<TState, TFields>;
    let options: JevExecutionOptions;

    if (
      stateOrRequest !== null &&
      typeof stateOrRequest === 'object' &&
      'fields' in (stateOrRequest as any)
    ) {
      request = stateOrRequest as S1ExtractRequest<TState, TFields>;
      options = {
        timeoutMs: this.defaultOptions.timeoutMs,
        maxRetries: this.defaultOptions.maxRetries,
        ...request.options,
        ...(fieldsOrOptions as JevExecutionOptions),
        ...overrideOptions
      };
    } else {
      request = {
        state: stateOrRequest as TState,
        fields: (fieldsOrOptions || {}) as TFields
      };
      options = {
        timeoutMs: this.defaultOptions.timeoutMs,
        maxRetries: this.defaultOptions.maxRetries,
        ...overrideOptions
      };
    }

    const provider = this.activeProvider;
    if (typeof (provider as any).extract === 'function') {
      return this.executeExtractWithRetry(provider, request, options);
    }

    throw new JevError(
      `Active provider "${provider.providerId}" does not support structured extraction. Please configure Cloudflare Workers AI with "@cf/cloudflare/clairic".`,
      'UNSUPPORTED_OPERATION'
    );
  }

  /**
   * Internal retry loop for extraction with exponential backoff & full jitter
   */
  private async executeExtractWithRetry<
    TState,
    TFields extends Record<string, S1ExtractField>
  >(
    provider: any,
    request: S1ExtractRequest<TState, TFields>,
    options: JevExecutionOptions
  ): Promise<S1ExtractResponse<TFields>> {
    const maxRetries = options.maxRetries ?? 0;
    const timeoutMs = options.timeoutMs ?? 10_000;

    let attempt = 0;
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const controller = new AbortController();

      if (options.abortSignal) {
        if (options.abortSignal.aborted) {
          throw new JevError('Extraction execution aborted by caller', 'JEV_ABORTED', false);
        }
        options.abortSignal.addEventListener('abort', () => controller.abort(), { once: true });
      }

      const execOptions: JevExecutionOptions = {
        ...options,
        abortSignal: controller.signal
      };

      try {
        if (timeoutMs > 0) {
          const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new JevTimeoutError(timeoutMs));
            }, timeoutMs);
          });

          return await Promise.race([
            provider.extract(request, execOptions),
            timeoutPromise
          ]);
        }
        return await provider.extract(request, execOptions);
      } catch (err: any) {
        attempt++;
        const isRetryable = Boolean(err?.retryable);
        if (attempt > maxRetries || !isRetryable) {
          throw err;
        }

        const base = Math.min(500, 25 * Math.pow(2, attempt));
        const jitter = 0.8 + Math.random() * 0.4;
        const sleepMs = Math.round(base * jitter);
        await new Promise((res) => setTimeout(res, sleepMs));
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    }
  }

  /**
   * Internal retry loop with exponential backoff & full jitter
   */
  private async executeWithRetry<
    TState,
    TQuestions extends Record<string, JevQuestion>
  >(
    provider: JevProviderBase,
    request: JevDecisionRequest<TState, TQuestions>,
    options: JevExecutionOptions
  ): Promise<JevDecisionResponse<TQuestions>> {
    const maxRetries = options.maxRetries ?? 0;
    const timeoutMs = options.timeoutMs ?? 10_000;

    let attempt = 0;
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const controller = new AbortController();

      // Chain external abortSignal if provided
      if (options.abortSignal) {
        if (options.abortSignal.aborted) {
          throw new JevError('Decision execution aborted by caller', 'JEV_ABORTED', false);
        }
        options.abortSignal.addEventListener('abort', () => controller.abort(), { once: true });
      }

      const execOptions: JevExecutionOptions = {
        ...options,
        abortSignal: controller.signal
      };

      try {
        if (timeoutMs > 0) {
          const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new JevTimeoutError(timeoutMs));
            }, timeoutMs);
          });

          return await Promise.race([
            provider.execute(request, execOptions),
            timeoutPromise
          ]);
        }
        return await provider.execute(request, execOptions);
      } catch (err: any) {
        attempt++;
        const isRetryable = Boolean(err?.retryable);
        if (attempt > maxRetries || !isRetryable) {
          throw err;
        }

        // Exponential backoff with jitter: min(500, 25 * 2^attempt) * uniform(0.8, 1.2)
        const base = Math.min(500, 25 * Math.pow(2, attempt));
        const jitter = 0.8 + Math.random() * 0.4;
        const sleepMs = Math.round(base * jitter);
        await new Promise((res) => setTimeout(res, sleepMs));
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    }
  }
}

// Re-export all types, errors, and primitives
export * from './types.js';
export * from './middleware.js';
export * from './providers/index.js';
export * from './judge.js';
export {
  noul,
  choice,
  score,
  extractText,
  extractNumber,
  extractDate,
  extractTime,
  extractDateTime,
  extractDuration,
  extractList,
  extractEstimate,
  extractForecast
};

// Canonical backwards compatibility
export class JevClient extends S1Client {}
