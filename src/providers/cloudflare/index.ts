/**
 * Jev System-1 Decision Client: Cloudflare Workers AI provider
 * Specification: SPEC-001-jev-sdk-core-client.md (Section 3.2 #1)
 *
 * One vendor, two transports:
 *  - `env.AI` binding  — in-process, zero egress, Workers runtime
 *  - REST (`/accounts/{id}/ai/run/{model}`) — any runtime, apiToken + accountId
 *
 * The transport is chosen once, at construction. It never changes at runtime and
 * there is no cross-transport fallback: a broken binding must not silently become
 * an outbound, billable REST call. Cross-*provider* fallback stays explicit via
 * `fallbackProvider`.
 *
 * Vendor semantics (payload shaping, capability gates, answer normalization) live
 * in `./protocol.ts` and are shared by both transports.
 */

import { JevProviderBase, type ProviderMetadata } from '../base.js';
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
  type S1ExtractUsage,
  type InferExtractAnswer,
  CLOUDFLARE_MODELS,
  JevError,
  JevProviderError,
  JevValidationError
} from '../../types.js';
import {
  normalizeCloudflareModel,
  sanitizeQuestionsForCloudflare,
  sanitizeFieldsForCloudflare,
  validateClairicImages,
  normalizeClairicAnswer,
  normalizeExtractUsage,
  type CloudflareAiBinding
} from './protocol.js';
import type { CloudflareTransport, CloudflareTransportKind } from './transport.js';
import { BindingTransport } from './binding-transport.js';
import { RestTransport } from './rest-transport.js';

export interface CloudflareProviderConfig {
  /** Workers runtime in-process binding (`env.AI`). */
  readonly aiBinding?: CloudflareAiBinding;
  /** REST credentials; required when no binding is supplied. */
  readonly apiToken?: string;
  /** REST account id; required when no binding is supplied. */
  readonly accountId?: string;
  /** API base for REST; defaults to the public Cloudflare API. */
  readonly endpoint?: string;
  /**
   * Pin the transport. Omit to use the binding when present, else REST.
   * Pinning a transport that the configuration cannot satisfy throws immediately
   * instead of degrading at request time.
   */
  readonly transport?: CloudflareTransportKind;
  readonly model?: string;
  readonly fallbackProvider?: JevProviderBase;
}

const NOT_CONFIGURED_MESSAGE =
  'Cloudflare Workers AI is not configured: supply an env.AI binding ' +
  '({ aiBinding }) inside a Worker, or REST credentials ({ apiToken, accountId }).';

function resolveTransport(config: CloudflareProviderConfig): CloudflareTransport | undefined {
  const bindingOk = Boolean(config.aiBinding && typeof (config.aiBinding as any).run === 'function');
  const hasCredentials = Boolean(config.apiToken && config.accountId);

  if (config.transport === 'binding') {
    if (!bindingOk) {
      throw new JevProviderError(
        'Cloudflare transport "binding" was pinned but no valid env.AI binding was supplied.',
        500,
        false
      );
    }
    return new BindingTransport(config.aiBinding as CloudflareAiBinding);
  }

  if (config.transport === 'rest') {
    if (!hasCredentials) {
      throw new JevProviderError(
        'Cloudflare transport "rest" was pinned but apiToken/accountId are missing.',
        500,
        false
      );
    }
    return new RestTransport({
      apiToken: config.apiToken as string,
      accountId: config.accountId as string,
      endpoint: config.endpoint
    });
  }

  // Binding wins when both are configured: it is the zero-egress path, and
  // silently escalating to REST would break the zero-egress invariant.
  if (bindingOk) return new BindingTransport(config.aiBinding as CloudflareAiBinding);
  if (hasCredentials) {
    return new RestTransport({
      apiToken: config.apiToken as string,
      accountId: config.accountId as string,
      endpoint: config.endpoint
    });
  }
  return undefined;
}

export class CloudflareProvider extends JevProviderBase {
  readonly name = 'Cloudflare Workers AI';
  readonly providerId = 'cloudflare-workers-ai';

  private readonly transport?: CloudflareTransport;
  private readonly model: string;
  private readonly fallbackProvider?: JevProviderBase;

  constructor(
    aiBindingOrConfig?: CloudflareAiBinding | CloudflareProviderConfig,
    model: string = CLOUDFLARE_MODELS.CLEF_FLASH
  ) {
    super();

    let config: CloudflareProviderConfig;
    if (
      aiBindingOrConfig &&
      typeof aiBindingOrConfig === 'object' &&
      'run' in aiBindingOrConfig &&
      typeof (aiBindingOrConfig as any).run === 'function'
    ) {
      config = { aiBinding: aiBindingOrConfig as CloudflareAiBinding, model };
    } else {
      config = (aiBindingOrConfig as CloudflareProviderConfig | undefined) ?? { model };
    }

    this.model = config.model || model;
    this.fallbackProvider = config.fallbackProvider;
    this.transport = resolveTransport(config);
  }

