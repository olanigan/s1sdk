import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectCandidates,
  loadDotEnv,
  maskSecret,
  parseDotEnv,
  probeEndpoint,
  resolveProvider,
  toBaseUrl,
  DevxConfigError
} from '../examples/shared/provider.js';

const NO_LOCAL_PROBE = { probe: false } as const;

describe('devx env loading', () => {
  it('parses dotenv lines, quotes and comments', () => {
    const parsed = parseDotEnv(
      [
        '# comment',
        'A=plain',
        'B="quoted value"',
        "C='single'",
        'D=with=equals',
        'not a pair'
      ].join('\n')
    );
    expect(parsed).toEqual({
      A: 'plain',
      B: 'quoted value',
      C: 'single',
      D: 'with=equals'
    });
  });

  it('does not overwrite an exported variable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's1sdk-devx-'));
    fs.writeFileSync(path.join(dir, '.env'), 'TYPESAFE_API_KEY=from-file\n');
    const env: Record<string, string | undefined> = { TYPESAFE_API_KEY: 'from-shell' };

    const loaded = loadDotEnv(dir, env);

    expect(loaded).toHaveLength(0);
    expect(env.TYPESAFE_API_KEY).toBe('from-shell');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('loads a file value when the variable is empty', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's1sdk-devx-'));
    fs.writeFileSync(path.join(dir, '.env'), 'OPENROUTER_API_KEY=sk-or-from-file\n');
    const env: Record<string, string | undefined> = { OPENROUTER_API_KEY: '' };

    loadDotEnv(dir, env);

    expect(env.OPENROUTER_API_KEY).toBe('sk-or-from-file');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('devx masking', () => {
  it('keeps a short prefix and suffix for identification', () => {
    expect(maskSecret('ts-abcdef1234567890')).toBe('ts-abc…7890');
    expect(maskSecret('')).toBe('(unset)');
    expect(maskSecret(undefined)).toBe('(unset)');
    expect(maskSecret('short')).toBe('sh…');
  });
});

describe('devx url normalization', () => {
  it('adds a scheme and strips the decision route', () => {
    expect(toBaseUrl('127.0.0.1:11434')).toBe('http://127.0.0.1:11434');
    expect(toBaseUrl('http://127.0.0.1:8080/v1/systemone')).toBe('http://127.0.0.1:8080');
    expect(toBaseUrl('https://api.example.com/v1/')).toBe('https://api.example.com');
  });
});

describe('devx candidate detection', () => {
  it('withholds hosted providers whose credentials are absent', () => {
    const ids = detectCandidates({}).map((candidate) => candidate.provider);
    expect(ids).toEqual(['ollama', 'homestead']);
  });

  it('orders hosted providers typesafe -> openrouter -> cloudflare', () => {
    const ids = detectCandidates({
      TYPESAFE_API_KEY: 'ts-1',
      OPENROUTER_API_KEY: 'sk-or-1',
      CLOUDFLARE_API_TOKEN: 'cf-token',
      CLOUDFLARE_ACCOUNT_ID: 'cf-account'
    }).map((candidate) => candidate.provider);
    expect(ids).toEqual(['typesafe', 'openrouter', 'cloudflare', 'ollama', 'homestead']);
  });

  it('requires both Cloudflare credentials for the REST transport', () => {
    const ids = detectCandidates({ CLOUDFLARE_API_TOKEN: 'cf-token' }).map((c) => c.provider);
    expect(ids).not.toContain('cloudflare');
  });

  it('accepts an env.AI binding as the Cloudflare credential', () => {
    const binding = { run: async () => ({}) };
    const candidate = detectCandidates({}, { binding }).find((c) => c.provider === 'cloudflare');
    expect(candidate?.source).toBe('binding');
    expect(candidate?.options.aiBinding).toBe(binding);
  });

  it('honours a preference without dropping the rest of the chain', () => {
    const ids = detectCandidates(
      { TYPESAFE_API_KEY: 'ts-1', OPENROUTER_API_KEY: 'sk-or-1' },
      { prefer: 'openrouter' }
    ).map((candidate) => candidate.provider);
    expect(ids).toEqual(['openrouter', 'typesafe', 'ollama', 'homestead']);
  });

  it('uses S1_MODEL to override the provider default', () => {
    const candidate = detectCandidates({ TYPESAFE_API_KEY: 'ts-1', S1_MODEL: 'jev-custom' })[0];
    expect(candidate?.options.model).toBe('jev-custom');
  });
});

describe('devx resolution', () => {
  it('prefers a hosted key over any local daemon', async () => {
    const resolved = await resolveProvider({
      env: { TYPESAFE_API_KEY: 'ts-1' },
      ...NO_LOCAL_PROBE
    });
    expect(resolved.provider).toBe('typesafe');
    expect(resolved.source).toBe('env');
  });

  it('pins strictly and never silently rebills another vendor', async () => {
    await expect(
      resolveProvider({ env: {}, requested: 'openrouter', ...NO_LOCAL_PROBE })
    ).rejects.toBeInstanceOf(DevxConfigError);
  });

  it('falls back to a local candidate when S1_PROVIDER pins one', async () => {
    const resolved = await resolveProvider({ env: {}, requested: 'ollama', ...NO_LOCAL_PROBE });
    expect(resolved.provider).toBe('ollama');
    expect(resolved.options.provider).toBe('ollama');
  });

  it('returns an offline-fallback candidate rather than a config puzzle', async () => {
    const resolved = await resolveProvider({
      env: {},
      probe: false,
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      }
    });
    expect(resolved.source).toBe('offline-fallback');
    expect(resolved.notes.join(' ')).toMatch(/actionable/);
  });

  it('throws actionable hints when fallback is disabled', async () => {
    await expect(
      resolveProvider({
        env: {},
        probe: false,
        allowOfflineFallback: false,
        fetchImpl: async () => {
          throw new Error('ECONNREFUSED');
        }
      })
    ).rejects.toBeInstanceOf(DevxConfigError);
  });

  it('selects a local daemon that answers the probe', async () => {
    const resolved = await resolveProvider({
      env: { OLLAMA_HOST: '127.0.0.1:11434' },
      fetchImpl: (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.startsWith('http://127.0.0.1:11434')) {
          return new Response('Ollama is running', { status: 200 });
        }
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch
    });
    expect(resolved.provider).toBe('ollama');
    expect(resolved.source).toBe('env');
  });
});

describe('devx probing', () => {
  it('returns false instead of throwing on network faults', async () => {
    const alive = await probeEndpoint('http://127.0.0.1:1', {
      timeoutMs: 50,
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch
    });
    expect(alive).toBe(false);
  });

  it('stops at the first healthy route', async () => {
    const calls: string[] = [];
    const alive = await probeEndpoint('http://example.test', {
      fetchImpl: (async (input: string | URL | Request) => {
        calls.push(String(input));
        return new Response('ok', { status: 200 });
      }) as unknown as typeof fetch
    });
    expect(alive).toBe(true);
    expect(calls).toEqual(['http://example.test']);
  });
});
