import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  CloudflareProvider,
  S1Client,
  CLOUDFLARE_MODELS,
  sanitizeQuestionsForCloudflare,
  parseRetryAfterMs,
  extractText,
  extractList,
  extractEstimate,
  JevAuthenticationError,
  JevProviderError,
  JevRateLimitError,
  JevValidationError,
  type CloudflareAiBinding
} from '../src/index.js';

/**
 * Cloudflare REST transport + transport seam.
 *
 * Fixtures in `fixtures/contracts/cloudflare-rest/` are verbatim response bodies
 * captured live on 2026-10-29. The error expectations below are therefore the
 * server's taxonomy, not our guesses about it.
 */

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/contracts/cloudflare-rest/${name}`, import.meta.url), 'utf8');

const fixtureJson = (name: string): any => JSON.parse(fixture(name));

interface RecordedCall {
  url: string;
  init: any;
}

/**
 * Installs a fetch stub. `respond` decides the reply per call.
 * Returns the growing call log so tests can assert on dispatch, not just results.
 */
function stubFetch(
  respond: (call: RecordedCall) => { status?: number; body?: string; headers?: Record<string, string> }
): RecordedCall[] {
  const calls: RecordedCall[] = [];
  globalThis.fetch = (async (input: any, init: any) => {
    const call: RecordedCall = {
      url: typeof input === 'string' ? input : input?.url ?? String(input),
      init
    };
    calls.push(call);
    const reply = respond(call);
    const status = reply.status ?? 200;
    const headers = reply.headers ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      text: async () => reply.body ?? '',
      json: async () => JSON.parse(reply.body ?? '{}')
    } as any;
  }) as typeof fetch;
  return calls;
}

const INVOICE_FIELDS = {
  vendor: extractText('Vendor organization name'),
  invoiceNumber: extractText('Invoice number'),
  issuedDate: extractText('Invoice issue date'),
  total: extractText('Invoice total'),
  lineItems: extractList('text', 'Purchased items'),
  confidenceBand: extractEstimate(0, 1, { step: 0.01, instructions: 'Extraction confidence' })
} as const;

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ==========================================
// 1. Transport resolution (construction-time, loud)
// ==========================================
describe('Transport resolution', () => {
  const fakeBinding: CloudflareAiBinding = { run: async () => ({ answers: {} }) };

  it('selects the binding when only a binding is configured', () => {
    const provider = new CloudflareProvider({ aiBinding: fakeBinding });
    expect(provider.transportKind).toBe('binding');
    expect(provider.isZeroEgress).toBe(true);
    expect(provider.getMetadata()).toMatchObject({
      providerId: 'cloudflare-workers-ai',
      transport: 'binding',
      zeroEgress: true,
      supportsLocalExecution: true,
      supportedTransports: ['binding', 'rest']
    });
  });

  it('selects REST when only credentials are configured', () => {
    const provider = new CloudflareProvider({ apiToken: 't', accountId: 'a' });
    expect(provider.transportKind).toBe('rest');
    expect(provider.isZeroEgress).toBe(false);
    expect(provider.getMetadata().supportsLocalExecution).toBe(false);
  });

  it('prefers the binding when both are configured (never escalates to egress)', () => {
    const provider = new CloudflareProvider({
      aiBinding: fakeBinding,
      apiToken: 't',
      accountId: 'a'
    });
    expect(provider.transportKind).toBe('binding');
  });

  it('honours an explicit REST pin even when a binding is present', () => {
    const provider = new CloudflareProvider({
      aiBinding: fakeBinding,
      apiToken: 't',
      accountId: 'a',
      transport: 'rest'
    });
    expect(provider.transportKind).toBe('rest');
  });

  it('throws at construction when binding is pinned but absent', () => {
    expect(() => new CloudflareProvider({ apiToken: 't', accountId: 'a', transport: 'binding' })).toThrow(
      /transport "binding" was pinned/
    );
  });

  it('throws at construction when REST is pinned but credentials are incomplete', () => {
    expect(() => new CloudflareProvider({ apiToken: 't', transport: 'rest' })).toThrow(
      /transport "rest" was pinned/
    );
  });

  it('constructs unconfigured, then fails loudly on use', async () => {
    const provider = new CloudflareProvider();
    expect(provider.transportKind).toBe('none');
    await expect(
      provider.execute({ state: 'x', questions: { a: { type: 'noul', instructions: 'y' } } })
    ).rejects.toThrow(/not configured/);
  });
});

// ==========================================
// 2. Zero-egress invariant
// ==========================================
describe('Zero-egress invariant', () => {
  it('never calls fetch on a binding provider, even with credentials also present', async () => {
    const calls = stubFetch(() => ({ body: '{"unexpected":true}' }));
    const binding: CloudflareAiBinding = {
      run: async () => ({ answers: { a: { type: 'noul', noul: 0.9 } }, usage: {} })
    };
    const provider = new CloudflareProvider({
      aiBinding: binding,
      apiToken: 't',
      accountId: 'a'
    });

    const res = await provider.execute({
      state: 'x',
      questions: { a: { type: 'noul', instructions: 'y' } }
    });

    expect(res.transport).toBe('binding');
    expect(calls).toEqual([]);
  });

  it('does not fall back from a failing binding to REST', async () => {
    const calls = stubFetch(() => ({ body: fixture('clairic-extract-success.json') }));
    const binding: CloudflareAiBinding = {
      run: async () => {
        throw new Error('binding exploded');
      }
    };
    const provider = new CloudflareProvider({
      aiBinding: binding,
      apiToken: 't',
      accountId: 'a',
      model: CLOUDFLARE_MODELS.CLAIRIC
    });

    await expect(
      provider.extract({ state: 'x', fields: { a: extractText('a') } }, undefined)
    ).rejects.toThrow(/binding exploded/);
    expect(calls).toEqual([]);
  });
});

// ==========================================
// 3. REST dispatch against the captured envelope
// ==========================================
describe('REST dispatch', () => {
  it('posts to /accounts/{id}/ai/run/{model} with auth, client header and redirect:error', async () => {
    const calls = stubFetch(() => ({ body: fixture('clairic-extract-success.json') }));
    const provider = new CloudflareProvider({
      apiToken: 'secret-token',
      accountId: 'acct-123',
      endpoint: 'https://api.cloudflare.com/client/v4',
      model: CLOUDFLARE_MODELS.CLAIRIC
    });

    await provider.extract({
      state: 'Acme Health Inc.\nInvoice INV-1042',
      referenceDate: '2026-01-01',
      fields: INVOICE_FIELDS
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct-123/ai/run/@cf/cloudflare/clairic'
    );
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.redirect).toBe('error');
    expect(calls[0].init.headers.Authorization).toBe('Bearer secret-token');
    expect(calls[0].init.headers['X-Client']).toMatch(/^s1sdk\/\d+\.\d+\.\d+ cf-rest$/);

    const payload = JSON.parse(calls[0].init.body);
    expect(payload.model).toBe('clairic');
    expect(payload.reference_date).toBe('2026-01-01');
    // `items`, never `item_type` — the DE-113 A2 defect.
    expect(payload.fields.lineItems).toEqual({ type: 'list', items: 'text', instructions: 'Purchased items' });
  });

  it('normalizes the captured success envelope exactly once, transport-agnostically', async () => {
    stubFetch(() => ({ body: fixture('clairic-extract-success.json') }));
    const provider = new CloudflareProvider({
      apiToken: 't',
      accountId: 'a',
      model: CLOUDFLARE_MODELS.CLAIRIC
    });

    const res = await provider.extract({ state: 'x', fields: INVOICE_FIELDS });

    expect(res.transport).toBe('rest');
    expect(res.providerUsed).toBe('cloudflare-workers-ai');
    expect(res.modelUsed).toBe('@cf/cloudflare/clairic');
    expect(res.truncated).toBe(false);

    // Quirks preserved as observed, not "fixed" in the SDK.
    expect(res.answers.vendor.value).toBeNull();
    expect(res.answers.vendor.confidence).toBeCloseTo(0.9967108964920044, 10);
    expect(res.answers.vendor.p_null).toBeCloseTo(0.9214743971824646, 10);
    expect(res.answers.vendor.span).toEqual([0, 16]);

    // Estimate answers report quantiles only: confidence must stay absent.
    expect(res.answers.confidenceBand.value).toBe(0.73);
    expect(res.answers.confidenceBand.interval_80).toEqual([0.45, 0.96]);
    expect(res.answers.confidenceBand.confidence).toBeUndefined();
    expect(res.answers.confidenceBand.p_null).toBeUndefined();

    // Pass telemetry survives: this call took 3 passes.
    expect(res.usage).toMatchObject({
      input_tokens: 707,
      output_tokens: 0,
      state_tokens: 68,
      image_tokens: 0,
      schema_tokens: 503,
      passes: 3
    });
  });

  it('returns byte-identical normalized answers from binding and REST fixtures', async () => {
    const envelope = fixtureJson('clairic-extract-success.json');
    const calls = stubFetch(() => ({ body: JSON.stringify(envelope) }));

    const bindingProvider = new CloudflareProvider({
      aiBinding: { run: async () => envelope.result },
      model: CLOUDFLARE_MODELS.CLAIRIC
    });
    const restProvider = new CloudflareProvider({
      apiToken: 't',
      accountId: 'a',
      model: CLOUDFLARE_MODELS.CLAIRIC
    });

    const viaBinding = await bindingProvider.extract({ state: 'x', fields: INVOICE_FIELDS });
    const viaRest = await restProvider.extract({ state: 'x', fields: INVOICE_FIELDS });

    expect(calls).toHaveLength(1);
    expect(viaBinding.transport).toBe('binding');
    expect(viaRest.transport).toBe('rest');
    // The seam contract: same result body in, same normalized payload out.
    expect(viaRest.answers).toEqual(viaBinding.answers);
    expect(viaRest.usage).toEqual(viaBinding.usage);
    expect(viaRest.truncated).toBe(viaBinding.truncated);
  });

  it('handles a decision (clef-flash) envelope', async () => {
    stubFetch(() => ({ body: fixture('clef-flash-decision-success.json') }));
    const provider = new CloudflareProvider({
      apiToken: 't',
      accountId: 'a',
      model: CLOUDFLARE_MODELS.CLEF_FLASH
    });

    const res = await provider.execute({
      state: 'pump cracked',
      questions: { intent: { type: 'choice', instructions: 'intent', criteria: { refund: 'money', replacement: 'unit' } } }
    });

    expect((res.answers.intent as any).choice).toBe('complaint');
    expect(res.transport).toBe('rest');
    expect(res.usage).toMatchObject({ input_tokens: 298, output_tokens: 0 });
  });
});

// ==========================================
// 4. Error taxonomy (fixture-backed)
// ==========================================
describe('REST error taxonomy', () => {
  const extractWith = (status: number, bodyFile: string, headers?: Record<string, string>) => {
    const calls = stubFetch(() => ({ status, body: fixture(bodyFile), headers }));
    const provider = new CloudflareProvider({
      apiToken: 't',
      accountId: 'a',
      model: CLOUDFLARE_MODELS.CLAIRIC
    });
    return { calls, promise: provider.extract({ state: 'x', fields: { a: extractText('a') } }) };
  };

  it('maps 401 / code 10000 to JevAuthenticationError (non-retryable)', async () => {
    const { promise } = extractWith(401, 'error-401-bad-token.json');
    const err: any = await promise.catch((e) => e);
    expect(err).toBeInstanceOf(JevAuthenticationError);
    expect(err.status).toBe(401);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('10000');
    expect(err.message).toContain('account-scoped');
  });

  it('maps 400 / code 5006 bad field type to JevValidationError', async () => {
    const { promise } = extractWith(400, 'error-400-bad-field-type.json');
    const err: any = await promise.catch((e) => e);
    expect(err).toBeInstanceOf(JevValidationError);
    expect(err.message).toContain('bogus-type');
  });

  it('maps 400 / code 7000 to a non-retryable provider error naming the model id', async () => {
    const { promise } = extractWith(400, 'error-400-unknown-model.json');
    const err: any = await promise.catch((e) => e);
    expect(err).toBeInstanceOf(JevProviderError);
    expect(err).not.toBeInstanceOf(JevValidationError);
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/@cf\/cloudflare\/clairic/);
  });

  it('adds the nested-schema hint to the misleading root-properties message', async () => {
    const { promise } = extractWith(400, 'error-400-choice-criteria-array.json');
    const err: any = await promise.catch((e) => e);
    expect(err).toBeInstanceOf(JevValidationError);
    expect(err.message).toContain('nested schema failures');
    expect(err.message).toContain('criteria must be an object');
  });

  it('treats success:false with HTTP 200 as a failure', async () => {
    const calls = stubFetch(() => ({
      status: 200,
      body: JSON.stringify({
        success: false,
        result: null,
        errors: [{ code: 10000, message: 'Authentication error' }],
        messages: []
      })
    }));
    const provider = new CloudflareProvider({ apiToken: 't', accountId: 'a', model: CLOUDFLARE_MODELS.CLAIRIC });
    const err: any = await provider
      .extract({ state: 'x', fields: { a: extractText('a') } })
      .catch((e) => e);
    expect(calls).toHaveLength(1);
    expect(err).toBeInstanceOf(JevAuthenticationError);
  });

  it('parses Retry-After into JevRateLimitError.retryAfterMs', async () => {
    const calls = stubFetch(() => ({
      status: 429,
      headers: { 'retry-after': '2' },
      body: JSON.stringify({ success: false, errors: [{ code: 3040, message: 'rate limited' }], result: null })
    }));
    const provider = new CloudflareProvider({ apiToken: 't', accountId: 'a', model: CLOUDFLARE_MODELS.CLAIRIC });
    const err: any = await provider
      .extract({ state: 'x', fields: { a: extractText('a') } })
      .catch((e) => e);
    expect(calls).toHaveLength(1);
    expect(err).toBeInstanceOf(JevRateLimitError);
    expect(err.retryAfterMs).toBe(2000);
    expect(err.retryable).toBe(true);
  });

  it('rejects a non-JSON success body as retryable', async () => {
    stubFetch(() => ({ status: 200, body: '<html>gateway</html>' }));
    const provider = new CloudflareProvider({ apiToken: 't', accountId: 'a', model: CLOUDFLARE_MODELS.CLAIRIC });
    const err: any = await provider
      .extract({ state: 'x', fields: { a: extractText('a') } })
      .catch((e) => e);
    expect(err).toBeInstanceOf(JevProviderError);
    expect(err.retryable).toBe(true);
  });

  it('rejects an empty result payload', async () => {
    stubFetch(() => ({ status: 200, body: JSON.stringify({ success: true, result: null, errors: [] }) }));
    const provider = new CloudflareProvider({ apiToken: 't', accountId: 'a', model: CLOUDFLARE_MODELS.CLAIRIC });
    await expect(provider.extract({ state: 'x', fields: { a: extractText('a') } })).rejects.toThrow(
      /empty result/
    );
  });

  it('refuses to dispatch a path-traversal model id', async () => {
    const calls = stubFetch(() => ({ body: '{}' }));
    const provider = new CloudflareProvider({ apiToken: 't', accountId: 'a' });
    await expect(
      provider.execute({
        state: 'x',
        model: '@cf/../../admin',
        questions: { a: { type: 'noul', instructions: 'y' } }
      })
    ).rejects.toThrow(/unsafe model path/);
    expect(calls).toEqual([]);
  });
});

describe('parseRetryAfterMs', () => {
  const now = Date.parse('2026-10-29T12:00:00Z');

  it('parses delta-seconds', () => {
    expect(parseRetryAfterMs('30')).toBe(30_000);
    expect(parseRetryAfterMs('0')).toBe(0);
  });

  it('parses an HTTP-date relative to now', () => {
    expect(parseRetryAfterMs('Thu, 29 Oct 2026 12:00:45 GMT', { nowMs: now })).toBe(45_000);
  });

  it('never returns a negative wait for a past date', () => {
    expect(parseRetryAfterMs('Thu, 29 Oct 2026 11:59:00 GMT', { nowMs: now })).toBe(0);
  });

  it('caps hostile values', () => {
    expect(parseRetryAfterMs('99999', { maxMs: 60_000 })).toBe(60_000);
  });

  it('returns undefined for absent or unparseable values', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs('')).toBeUndefined();
    expect(parseRetryAfterMs('soon')).toBeUndefined();
  });
});

// ==========================================
// 5. Client-side guards that keep the bad requests away
// ==========================================
describe('Protocol guards', () => {
  it('rejects array criteria for choice questions before dispatch', () => {
    expect(() =>
      sanitizeQuestionsForCloudflare({
        intent: { type: 'choice', instructions: 'x', criteria: ['refund', 'replacement'] } as any
      })
    ).toThrow(JevValidationError);
  });

  it('does not dispatch when a choice question is malformed', async () => {
    const calls = stubFetch(() => ({ body: '{}' }));
    const provider = new CloudflareProvider({ apiToken: 't', accountId: 'a' });
    await expect(
      provider.execute({
        state: 'x',
        questions: { intent: { type: 'choice', instructions: 'x', criteria: ['a', 'b'] } as any }
      })
    ).rejects.toThrow(/requires criterion keys and descriptions/);
    expect(calls).toEqual([]);
  });
});

// ==========================================
// 6. Credential verification + client wiring
// ==========================================
describe('verifyCredentials', () => {
  it('probes GET /accounts/{id} on REST', async () => {
    const calls = stubFetch(() => ({ body: JSON.stringify({ success: true, result: [{ id: 'acct' }] }) }));
    const provider = new CloudflareProvider({ apiToken: 't', accountId: 'acct-123' });
    await expect(provider.verifyCredentials()).resolves.toBe(true);
    expect(calls[0].url).toBe('https://api.cloudflare.com/client/v4/accounts/acct-123');
    expect(calls[0].init.method).toBe('GET');
  });

  it('returns false on REST without throwing', async () => {
    stubFetch(() => ({ status: 401, body: fixture('error-401-bad-token.json') }));
    const provider = new CloudflareProvider({ apiToken: 'bad', accountId: 'acct-123' });
    await expect(provider.verifyCredentials()).resolves.toBe(false);
  });

  it('returns false for a binding without making a call', async () => {
    const calls = stubFetch(() => ({ body: '{}' }));
    const provider = new CloudflareProvider({ aiBinding: { run: async () => ({}) } });
    await expect(provider.verifyCredentials()).resolves.toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('S1Client wiring', () => {
  it('builds a REST Cloudflare provider from explicit credentials', () => {
    const client = new S1Client({
      provider: 'cloudflare',
      cloudflareApiToken: 't',
      cloudflareAccountId: 'a'
    });
    expect(client.provider).toBe('cloudflare-workers-ai');
    expect((client.providerInstance as CloudflareProvider).transportKind).toBe('rest');
  });

  it('keeps auto-discovery binding-only', () => {
    const client = new S1Client({ provider: 'auto' });
    expect(client.provider).not.toBe('cloudflare-workers-ai');
  });

  it('surfaces a loud construction failure for an unsatisfiable pin', () => {
    // Explicit empty strings keep this deterministic under Bun, which auto-loads
    // .env — otherwise CLOUDFLARE_* from the developer shell would satisfy the pin.
    expect(
      () =>
        new S1Client({
          provider: 'cloudflare',
          aiBinding: { run: async () => ({}) },
          cloudflareApiToken: '',
          cloudflareAccountId: '',
          cloudflareTransport: 'rest'
        })
    ).toThrow(/transport "rest" was pinned/);
  });
});