  /** Active transport kind, or `'none'` when the provider is unconfigured. */
  public get transportKind(): CloudflareTransportKind | 'none' {
    return this.transport ? this.transport.kind : 'none';
  }

  /** True when the active transport provably makes no outbound network calls. */
  public get isZeroEgress(): boolean {
    return this.transport ? this.transport.zeroEgress : false;
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
    const { modelId, payloadModel } = normalizeCloudflareModel(rawModel);

    const transport = this.transport;
    if (!transport) {
      if (this.fallbackProvider) {
        return this.fallbackProvider.execute(request, options);
      }
      throw new JevProviderError(NOT_CONFIGURED_MESSAGE, 500, false);
    }

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

      const result = await transport.run(modelId, payload, options);

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
        modelUsed: modelId,
        transport: transport.kind,
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
          console.warn('[CloudflareProvider] Workers AI call failed, delegating to fallback:', err);
        }
        return this.fallbackProvider.execute(request, options);
      }
      // Preserve the typed error (status + retryable) instead of collapsing
      // every failure into a retryable 500.
      if (err instanceof JevError) throw err;
      throw new JevProviderError(
        `Cloudflare Workers AI execution failed: ${err?.message || String(err)}`,
        500,
        true,
        err instanceof Error ? err : undefined
      );
    }
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
    const { modelId, payloadModel } = normalizeCloudflareModel(rawModel);

    // D1a: extraction requires an explicit Clairic model. Silently swapping a
    // configured clef/jev model bills a different model than the caller chose.
    const isClairic =
      modelId === CLOUDFLARE_MODELS.CLAIRIC ||
      payloadModel === 'clairic' ||
      modelId.includes('clairic');
    if (!isClairic) {
      throw new JevValidationError(
        `extract() requires an explicit Clairic model ("clairic" or "${CLOUDFLARE_MODELS.CLAIRIC}"); received "${rawModel}". Implicit model switching from clef/jev is disabled — pass { model: "clairic" }.`
      );
    }

    validateClairicImages(request.images);

    const transport = this.transport;
    if (!transport) {
      return this.delegateExtractOrThrow(request, options);
    }

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

      const result = await transport.run(modelId, payload, options);

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
        modelUsed: modelId,
        transport: transport.kind,
        isFallback: false,
        truncated: result?.truncated === true,
        ...(typeof result?.state_text === 'string' ? { state_text: result.state_text } : {}),
        usage: normalizeExtractUsage(result?.usage) as S1ExtractUsage,
        timestamp: Date.now()
      };
    } catch (err: any) {
      if (err instanceof JevValidationError) {
        throw err;
      }
      if (this.fallbackProvider && typeof (this.fallbackProvider as any).extract === 'function') {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[CloudflareProvider] Workers AI call failed, delegating to fallback:', err);
        }
        return (this.fallbackProvider as any).extract(request, options);
      }
      if (err instanceof JevError) throw err;
      throw new JevProviderError(
        `Cloudflare Workers AI extraction failed: ${err?.message || String(err)}`,
        500,
        true,
        err instanceof Error ? err : undefined
      );
    }
  }

  private delegateExtractOrThrow<TState, TFields extends Record<string, S1ExtractField>>(
    request: S1ExtractRequest<TState, TFields>,
    options?: JevExecutionOptions
  ): Promise<S1ExtractResponse<TFields>> {
    if (this.fallbackProvider && typeof (this.fallbackProvider as any).extract === 'function') {
      return (this.fallbackProvider as any).extract(request, options);
    }
    throw new JevProviderError(NOT_CONFIGURED_MESSAGE, 500, false);
  }

  /**
   * Configuration-level health check: does this provider have a usable transport?
   * Deliberately makes no network call — circuit breakers must not generate traffic.
   * Use `verifyCredentials()` for an authenticated probe.
   */
  public async isHealthy(): Promise<boolean> {
    return this.transport !== undefined;
  }

  /**
   * Authenticated REST probe of `GET /accounts/{account_id}`.
   * Returns `false` for a binding: an in-process binding has no credentials to
   * verify, and probing it would mean making the very network call it exists to avoid.
   */
  public async verifyCredentials(): Promise<boolean> {
    if (!this.transport?.verify) return false;
    return this.transport.verify();
  }

  public getMetadata(): ProviderMetadata {
    return {
      providerId: this.providerId,
      defaultModel: this.model,
      supportsLocalExecution: this.isZeroEgress,
      maxConcurrentRequests: 10_000,
      transport: this.transportKind,
      zeroEgress: this.isZeroEgress,
      supportedTransports: ['binding', 'rest']
    };
  }
}

// Public surface preserved from the pre-transport-split module: pure protocol
// helpers, transport types and both transports stay importable from the package.
export * from './protocol.js';
export * from './transport.js';
export * from './binding-transport.js';
export * from './rest-transport.js';
