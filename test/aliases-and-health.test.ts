import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  S1Client,
  CloudflareProvider,
  HomesteadProvider,
  OllamaProvider,
  CLOUDFLARE_MODELS,
  choice,
  JevCircuitBreakerOpenError,
  type CloudflareAiBinding
} from '../src/index.js';

/**
 * Small public surface that the main suites never touch: provider `decide()`
 * aliases, health probes, and the circuit-breaker error type. These are cheap
 * to verify and each one is part of the published API.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const QUESTIONS = { action: choice('Pick an action', { read: 'read', write: 'write' }) };
const DECISION_ENVELOPE = {
  answers: { action: { type: 'choice', choice: 'read', confidence: 0.93 } },
  usage: { input_tokens: 12, output_tokens: 0 }
};

describe('provider decide() aliases', () => {
  it('CloudflareProvider.decide() dispatches the same payload as execute()', async () => {
    const models: string[] = [];
    const binding: CloudflareAiBinding = {
      run: async (model: string) => {
        models.push(model);
        return DECISION_ENVELOPE;
      }
    };
    const provider = new CloudflareProvider(binding, CLOUDFLARE_MODELS.CLEF_FLASH);

    const viaAlias = await provider.decide({ state: 'read the notes', questions: QUESTIONS });
    const viaExecute = await provider.execute({ state: 'read the notes', questions: QUESTIONS });

    expect(models).toEqual([CLOUDFLARE_MODELS.CLEF_FLASH, CLOUDFLARE_MODELS.CLEF_FLASH]);
    expect(viaAlias.answers).toEqual(viaExecute.answers);
    expect(viaAlias.providerUsed).toBe('cloudflare-workers-ai');
  });

  it('HomesteadProvider.decide() dispatches the same payload as execute()', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: any) => {
        calls.push(String(url));
        return new Response(JSON.stringify(DECISION_ENVELOPE), { status: 200 });
      })
    );
    const provider = new HomesteadProvider({ endpoint: 'http://127.0.0.1:18765/v1/systemone' });

    const viaAlias = await provider.decide({ state: 'read the notes', questions: QUESTIONS });
    const viaExecute = await provider.execute({ state: 'read the notes', questions: QUESTIONS });

    expect(calls).toEqual(['http://127.0.0.1:18765/v1/systemone', 'http://127.0.0.1:18765/v1/systemone']);
    expect(viaAlias.answers).toEqual(viaExecute.answers);
  });

  it('S1Client.systemOne() is decide() under the SPEC-001 name', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(DECISION_ENVELOPE), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new S1Client({ provider: 'homestead', endpoint: 'http://127.0.0.1:18765/v1/systemone' });

    const alias = await client.systemOne({ state: 'read the notes', questions: QUESTIONS });
    const canonical = await client.decide({ state: 'read the notes', questions: QUESTIONS });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(alias.answers).toEqual(canonical.answers);
  });
});

describe('provider health probes', () => {
  it('CloudflareProvider.isHealthy() reports transport availability without any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const binding = new CloudflareProvider({ run: async () => DECISION_ENVELOPE });
    expect(await binding.isHealthy()).toBe(true);

    const rest = new CloudflareProvider({ apiToken: 't', accountId: 'a' });
    expect(await rest.isHealthy()).toBe(true);

    const unconfigured = new CloudflareProvider({});
    expect(await unconfigured.isHealthy()).toBe(false);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('HomesteadProvider.isHealthy() probes /health derived from the decision endpoint', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: any) => {
        calls.push(String(url));
        return new Response('ok', { status: 200 });
      })
    );
    const provider = new HomesteadProvider({ endpoint: 'http://127.0.0.1:18765/v1/systemone' });

    expect(await provider.isHealthy()).toBe(true);
    expect(calls).toEqual(['http://127.0.0.1:18765/health']);
  });

  it('HomesteadProvider.isHealthy() returns false instead of throwing when the daemon is down', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      })
    );

    await expect(new HomesteadProvider({ endpoint: 'http://127.0.0.1:18765/v1/systemone' }).isHealthy()).resolves.toBe(false);
  });

  it('OllamaProvider.isHealthy() probes the daemon root and advertises its own metadata', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: any) => {
        calls.push(String(url));
        return new Response('Ollama is running', { status: 200 });
      })
    );
    const provider = new OllamaProvider();

    expect(await provider.isHealthy()).toBe(true);
    expect(calls).toEqual(['http://127.0.0.1:11434']);
    expect(provider.getMetadata()).toEqual({
      providerId: 'ollama',
      defaultModel: 'tev1:0.8b',
      supportsLocalExecution: true,
      maxConcurrentRequests: 64
    });
  });
});

describe('JevCircuitBreakerOpenError', () => {
  it('is a non-retryable JevError that names the provider', () => {
    const err = new JevCircuitBreakerOpenError('cloudflare');

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('JevCircuitBreakerOpenError');
    expect(err.code).toBe('JEV_CIRCUIT_OPEN');
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('cloudflare');
  });
});
