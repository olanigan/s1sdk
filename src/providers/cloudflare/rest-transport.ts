/**
 * Cloudflare Workers AI: REST transport (`POST /accounts/{id}/ai/run/{model}`).
 *
 * Owns transport concerns only: URL construction, auth, envelope unwrapping,
 * HTTP/error-code mapping, `Retry-After`, and `redirect: 'error'`. It performs a
 * single attempt — retry policy lives in the client layer so both transports
 * obey the same backoff instead of silently double-retrying.
 */

import {
  type JevExecutionOptions,
  JevError,
  JevProviderError,
  JevTimeoutError,
  JevValidationError
} from '../../types.js';
import { clientHeader, parseRetryAfterMs, truncateErrorBody } from '../../http.js';
import {
  type CloudflareApiEnvelope,
  type CloudflareTransport,
  isCloudflareErrorEnvelope,
  mapCloudflareApiError
} from './transport.js';

export const DEFAULT_CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

export interface RestTransportConfig {
  readonly apiToken: string;
  readonly accountId: string;
  /** API base; defaults to the public Cloudflare API. */
  readonly endpoint?: string;
}

/**
 * Model ids are `@cf/vendor/model`. Validate instead of URL-encoding: Cloudflare
 * documents the raw path form, and a stray `..` segment must never escape `/ai/run`.
 */
const MODEL_PATH_PATTERN = /^[A-Za-z0-9@][A-Za-z0-9@._/-]*$/;

export class RestTransport implements CloudflareTransport {
  readonly kind = 'rest' as const;
  readonly zeroEgress = false;

  private readonly apiToken: string;
  private readonly accountId: string;
  private readonly baseUrl: string;

  constructor(config: RestTransportConfig) {
    if (!config.apiToken) {
      throw new JevValidationError('Cloudflare REST transport requires an API token.');
    }
    if (!config.accountId) {
      throw new JevValidationError('Cloudflare REST transport requires an account id.');
    }
    this.apiToken = config.apiToken;
    this.accountId = config.accountId;
    this.baseUrl = (config.endpoint ?? DEFAULT_CLOUDFLARE_API_BASE).replace(/\/+$/, '');
  }

  public describe(): string {
    return `REST ${this.baseUrl}/accounts/<accountId>/ai/run (network egress)`;
  }

  /**
   * Authenticated probe of `GET /accounts/{account_id}`.
   * Account-scoped tokens are valid here even though `/user/tokens/verify`
   * rejects them with code 1000 — that endpoint is not a usable health check.
   */
  public async verify(): Promise<boolean> {
    const url = `${this.baseUrl}/accounts/${encodeURIComponent(this.accountId)}`;
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          'X-Client': clientHeader('cf-rest-verify')
        },
        redirect: 'error'
      });
      if (!response.ok) return false;
      const body: any = await response.json().catch(() => undefined);
      return body?.success === true;
    } catch {
      return false;
    }
  }

  public async run(
    model: string,
    payload: Record<string, unknown>,
    options?: JevExecutionOptions
  ): Promise<any> {
    if (!MODEL_PATH_PATTERN.test(model) || model.split('/').some((s) => s === '..' || s === '.')) {
      throw new JevValidationError(
        `Refusing to dispatch unsafe model path "${model}". Expected an id like "@cf/cloudflare/clairic".`
      );
    }

    const url = `${this.baseUrl}/accounts/${encodeURIComponent(this.accountId)}/ai/run/${model}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
          'X-Client': clientHeader('cf-rest')
        },
        body: JSON.stringify(payload),
        signal: options?.abortSignal,
        // Never follow a redirect to an unexpected host with the bearer token attached.
        redirect: 'error'
      });
    } catch (err: any) {
      throw this.mapDispatchError(err, options);
    }

    const rawText = await response.text().catch(() => '');
    let body: unknown;
    if (rawText.trim() !== '') {
      try {
        body = JSON.parse(rawText);
      } catch {
        body = undefined;
      }
    }

    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));

    if (!response.ok) {
      throw mapCloudflareApiError(body ?? rawText, response.status, retryAfterMs);
    }
    if (body === undefined) {
      throw new JevProviderError(
        `Cloudflare Workers AI returned ${response.status} with a non-JSON body: ${truncateErrorBody(rawText) || '(empty)'}`,
        response.status,
        true
      );
    }
    // `success: false` can arrive with HTTP 200, so the envelope outranks res.ok.
    if (isCloudflareErrorEnvelope(body)) {
      throw mapCloudflareApiError(body, response.status, retryAfterMs);
    }

    const envelope = body as CloudflareApiEnvelope;
    const result =
      envelope !== null && typeof envelope === 'object' && 'result' in envelope
        ? envelope.result
        : body;

    if (result === null || result === undefined) {
      throw new JevProviderError(
        `Cloudflare Workers AI returned an empty result for "${model}".`,
        response.status,
        false
      );
    }

    return result;
  }

  private mapDispatchError(err: any, options?: JevExecutionOptions): JevError {
    if (err?.name === 'AbortError' || err?.code === 'ETIMEDOUT') {
      if (options?.abortSignal?.aborted === true) {
        return new JevError('Cloudflare Workers AI REST request aborted by caller', 'JEV_ABORTED', false);
      }
      if (typeof options?.timeoutMs === 'number') {
        return new JevTimeoutError(options.timeoutMs);
      }
      return new JevProviderError('Cloudflare Workers AI REST request timed out', 503, true);
    }
    return new JevProviderError(
      `Cloudflare Workers AI REST dispatch failed: ${err?.message || String(err)}`,
      503,
      true,
      err instanceof Error ? err : undefined
    );
  }
}
