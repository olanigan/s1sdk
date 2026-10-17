import { describe, it, expect } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  S1Client,
  choice,
  noul,
  JevAuthenticationError,
  JevProviderError,
  JevRateLimitError
} from '../src/index.js';

/**
 * Behaviours a caller that hand-rolls its own HTTP (durable-pi's jev.ts) relies on, checked against real HTTP
 * servers for the two credentialed remote providers: refuse redirects, retry rate limits and 5xx sensibly,
 * pass cost through, and report the model the server actually ran.
 */

interface Seen {
  method?: string;
  headers: IncomingMessage['headers'];
  body: any;
}

async function serve(handler: (n: number, req: IncomingMessage, res: ServerResponse) => void) {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({ method: req.method, headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
      handler(seen.length, req, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/systemone`;
  return {
    url,
    seen,
    close: () =>
      new Promise<void>((r) => {
        (server as any).closeAllConnections?.();
        server.close(() => r());
      })
  };
}

const OK_ANSWERS = {
  verdict: { type: 'choice', choice: 'allow', confidence: 0.9, probabilities: { allow: 0.9, block: 0.1 } },
  risk: { type: 'noul', noul: 0.1 }
};
const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
};
const ok = (res: ServerResponse, extra: Record<string, unknown> = {}) => json(res, 200, { model: 'served-model-1', answers: OK_ANSWERS, ...extra });

const questions = {
  verdict: choice('Allow or block?', { allow: 'Harmless', block: 'Harmful' }),
  risk: noul('Is it risky?')
};
const request = { state: { command: 'ls' }, questions };

const PROVIDERS = ['typesafe', 'openrouter'] as const;

describe.each(PROVIDERS)('%s provider parity', (provider) => {
  const client = (url: string, extra: Record<string, unknown> = {}) =>
    new S1Client({ provider, apiKey: 'k-test', endpoint: url, timeoutMs: 5000, ...extra });

  describe('redirects', () => {
    it('refuses to follow a redirect, never reaches the target, and does not retry', async () => {
      const target = await serve((_, __, res) => ok(res));
      const origin = await serve((_, __, res) => {
        res.statusCode = 302;
        res.setHeader('location', target.url);
        res.end();
      });
      try {
        const err = await client(origin.url, { maxRetries: 2 }).decide(request).catch((e) => e);
        expect(err).toBeInstanceOf(JevProviderError);
        expect(String(err.message)).toMatch(/redirect/i);
        expect(err.retryable).toBe(false);
        expect(origin.seen).toHaveLength(1);
        expect(target.seen).toHaveLength(0);
      } finally {
        await origin.close();
        await target.close();
      }
    });
  });

  describe('retries', () => {
    it.each([502, 503, 529])('retries HTTP %i and succeeds', async (status) => {
      const s = await serve((n, _, res) => (n === 1 ? json(res, status, { error: 'busy' }) : ok(res)));
      try {
        const r = await client(s.url, { maxRetries: 1 }).decide(request);
        expect(r.answers.risk.noul).toBe(0.1);
        expect(s.seen).toHaveLength(2);
      } finally {
        await s.close();
      }
    });

    it.each([400, 401])('does not retry HTTP %i', async (status) => {
      const s = await serve((_, __, res) => json(res, status, { error: 'no' }));
      try {
        const err = await client(s.url, { maxRetries: 2 }).decide(request).catch((e) => e);
        expect(s.seen).toHaveLength(1);
        if (status === 401) expect(err).toBeInstanceOf(JevAuthenticationError);
        else expect(err).toBeInstanceOf(JevProviderError);
      } finally {
        await s.close();
      }
    });

    it('waits for Retry-After on a 429 before retrying', async () => {
      const s = await serve((n, _, res) => (n === 1 ? json(res, 429, { error: 'slow down' }, { 'retry-after': '1' }) : ok(res)));
      try {
        const t0 = performance.now();
        await client(s.url, { maxRetries: 1 }).decide(request);
        expect(performance.now() - t0).toBeGreaterThanOrEqual(950);
        expect(s.seen).toHaveLength(2);
      } finally {
        await s.close();
      }
    });

    it('does not sleep for an unreasonable Retry-After: it surfaces the rate limit at once', async () => {
      const s = await serve((_, __, res) => json(res, 429, { error: 'later' }, { 'retry-after': '3600' }));
      try {
        const t0 = performance.now();
        const err = await client(s.url, { maxRetries: 2, maxRetryAfterMs: 2000 }).decide(request).catch((e) => e);
        expect(err).toBeInstanceOf(JevRateLimitError);
        expect(err.retryAfterMs).toBe(3_600_000);
        expect(s.seen).toHaveLength(1);
        expect(performance.now() - t0).toBeLessThan(500);
      } finally {
        await s.close();
      }
    });

    it('reads an HTTP-date Retry-After: a date already past means retry now', async () => {
      const s = await serve((n, _, res) =>
        n === 1 ? json(res, 429, { error: 'x' }, { 'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT' }) : ok(res)
      );
      try {
        const t0 = performance.now();
        const r = await client(s.url, { maxRetries: 1 }).decide(request);
        expect(r.answers.risk.noul).toBe(0.1);
        expect(s.seen).toHaveLength(2);
        expect(performance.now() - t0).toBeLessThan(400);
      } finally {
        await s.close();
      }
    });

    it('treats an HTTP-date far in the future like any over-long Retry-After', async () => {
      const s = await serve((_, __, res) => json(res, 429, { error: 'x' }, { 'retry-after': 'Wed, 21 Oct 2099 07:28:00 GMT' }));
      try {
        const err = await client(s.url, { maxRetries: 2 }).decide(request).catch((e) => e);
        expect(err).toBeInstanceOf(JevRateLimitError);
        expect(s.seen).toHaveLength(1);
      } finally {
        await s.close();
      }
    });

    it('ignores a Retry-After it cannot parse and falls back to its own backoff', async () => {
      const s = await serve((n, _, res) => (n === 1 ? json(res, 429, { error: 'x' }, { 'retry-after': 'soon' }) : ok(res)));
      try {
        const r = await client(s.url, { maxRetries: 1 }).decide(request);
        expect(r.answers.risk.noul).toBe(0.1);
        expect(s.seen).toHaveLength(2);
      } finally {
        await s.close();
      }
    });

    it('uses the configured exponential backoff (400 ms base, like a hand-rolled caller)', async () => {
      const s = await serve((n, _, res) => (n < 3 ? json(res, 503, { error: 'x' }) : ok(res)));
      try {
        const t0 = performance.now();
        await client(s.url, { maxRetries: 2, retryBackoffMs: 100, retryMaxBackoffMs: 1000 }).decide(request);
        // 100*2 and 100*4, each with 0.8 to 1.2 jitter: at least 160 + 320
        expect(performance.now() - t0).toBeGreaterThanOrEqual(440);
        expect(s.seen).toHaveLength(3);
      } finally {
        await s.close();
      }
    });

    it('keeps the short default backoff for callers that set nothing', async () => {
      const s = await serve((n, _, res) => (n < 3 ? json(res, 503, { error: 'x' }) : ok(res)));
      try {
        const t0 = performance.now();
        await client(s.url, { maxRetries: 2 }).decide(request);
        expect(performance.now() - t0).toBeLessThan(400);
      } finally {
        await s.close();
      }
    });

    it('does not retry by default', async () => {
      const s = await serve((_, __, res) => json(res, 503, { error: 'x' }));
      try {
        await client(s.url).decide(request).catch(() => undefined);
        expect(s.seen).toHaveLength(1);
      } finally {
        await s.close();
      }
    });
  });

  describe('response fields', () => {
    it('passes a valid usage.cost through', async () => {
      const s = await serve((_, __, res) => ok(res, { usage: { input_tokens: 12, output_tokens: 2, cost: 0.00003 } }));
      try {
        const r = await client(s.url).decide(request);
        expect(r.usage?.cost).toBe(0.00003);
        expect(r.usage?.inputTokens).toBe(12);
      } finally {
        await s.close();
      }
    });

    it.each([[-1], ['0.1'], [null], [undefined]])('drops an invalid cost (%s)', async (cost) => {
      const s = await serve((_, __, res) => ok(res, { usage: { input_tokens: 1, output_tokens: 1, cost } }));
      try {
        expect((await client(s.url).decide(request)).usage?.cost).toBeUndefined();
      } finally {
        await s.close();
      }
    });

    it('reports the model the server says it ran, not the alias that was requested', async () => {
      const s = await serve((_, __, res) => ok(res, { model: 'typesafe/jev-1.13' }));
      try {
        const r = await client(s.url, { model: '~typesafe/jev-latest' }).decide(request);
        expect(s.seen[0]!.body.model).toBe('~typesafe/jev-latest');
        expect(r.modelUsed).toBe('typesafe/jev-1.13');
      } finally {
        await s.close();
      }
    });

    it('falls back to the requested model when the server names none', async () => {
      const s = await serve((_, __, res) => json(res, 200, { answers: OK_ANSWERS }));
      try {
        expect((await client(s.url, { model: 'm-req' }).decide(request)).modelUsed).toBe('m-req');
      } finally {
        await s.close();
      }
    });
  });

  describe('wire', () => {
    it('sends {model, state, questions} with a bearer token', async () => {
      const s = await serve((_, __, res) => ok(res));
      try {
        await client(s.url, { model: 'm-1' }).decide(request);
        expect(s.seen[0]!.method).toBe('POST');
        expect(s.seen[0]!.headers.authorization).toBe('Bearer k-test');
        expect(Object.keys(s.seen[0]!.body).sort()).toEqual(['model', 'questions', 'state']);
        expect(s.seen[0]!.body.model).toBe('m-1');
        expect(s.seen[0]!.body.state).toEqual({ command: 'ls' });
      } finally {
        await s.close();
      }
    });
  });
});

describe('homestead provider with an API key', () => {
  it('refuses to follow a redirect', async () => {
    const target = await serve((_, __, res) => ok(res));
    const origin = await serve((_, __, res) => {
      res.statusCode = 307;
      res.setHeader('location', target.url);
      res.end();
    });
    try {
      const c = new S1Client({ provider: 'homestead', apiKey: 'k-test', endpoint: origin.url, timeoutMs: 5000 });
      const err = await c.decide(request).catch((e) => e);
      expect(String(err.message)).toMatch(/redirect/i);
      expect(target.seen).toHaveLength(0);
    } finally {
      await origin.close();
      await target.close();
    }
  });
});
