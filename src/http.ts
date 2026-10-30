/**
 * Shared HTTP transport helpers for REST-backed providers.
 *
 * Zero runtime dependencies and no Node built-ins, so this module is safe to
 * bundle for Workers, Node 18+, Bun and Deno.
 */

/**
 * Parses an RFC 7231 `Retry-After` header value.
 * Accepts either delta-seconds (`"30"`) or an HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"`).
 * Returns milliseconds to wait, or `undefined` when the value is absent or unparseable.
 *
 * `options.maxMs` caps an absurd or hostile value so a retry loop cannot be parked
 * for hours by a single header.
 */
export function parseRetryAfterMs(
  value: string | null | undefined,
  options?: { readonly nowMs?: number; readonly maxMs?: number }
): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = String(value).trim();
  if (trimmed === '') return undefined;

  let ms: number | undefined;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    ms = Number.isFinite(seconds) ? seconds * 1000 : undefined;
  } else {
    const dateMs = Date.parse(trimmed);
    if (!Number.isNaN(dateMs)) {
      ms = Math.max(0, dateMs - (options?.nowMs ?? Date.now()));
    }
  }

  if (ms === undefined) return undefined;
  return options?.maxMs !== undefined ? Math.min(ms, options.maxMs) : ms;
}

/** Clips a server error body so thrown messages and logs stay bounded. */
export function truncateErrorBody(text: string, limit = 500): string {
  const clean = text.trim();
  return clean.length > limit ? `${clean.slice(0, limit)}… (truncated)` : clean;
}

/**
 * Package version sent in `X-Client` so live runs are attributable.
 * Bump together with `package.json` — a bundle cannot read package.json at runtime.
 */
export const S1_SDK_VERSION = '0.1.1';

/** Builds the `X-Client` header value, optionally suffixed with a transport tag. */
export function clientHeader(kind?: string): string {
  return kind ? `s1sdk/${S1_SDK_VERSION} ${kind}` : `s1sdk/${S1_SDK_VERSION}`;
}
