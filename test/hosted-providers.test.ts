import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  OpenRouterProvider,
  TypeSafeProvider,
  S1Client,
  choice,
  S1_SDK_VERSION,
  JevAuthenticationError,
  JevRateLimitError,
  JevTimeoutError,
  JevProviderError,
  type JevDecisionResponse
} from '../src/index.js';

/**
 * Hosted REST providers (OpenRouter Decisions API, TypeSafe AI).
 *
 * These two shipped with their `execute()` method never run by a test: only
 * constructor wiring and credential isolation were covered. Everything below
 * pins the wire contract (endpoint, headers, payload), the envelope
 * normalization, and the HTTP error taxonomy that decides whether the client
 * retries, re-authenticates, or fails loudly.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const QUESTIONS = { action: choice('Pick one action', { read: 'read', write: 'write' }) };

const SUCCESS_BODY = {
  answers: { action: { type: 'choice', choice: 'read', confidence: 0.93 } },
  usage: { input_tokens: 12, output_tokens: 0 }
};

interface HostedProvider {
  readonly label: string;
  readonly providerId: string;
  readonly defaultEndpoint: string;
  readonly defaultModel: string;
  readonly maxConcurrentRequests: number;
  readonly create: (apiKey?: string) => OpenRouterProvider | TypeSafeProvider;
  readonly expectedHeaders: (init: RequestInit) => Record<string, string>;
}

const HOSTED: HostedProvider[] = [
  {
    label: 'OpenRouterProvider',
    providerId: 'openrouter',
    defaultEndpoint: 'https://openrouter.ai/api/alpha/decisions',
    defaultModel: 'typesafe/jev-1.13',
    maxConcurrentRequests: 250,
    create: (apiKey = 'sk-or-test') => new OpenRouterProvider(apiKey),
    expectedHeaders: () => ({
      'HTTP-Referer': 'https://github.com/olanigan/s1sdk',
      'X-Title': 's1sdk'
    })
  },
  {
    label: 'TypeSafeProvider',
    providerId: 'typesafe',
    defaultEndpoint: 'https://api.typesafe.ai/v1/systemone',
    defaultModel: 'jev-latest',
    maxConcurrentRequests: 500,
    create: (apiKey = 'ts-test') => new TypeSafeProvider(apiKey),
    expectedHeaders: () => ({
      'X-Client': `s1sdk/${S1_SDK_VERSION} typesafe-rest`
    })
  }
];

interface FetchCall {
  url: string;
  init: RequestInit;
}

function stubFetch(
  responder: (call: FetchCall) => Response | Promise<Response>
): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: any, init: RequestInit = {}) => {
      const call = { url: String(input), init };
      calls.push(call);
      return responder(call);
    })
  );
  return calls;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}

function request(state: unknown = 'classify this ticket', model?: string) {
  return { state, questions: QUESTIONS, ...(model ? { model } : {}) };
}

for (const p of HOSTED) {
  describe(`${p.label} wire contract`, () => {
    it('throws JevAuthenticationError before any dispatch when the key is missing', async () => {
      const calls = stubFetch(() => json(SUCCESS_BODY));
      const provider = p.create('');

      await expect(provider.execute(request())).rejects.toBeInstanceOf(JevAuthenticationError);
      await expect(provider.execute(request())).rejects.toThrow(new RegExp(`${p.providerId}|API key`, 'i'));
      expect(calls).toHaveLength(0);
    });

    it('POSTs model, state and questions to the documented endpoint with auth headers', async () => {
      const calls = stubFetch(() => json(SUCCESS_BODY));

      await p.create('sk-test').execute(request({ intent: 'refund', id: 7 }));

      expect(calls).toHaveLength(1);
      const { url, init } = calls[0]!;
      expect(url).toBe(p.defaultEndpoint);
      expect(init.method).toBe('POST');

      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer sk-test');
      expect(headers['Content-Type']).toBe('application/json');
      for (const [name, value] of Object.entries(p.expectedHeaders(init))) {
        expect(headers[name], `header ${name}`).toBe(value);
      }

      expect(JSON.parse(String(init.body))).toEqual({
        model: p.defaultModel,
        state: { intent: 'refund', id: 7 },
        questions: QUESTIONS
      });
    });

    it('lets request.model override options.model, which overrides the constructor default', async () => {
      const calls = stubFetch(() => json(SUCCESS_BODY));
      const provider = p.create();

      await provider.execute(request());
      await provider.execute(request('state', 'request-model'), { model: 'option-model' });
      await provider.execute(request('state'), { model: 'option-model' });

      expect(JSON.parse(String(calls[0]!.init.body)).model).toBe(p.defaultModel);
      expect(JSON.parse(String(calls[1]!.init.body)).model).toBe('request-model');
      expect(JSON.parse(String(calls[2]!.init.body)).model).toBe('option-model');
    });

    it('normalizes answers and snake_case usage from the envelope', async () => {
      stubFetch(() => json({ ...SUCCESS_BODY, latency_ms: 42 }));

      const res = await p.create().execute(request());

      expect(res.answers.action).toEqual({ type: 'choice', choice: 'read', confidence: 0.93 });
      expect(res.usage).toEqual({
        inputTokens: 12,
        outputTokens: 0,
        input_tokens: 12,
        output_tokens: 0
      });
      expect(res.latencyMs).toBe(42);
      expect(res.latency_ms).toBe(42);
      expect(res.providerUsed).toBe(p.providerId);
      expect(res.provider).toBe(p.providerId);
      expect(res.modelUsed).toBe(p.defaultModel);
      expect(res.isFallback).toBe(false);
      expect(typeof res.timestamp).toBe('number');
    });

    it('accepts camelCase usage and falls back to a state-length token estimate', async () => {
      stubFetch(() =>
        json({ answers: SUCCESS_BODY.answers, usage: { inputTokens: 5, outputTokens: 3 } })
      );
      const withUsage = await p.create().execute(request());
      expect(withUsage.usage).toMatchObject({ inputTokens: 5, outputTokens: 3 });

      stubFetch(() => json({ answers: SUCCESS_BODY.answers }));
      const estimated = await p.create().execute(request('x'.repeat(40)));
      // ceil(40 / 4) with no server-reported usage
      expect(estimated.usage).toMatchObject({ inputTokens: 10, outputTokens: 0 });
    });

    it('uses the whole body as answers when the envelope omits `answers`', async () => {
      stubFetch(() => json({ action: { type: 'choice', choice: 'write', confidence: 0.7 } }));

      const res = await p.create().execute(request());

      expect(res.answers.action.choice).toBe('write');
    });

    it('exposes decide() as an alias of execute()', async () => {
      const calls = stubFetch(() => json(SUCCESS_BODY));
      const provider = p.create();

      const viaDecide: JevDecisionResponse<typeof QUESTIONS> = await provider.decide(request());
      const viaExecute = await provider.execute(request());

      expect(calls).toHaveLength(2);
      expect(viaDecide.answers).toEqual(viaExecute.answers);
    });

    it('reports health from key presence and advertises its metadata', async () => {
      expect(await p.create('').isHealthy()).toBe(false);
      expect(await p.create('sk-live').isHealthy()).toBe(true);

      expect(p.create('sk-live').getMetadata()).toEqual({
        providerId: p.providerId,
        defaultModel: p.defaultModel,
        supportsLocalExecution: false,
        maxConcurrentRequests: p.maxConcurrentRequests
      });
    });

    it('is reachable through S1Client provider selection', () => {
      const client = new S1Client({ provider: p.providerId as 'openrouter', apiKey: 'sk-test' });
      expect(client.provider).toBe(p.providerId);
      expect(client.providerInstance).toBeInstanceOf(
        p.providerId === 'openrouter' ? OpenRouterProvider : TypeSafeProvider
      );
    });
  });

  describe(`${p.label} HTTP error taxonomy`, () => {
    it('maps 401 to a non-retryable JevAuthenticationError carrying the status and body', async () => {
      stubFetch(() => new Response('invalid api key', { status: 401 }));

      const err = await p.create().execute(request()).catch((e) => e);

      expect(err).toBeInstanceOf(JevAuthenticationError);
      expect(err.status).toBe(401);
      expect(err.retryable).toBe(false);
      expect(err.message).toContain('invalid api key');
    });

    it('maps 403 to JevAuthenticationError', async () => {
      stubFetch(() => new Response('forbidden', { status: 403 }));

      const err = await p.create().execute(request()).catch((e) => e);

      expect(err).toBeInstanceOf(JevAuthenticationError);
      expect(err.status).toBe(403);
    });

    it('maps 429 to a retryable JevRateLimitError with Retry-After in milliseconds', async () => {
      stubFetch(() => new Response('slow down', { status: 429, headers: { 'retry-after': '7' } }));

      const err = await p.create().execute(request()).catch((e) => e);

      expect(err).toBeInstanceOf(JevRateLimitError);
      expect(err.status).toBe(429);
      expect(err.retryable).toBe(true);
      expect(err.retryAfterMs).toBe(7000);
    });

    it('leaves retryAfterMs undefined when the 429 carries no Retry-After', async () => {
      stubFetch(() => new Response('slow down', { status: 429 }));

      const err = await p.create().execute(request()).catch((e) => e);

      expect(err).toBeInstanceOf(JevRateLimitError);
      expect(err.retryAfterMs).toBeUndefined();
    });

    it.each([408, 504])('maps %i to JevTimeoutError with the caller budget', async (status) => {
      stubFetch(() => new Response('timeout', { status }));

      const err = await p.create().execute(request(), { timeoutMs: 1234 }).catch((e) => e);

      expect(err).toBeInstanceOf(JevTimeoutError);
      expect(err.timeoutMs).toBe(1234);
    });

    it('maps 5xx to a retryable JevProviderError and 4xx to a non-retryable one', async () => {
      stubFetch(() => new Response('upstream exploded', { status: 500 }));
      const server = await p.create().execute(request()).catch((e) => e);
      expect(server).toBeInstanceOf(JevProviderError);
      expect(server.status).toBe(500);
      expect(server.retryable).toBe(true);
      expect(server.message).toContain('[500]');

      stubFetch(() => new Response('bad request', { status: 400 }));
      const client = await p.create().execute(request()).catch((e) => e);
      expect(client).toBeInstanceOf(JevProviderError);
      expect(client.status).toBe(400);
      expect(client.retryable).toBe(false);
    });

    it('clips an oversized error body so logs stay bounded', async () => {
      stubFetch(() => new Response('e'.repeat(900), { status: 500 }));

      const err = await p.create().execute(request()).catch((e) => e);

      expect(err.message).toContain('... (truncated)');
      expect(err.message).not.toContain('e'.repeat(600));
      expect(err.message.length).toBeLessThan(600);
    });

    it('rejects a non-JSON success body instead of returning empty answers', async () => {
      stubFetch(() => new Response('<html>gateway</html>', { status: 200 }));

      const err = await p.create().execute(request()).catch((e) => e);

      expect(err).toBeInstanceOf(JevProviderError);
      expect(err.message).toContain('Failed to parse');
    });

    it('maps a transport failure to a retryable 503 and keeps the cause', async () => {
      const cause = new Error('ECONNREFUSED');
      stubFetch(() => {
        throw cause;
      });

      const err = await p.create().execute(request()).catch((e) => e);

      expect(err).toBeInstanceOf(JevProviderError);
      expect(err.status).toBe(503);
      expect(err.retryable).toBe(true);
      expect(err.cause).toBe(cause);
    });

    it('maps an aborted request to JevTimeoutError', async () => {
      const abort = new Error('aborted');
      abort.name = 'AbortError';
      stubFetch(() => {
        throw abort;
      });

      const err = await p.create().execute(request(), { timeoutMs: 999 }).catch((e) => e);

      expect(err).toBeInstanceOf(JevTimeoutError);
      expect(err.timeoutMs).toBe(999);
    });
  });
}
