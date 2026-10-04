import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  S1Client,
  JevClient,
  noul,
  choice,
  score,
  MockEngine,
  OpenRouterProvider,
  TypeSafeProvider,
  CloudflareWorkerProvider,
  JevProviderBase,
  JevAuthenticationError,
  JevTimeoutError,
  JevRateLimitError,
  JevProviderError,
  type JevMiddleware,
  type JevDecisionRequest,
  type JevDecisionResponse,
  type ProviderMetadata
} from '../src/index.js';

describe('Jev-SDK Core Architecture & Primitives', () => {
  // ==========================================
  // 1. Question Builders & Type Safety
  // ==========================================
  describe('Question Builders', () => {
    it('creates immutable noul questions', () => {
      const q = noul('Is this execution request malicious or dangerous?');
      expect(q.type).toBe('noul');
      expect(q.instructions).toBe('Is this execution request malicious or dangerous?');
      expect(Object.isFrozen(q)).toBe(true);
    });

    it('creates immutable choice questions with criteria dictionary', () => {
      const criteria = {
        web_search: 'User requests real-time web search or lookup',
        terminal: 'User wants to run shell, bash, or filesystem commands',
        general: 'Standard conversation or reasoning'
      } as const;

      const q = choice('Select optimal MCP tool', criteria);
      expect(q.type).toBe('choice');
      expect(q.instructions).toBe('Select optimal MCP tool');
      expect(q.criteria).toEqual(criteria);
      expect(Object.isFrozen(q)).toBe(true);
    });

    it('creates immutable score questions with discrete levels', () => {
      const q = score('Rate security risk level', [1, 2, 3, 4, 5]);
      expect(q.type).toBe('score');
      expect(q.instructions).toBe('Rate security risk level');
      expect(q.levels).toEqual([1, 2, 3, 4, 5]);
      expect(Object.isFrozen(q)).toBe(true);
    });
  });

  // ==========================================
  // 2. Mock Engine Determinism & Calibration
  // ==========================================
  describe('Mock Engine Determinism', () => {
    const mock = new MockEngine();

    it('identifies dangerous shell commands with high calibrated probability', async () => {
      const dangerousReq: JevDecisionRequest = {
        state: 'Run command: rm -rf /etc/hosts && chmod 777 /',
        questions: {
          is_unsafe: noul('Check if the bash command is dangerous')
        }
      };

      const res = await mock.execute(dangerousReq);
      expect(res.answers.is_unsafe.noul).toBeGreaterThanOrEqual(0.95);
      expect(res.answers.is_unsafe.raw_logit).toBeDefined();
      expect(res.providerUsed).toBe('mock-engine');
      expect(res.isFallback).toBe(false);
    });

    it('identifies benign prompts with low calibrated probability', async () => {
      const benignReq: JevDecisionRequest = {
        state: 'Check server health status and verify uptime',
        questions: {
          is_unsafe: noul('Check if benign')
        }
      };

      const res = await mock.execute(benignReq);
      expect(res.answers.is_unsafe.noul).toBeLessThanOrEqual(0.05);
    });

    it('generates categorical distributions summing strictly to 1.0000', async () => {
      const routeReq: JevDecisionRequest = {
        state: 'Run grep -rn "error" /var/log/syslog',
        questions: {
          tool: choice('Route to MCP tool', {
            terminal: 'Run shell commands',
            web_search: 'Search internet',
            read_file: 'Inspect file',
            calculator: 'Do math'
          })
        }
      };

      const res = await mock.execute(routeReq);
      const answer = res.answers.tool;
      expect(answer.choice).toBe('terminal');
      expect(answer.confidence).toBeGreaterThan(0.85);

      const probSum = Object.values(answer.probabilities).reduce((a, b) => a + b, 0);
      expect(Math.round(probSum * 10000) / 10000).toBe(1.0);
    });

    it('evaluates score questions deterministically', async () => {
      const scoreReq: JevDecisionRequest = {
        state: 'Query latency is 14ms and memory usage is 12MB',
        questions: {
          perf_score: score('Score system performance', [1, 2, 3, 4, 5])
        }
      };

      const res = await mock.execute(scoreReq);
      expect(res.answers.perf_score.score).toBeGreaterThan(0);
      expect(res.answers.perf_score.confidence).toBeGreaterThan(0.8);
    });
  });

  // ==========================================
  // 3. Middleware Lifecycle & Non-Blocking Guarantee
  // ==========================================
  describe('Middleware Pipeline', () => {
    it('executes beforeRequest and afterResponse in sequence', async () => {
      const events: string[] = [];
      const testMiddleware: JevMiddleware = {
        name: 'test-tracker',
        beforeRequest: (ctx) => {
          events.push(`before:${ctx.id}`);
          ctx.metadata.traced = true;
        },
        afterResponse: (ctx, res) => {
          events.push(`after:${res.providerUsed}`);
        }
      };

      const client = new JevClient({ useMock: true });
      client.use(testMiddleware);

      const res = await client.decide({
        state: 'echo hello',
        questions: {
          valid: noul('Is valid')
        }
      });

      expect(events.length).toBe(2);
      expect(events[0]).toMatch(/^before:(s1|jev)_/);
      expect(events[1]).toBe('after:mock-engine');
      expect(res.answers.valid).toBeDefined();
    });

    it('enforces non-blocking execution when middleware throws', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const failingMiddleware: JevMiddleware = {
        name: 'faulty-telemetry',
        beforeRequest: () => {
          throw new Error('Database connection refused in middleware');
        },
        afterResponse: () => {
          throw new Error('ClickHouse batch insert failed');
        }
      };

      const client = new JevClient({ useMock: true });
      client.use(failingMiddleware);

      // System-1 inference must NOT crash despite middleware failures
      const res = await client.decide({
        state: 'ping localhost',
        questions: {
          test: noul('Test prompt')
        }
      });

      expect(res.answers.test).toBeDefined();
      expect(consoleWarnSpy).toHaveBeenCalled();
      consoleWarnSpy.mockRestore();
    });

    it('supports short-circuiting in beforeRequest (e.g. cache hit)', async () => {
      const cachedResponse: JevDecisionResponse = {
        answers: {
          verdict: { noul: 0.999 }
        },
        latencyMs: 0,
        latency_ms: 0,
        providerUsed: 'local-memory-cache',
        provider: 'local-memory-cache',
        modelUsed: 'cached',
        isFallback: false,
        timestamp: 123456789
      };

      const cacheMiddleware: JevMiddleware = {
        name: 'short-circuit-cache',
        beforeRequest: (ctx) => {
          if (ctx.state === 'CACHED_QUERY') {
            return cachedResponse;
          }
        }
      };

      const client = new JevClient({ useMock: true });
      client.use(cacheMiddleware);

      const res = await client.decide({
        state: 'CACHED_QUERY',
        questions: {
          verdict: noul('Check verdict')
        }
      });

      expect(res.providerUsed).toBe('local-memory-cache');
      expect(res.answers.verdict.noul).toBe(0.999);
    });

    it('recovers errors via onError middleware hook', async () => {
      class FailingProvider extends JevProviderBase {
        readonly name = 'Broken';
        readonly providerId = 'broken';
        async execute(): Promise<any> {
          throw new JevProviderError('Cloud API unavailable', 503, true);
        }
        async isHealthy(): Promise<boolean> {
          return false;
        }
        getMetadata(): ProviderMetadata {
          return {
            providerId: 'broken',
            defaultModel: 'none',
            supportsLocalExecution: false,
            maxConcurrentRequests: 0
          };
        }
      }

      const client = new JevClient({
        providerInstance: new FailingProvider(),
        fallbackToMock: false // Disable default mock fallback to test onError recovery
      });

      const recoveryMiddleware: JevMiddleware = {
        name: 'error-healer',
        onError: (_ctx, _err) => {
          return {
            answers: {
              recovered: { noul: 0.5 }
            },
            latencyMs: 1,
            latency_ms: 1,
            providerUsed: 'middleware-recovered',
            provider: 'middleware-recovered',
            modelUsed: 'recovery-model',
            isFallback: true,
            timestamp: Date.now()
          };
        }
      };

      client.use(recoveryMiddleware);

      const res = await client.decide({
        state: 'test state',
        questions: {
          recovered: noul('Heal me')
        }
      });

      expect(res.providerUsed).toBe('middleware-recovered');
      expect(res.isFallback).toBe(true);
    });
  });

  // ==========================================
  // 4. Error Handling & Safe Fallback
  // ==========================================
  describe('Error Handling & Safe Fallback', () => {
    class MockRemoteFailureProvider extends JevProviderBase {
      readonly name = 'Simulated Remote API';
      readonly providerId = 'remote-failing';
      async execute(): Promise<any> {
        throw new JevProviderError('Remote upstream 502 Bad Gateway', 502, true);
      }
      async isHealthy(): Promise<boolean> {
        return false;
      }
      getMetadata(): ProviderMetadata {
        return {
          providerId: 'remote-failing',
          defaultModel: 'test',
          supportsLocalExecution: false,
          maxConcurrentRequests: 1
        };
      }
    }

    it('automatically degrades to MockEngine when remote provider crashes', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const client = new JevClient({
        providerInstance: new MockRemoteFailureProvider(),
        fallbackToMock: true
      });

      const res = await client.decide({
        state: 'User prompt',
        questions: {
          test: noul('Test prompt')
        }
      });

      expect(res.isFallback).toBe(true);
      expect(res.providerUsed).toBe('mock-engine-fallback');
      expect(res.answers.test).toBeDefined();

      consoleWarnSpy.mockRestore();
    });

    it('throws error when fallbackToMock is disabled', async () => {
      const client = new JevClient({
        providerInstance: new MockRemoteFailureProvider(),
        fallbackToMock: false
      });

      await expect(
        client.decide({
          state: 'User prompt',
          questions: {
            test: noul('Test prompt')
          }
        })
      ).rejects.toThrow(JevProviderError);
    });

    it('enforces execution timeout', async () => {
      class SlowProvider extends JevProviderBase {
        readonly name = 'Slow';
        readonly providerId = 'slow';
        async execute(): Promise<any> {
          await new Promise((r) => setTimeout(r, 200));
          return {} as any;
        }
        async isHealthy(): Promise<boolean> {
          return true;
        }
        getMetadata(): ProviderMetadata {
          return {
            providerId: 'slow',
            defaultModel: 'slow',
            supportsLocalExecution: false,
            maxConcurrentRequests: 1
          };
        }
      }

      const client = new JevClient({
        providerInstance: new SlowProvider(),
        timeoutMs: 25,
        fallbackToMock: false
      });

      await expect(
        client.decide({
          state: 'test',
          questions: { q: noul('q') }
        })
      ).rejects.toThrow(JevTimeoutError);
    });
  });

  // ==========================================
  // 5. Polymorphic Provider Initialization
  // ==========================================
  describe('Polymorphic Provider Initialization', () => {
    it('initializes MockEngine by default when no credentials provided', () => {
      const origOr = process.env.OPENROUTER_API_KEY;
      const origTs = process.env.TYPESAFE_API_KEY;
      delete process.env.OPENROUTER_API_KEY;
      delete process.env.TYPESAFE_API_KEY;
      try {
        const client = new JevClient();
        expect(client.provider).toBe('mock-engine');
        expect(client.providerInstance).toBeInstanceOf(MockEngine);
      } finally {
        if (origOr !== undefined) process.env.OPENROUTER_API_KEY = origOr;
        if (origTs !== undefined) process.env.TYPESAFE_API_KEY = origTs;
      }
    });

    it('initializes CloudflareWorkerProvider when aiBinding is passed', () => {
      const fakeAiBinding = {
        run: async () => ({ answers: {} })
      };
      const client = new JevClient({ aiBinding: fakeAiBinding });
      expect(client.provider).toBe('cloudflare-workers-ai');
      expect(client.providerInstance).toBeInstanceOf(CloudflareWorkerProvider);
    });

    it('initializes OpenRouterProvider when explicit apiKey is configured', () => {
      const client = new JevClient({
        provider: 'openrouter',
        apiKey: 'sk-or-test-key-12345'
      });
      expect(client.provider).toBe('openrouter');
      expect(client.providerInstance).toBeInstanceOf(OpenRouterProvider);
    });

    it('initializes TypeSafeProvider when explicit typesafe mode is chosen', () => {
      const client = new JevClient({
        provider: 'typesafe',
        apiKey: 'ts-test-key-67890'
      });
      expect(client.provider).toBe('typesafe');
      expect(client.providerInstance).toBeInstanceOf(TypeSafeProvider);
    });

    it('initializes custom provider via providerInstance', () => {
      class CustomProvider extends JevProviderBase {
        readonly name = 'Custom';
        readonly providerId = 'custom-provider';
        async execute(): Promise<any> {
          return {};
        }
        async isHealthy(): Promise<boolean> {
          return true;
        }
        getMetadata(): ProviderMetadata {
          return {
            providerId: 'custom-provider',
            defaultModel: 'custom',
            supportsLocalExecution: true,
            maxConcurrentRequests: 10
          };
        }
      }

      const client = new JevClient({ providerInstance: new CustomProvider() });
      expect(client.provider).toBe('custom-provider');
    });
  });

  // ==========================================
  // 6. S1Client & Backwards Compatibility
  // ==========================================
  describe('S1Client & Backwards Compatibility', () => {
    it('executes decisions seamlessly using S1Client', async () => {
      const s1 = new S1Client({ useMock: true });
      const res = await s1.decide({
        state: 'test prompt',
        questions: {
          safe: noul('Verify safety')
        }
      });
      expect(res.answers.safe).toBeDefined();
      expect(typeof res.answers.safe.noul).toBe('number');
      expect(res.providerUsed).toBe('mock-engine');
    });

    it('preserves JevClient as subclass/alias of S1Client', () => {
      const jev = new JevClient({ useMock: true });
      expect(jev).toBeInstanceOf(S1Client);
      expect(jev).toBeInstanceOf(JevClient);
    });
  });

  // ==========================================
  // 7. Security & Defensive Invariants
  // ==========================================
  describe('Security & Defensive Invariants', () => {
    it('prevents credential cross-contamination between providers', () => {
      const origEnv = process.env;
      process.env = {
        ...origEnv,
        OPENROUTER_API_KEY: 'sk-or-real-secret',
        TYPESAFE_API_KEY: 'ts-real-secret'
      };

      try {
        // When requesting OpenRouter without explicit key, it should use OPENROUTER_API_KEY, not TYPESAFE_API_KEY
        const orClient = new S1Client({ provider: 'openrouter' });
        expect(orClient.provider).toBe('openrouter');
        const orProvider = orClient.providerInstance as OpenRouterProvider;
        expect((orProvider as any).apiKey).toBe('sk-or-real-secret');

        // When requesting TypeSafe without explicit key, it should use TYPESAFE_API_KEY, not OPENROUTER_API_KEY
        const tsClient = new S1Client({ provider: 'typesafe' });
        expect(tsClient.provider).toBe('typesafe');
        const tsProvider = tsClient.providerInstance as TypeSafeProvider;
        expect((tsProvider as any).apiKey).toBe('ts-real-secret');

        // When only TYPESAFE_API_KEY is present and provider is openrouter without key:
        delete process.env.OPENROUTER_API_KEY;
        const safeClient = new S1Client({ provider: 'openrouter' });
        const safeProvider = safeClient.providerInstance as OpenRouterProvider;
        expect((safeProvider as any).apiKey).toBe(''); // Never leaks TYPESAFE_API_KEY!
      } finally {
        process.env = origEnv;
      }
    });

    it('survives circular reference state objects in MockEngine', async () => {
      const circularState: any = { message: 'hello' };
      circularState.self = circularState;

      const mock = new MockEngine();
      const res = await mock.execute({
        state: circularState,
        questions: {
          test: noul('Check safety')
        }
      });

      expect(res.answers.test).toBeDefined();
      expect(typeof res.answers.test.noul).toBe('number');
    });

    it('handles empty criteria safely without division-by-zero or undefined', async () => {
      const mock = new MockEngine();
      const res = await mock.execute({
        state: 'prompt',
        questions: {
          empty: choice('Empty choices', {})
        }
      });

      expect(res.answers.empty.choice).toBe('default');
      expect(res.answers.empty.confidence).toBe(1.0);
      expect(res.answers.empty.probabilities.default).toBe(1.0);
    });

    it('honors pre-aborted AbortSignal', async () => {
      const controller = new AbortController();
      controller.abort();

      const client = new S1Client({ useMock: true });
      await expect(
        client.decide(
          {
            state: 'test',
            questions: { q: noul('q') }
          },
          { abortSignal: controller.signal }
        )
      ).rejects.toThrow('Decision execution aborted by caller');
    });
  });
});

