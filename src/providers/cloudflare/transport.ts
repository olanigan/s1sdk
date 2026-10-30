/**
 * Cloudflare Workers AI: transport seam.
 *
 * A transport answers exactly one question: *how do these bytes reach Cloudflare,
 * and how does the reply come back?* It MUST resolve to the same object shape that
 * `env.AI.run()` returns — envelope already unwrapped, failures already thrown as
 * typed errors. Everything above this line (payload shaping, capability gating,
 * answer normalization) is transport-blind.
 *
 * This seam exists so the REST path cannot grow a second copy of the Clairic
 * normalizer: a duplicated normalizer means duplicated calibration bugs.
 */

import {
  type JevExecutionOptions,
  JevAuthenticationError,
  JevError,
  JevProviderError,
  JevRateLimitError,
  JevValidationError
} from '../../types.js';

export type CloudflareTransportKind = 'binding' | 'rest';

export interface CloudflareTransport {
  readonly kind: CloudflareTransportKind;
  /**
   * True only when the transport provably cannot make an outbound network call.
   * The in-process `env.AI` binding is zero-egress; REST is not, by definition.
   */
  readonly zeroEgress: boolean;
  run(
    model: string,
    payload: Record<string, unknown>,
    options?: JevExecutionOptions
  ): Promise<any>;
  /** Human-readable dispatch description for logs and provenance records. */
  describe(): string;
  /**
   * Optional authenticated liveness probe. Returns `false` for transports with no
   * credentials to verify (a binding is validated by using it). Implementations
   * must never throw: a probe is a yes/no question.
   */
  verify?(): Promise<boolean>;
}

/** The REST envelope Cloudflare wraps every `/ai/run` reply in. */
export interface CloudflareApiEnvelope {
  readonly success?: boolean;
  readonly result?: any;
  readonly errors?: ReadonlyArray<{ readonly code?: number; readonly message?: string }>;
  readonly messages?: readonly unknown[];
}

export function isCloudflareErrorEnvelope(body: unknown): body is CloudflareApiEnvelope {
  if (body === null || typeof body !== 'object') return false;
  const envelope = body as CloudflareApiEnvelope;
  if (envelope.success === false) return true;
  return Array.isArray(envelope.errors) && envelope.errors.length > 0;
}

/**
 * Explains the one Cloudflare message that actively misleads.
 *
 * Verified 2026-10-29: a malformed nested field (e.g. `choice.criteria` as an
 * array) returns HTTP 400 code 5006 with "required properties at '/' are
 * 'model,state,questions'" — the three properties that are demonstrably present.
 * Forwarding that verbatim makes callers debug the wrong layer.
 */
export function explainCloudflareValidationMessage(message: string): string {
  if (!/required properties at '\/'/i.test(message)) return message;
  return (
    `${message} — note: the root properties were sent; this message is emitted for ` +
    `nested schema failures too. Check nested field shapes (for example choice ` +
    `criteria must be an object of key -> description, not an array).`
  );
}

/** Maps an HTTP status plus Cloudflare envelope onto the SDK error hierarchy. */
export function mapCloudflareApiError(
  body: unknown,
  status: number,
  retryAfterMs?: number
): JevError {
  const envelope = (body ?? {}) as CloudflareApiEnvelope;
  const first = Array.isArray(envelope.errors) ? envelope.errors[0] : undefined;
  const code = typeof first?.code === 'number' ? first.code : undefined;
  const detail =
    typeof first?.message === 'string' && first.message.trim() !== ''
      ? first.message.trim()
      : `HTTP ${status}`;

  const label = `Cloudflare Workers AI error [${status}${code !== undefined ? `/${code}` : ''}]: ${detail}`;

  if (code === 10000 || status === 401 || status === 403) {
    return new JevAuthenticationError(
      `${label}. Check CLOUDFLARE_API_TOKEN — account-scoped tokens are valid on ` +
        `/accounts/{account_id} even though /user/tokens/verify rejects them.`,
      status
    );
  }
  if (status === 429) {
    return new JevRateLimitError(label, retryAfterMs, status);
  }
  if (status === 408 || status === 504) {
    return new JevProviderError(`${label} (upstream timeout)`, status, true);
  }
  if (status === 400 || status === 422) {
    if (code === 7000 || /no route for that uri/i.test(detail)) {
      return new JevProviderError(
        `${label}. The model path is not routable — check the model id (Clairic is ` +
          `"@cf/cloudflare/clairic").`,
        status,
        false
      );
    }
    return new JevValidationError(explainCloudflareValidationMessage(label));
  }
  return new JevProviderError(label, status, status >= 500);
}
