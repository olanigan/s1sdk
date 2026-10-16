import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  S1Client,
  HomesteadProvider,
  OllamaProvider,
  choice,
  noul,
  score,
  JevProviderError,
  JevAuthenticationError
} from '../src/index.js';

describe('Homestead & Ollama System-1 Providers', () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  describe('Provider Initialization & Resolution', () => {
    it('initializes HomesteadProvider with default localhost daemon endpoint', () => {
      const provider = new HomesteadProvider();
      expect(provider.providerId).toBe('homestead');
      expect(provider.name).toBe('Homestead Sovereign S1 Provider');
      expect(provider.getMetadata().supportsLocalExecution).toBe(true);
      expect(provider.getMetadata().defaultModel).toBe('homerouter-420M');
    });

    it('initializes OllamaProvider targeting port 11434 and tev1:0.8b default model', () => {
      const provider = new OllamaProvider();
      expect(provider.providerId).toBe('ollama');
      expect(provider.name).toBe('Ollama System-1 Provider');
      expect(provider.getMetadata().supportsLocalExecution).toBe(true);
      expect(provider.getMetadata().defaultModel).toBe('tev1:0.8b');
    });

    it('resolves HomesteadProvider via S1Client when provider is "homestead" or "local"', () => {
      const clientHomestead = new S1Client({ provider: 'homestead' });
      expect(clientHomestead.provider).toBe('homestead');
      expect(clientHomestead.providerInstance).toBeInstanceOf(HomesteadProvider);

      const clientLocal = new S1Client({ provider: 'local' });
      expect(clientLocal.provider).toBe('homestead');
      expect(clientLocal.providerInstance).toBeInstanceOf(HomesteadProvider);
    });

    it('resolves OllamaProvider via S1Client when provider is "ollama"', () => {
      const clientOllama = new S1Client({ provider: 'ollama' });
      expect(clientOllama.provider).toBe('ollama');
      expect(clientOllama.providerInstance).toBeInstanceOf(OllamaProvider);
    });

    it('auto-resolves HomesteadProvider when HOMESTEAD_API_URL is set in environment', () => {
      delete process.env.OPENROUTER_API_KEY;
      delete process.env.TYPESAFE_API_KEY;
      process.env.HOMESTEAD_API_URL = 'http://127.0.0.1:18765';

      const client = new S1Client();
      expect(client.provider).toBe('homestead');
      expect(client.providerInstance).toBeInstanceOf(HomesteadProvider);
    });

    it('auto-resolves OllamaProvider when OLLAMA_HOST is set in environment', () => {
      delete process.env.OPENROUTER_API_KEY;
      delete process.env.TYPESAFE_API_KEY;
      delete process.env.HOMESTEAD_API_URL;
      delete process.env.HOMESTEAD_S1_URL;
      delete process.env.HOMESTEAD_ENDPOINT;
      process.env.OLLAMA_HOST = '127.0.0.1:11434';

      const client = new S1Client();
      expect(client.provider).toBe('ollama');
      expect(client.providerInstance).toBeInstanceOf(OllamaProvider);
    });

    it('sanitizes and normalizes endpoint URLs missing /v1/systemone', () => {
      const homesteadProvider = new HomesteadProvider({
        endpoint: 'http://127.0.0.1:18765'
      });
      // @ts-expect-error accessing protected endpoint for verification
      expect(homesteadProvider.endpoint).toBe('http://127.0.0.1:18765/v1/systemone');

      const ollamaProvider = new OllamaProvider({
        endpoint: 'http://127.0.0.1:11434'
      });
      // @ts-expect-error accessing protected endpoint for verification
      expect(ollamaProvider.endpoint).toBe('http://127.0.0.1:11434/v1/systemone');

      const trailingSlashProvider = new OllamaProvider({
        endpoint: 'http://127.0.0.1:11434/v1/systemone/'
      });
      // @ts-expect-error accessing protected endpoint for verification
      expect(trailingSlashProvider.endpoint).toBe('http://127.0.0.1:11434/v1/systemone');
    });
  });

  describe('Wire Payload Parity & Decision Execution', () => {
    it('formats wire payload adhering to SPEC-002 (/v1/systemone dictionary questions)', async () => {
      let interceptedUrl = '';
      let interceptedBody: any = null;
      let interceptedHeaders: any = null;

      globalThis.fetch = vi.fn().mockImplementation(async (url: string, init: any) => {
        interceptedUrl = url;
        interceptedBody = JSON.parse(init.body);
        interceptedHeaders = init.headers;

        return {
          ok: true,
          status: 200,
          json: async () => ({
            answers: {
              intent: {
                type: 'choice',
                choice: 'deploy',
                probabilities: { deploy: 0.92, status: 0.08 },
                confidence: 0.84
              },
              is_safe: {
                type: 'noul',
                noul: 0.99
              }
            },
            latency_ms: 3,
            model: 'tev1:0.8b',
            usage: {
              input_tokens: 42,
              output_tokens: 2
            }
          })
        };
      });

      const provider = new HomesteadProvider({
        endpoint: 'http://127.0.0.1:18765/v1/systemone',
        keepAlive: '5m'
      });

      const res = await provider.execute({
        model: 'tev1:0.8b',
        state: 'git push production main',
        questions: {
          intent: choice('What is user intent?', {
            deploy: 'Deploy code to production',
            status: 'Check build status'
          }),
          is_safe: noul('Is this command safe to execute?')
        }
      });

      expect(interceptedUrl).toBe('http://127.0.0.1:18765/v1/systemone');
      expect(interceptedBody.model).toBe('tev1:0.8b');
      expect(interceptedBody.state).toBe('git push production main');
      expect(interceptedBody.keep_alive).toBe('5m');
      expect(interceptedBody.questions.intent.type).toBe('choice');
      expect(interceptedBody.questions.is_safe.type).toBe('noul');
      expect(interceptedHeaders['X-Client']).toBe('s1sdk/0.1.0');

      expect(res.answers.intent.choice).toBe('deploy');
      expect(res.answers.is_safe.noul).toBe(0.99);
      expect(res.latencyMs).toBe(3);
      expect(res.latency_ms).toBe(3);
      expect(res.usage?.inputTokens).toBe(42);
      expect(res.usage?.outputTokens).toBe(2);
      expect(res.isFallback).toBe(false);
    });

    it('handles connection failure with informative guidance for daemon startup', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:18765'));

      const provider = new HomesteadProvider({
        endpoint: 'http://127.0.0.1:18765/v1/systemone'
      });

      await expect(
        provider.execute({
          state: 'test state',
          questions: {
            flag: noul('Check condition')
          }
        })
      ).rejects.toThrow(/Homestead S1 daemon connection failed.*homestead serve/);
    });

    it('surfaces 401 unauthorized errors cleanly', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => 'Bearer token invalid'
      });

      const provider = new HomesteadProvider({
        endpoint: 'http://127.0.0.1:18765/v1/systemone',
        apiKey: 'bad-key'
      });

      await expect(
        provider.execute({
          state: 'test',
          questions: { flag: noul('Test') }
        })
      ).rejects.toThrow(JevAuthenticationError);
    });
  });
});
