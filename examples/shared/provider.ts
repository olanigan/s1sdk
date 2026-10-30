/**
 * devx provider resolver: one env-driven decision path for every example.
 *
 * The examples are meant to run with whatever the developer actually has:
 *
 *   TYPESAFE_API_KEY              -> TypeSafe AI REST
 *   OPENROUTER_API_KEY            -> OpenRouter decisions
 *   CLOUDFLARE_API_TOKEN + ACCOUNT_ID, or an `env.AI` binding -> Workers AI
 *   OLLAMA_HOST, or a daemon on 127.0.0.1:11434              -> local Ollama
 *   HOMESTEAD_*, or a daemon on 127.0.0.1:8080/18765         -> Homestead
 *
 * Resolution order is fixed and loud: the first provider with credentials wins,
 * the choice and its credential provenance are printed, and an explicit
 * `S1_PROVIDER` never falls through to a different vendor. Local providers are
 * probed before they are selected so a stale daemon URL cannot shadow a live one.
 *
 * Zero runtime dependencies: `node:fs` + global `fetch` only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { S1Client } from '../../src/index.js';
import { CLOUDFLARE_MODELS } from '../../src/types.js';
import type { S1ClientOptions, CloudflareAiBinding } from '../../src/index.js';

export type DevxProviderId =
  | 'typesafe'
  | 'openrouter'
  | 'cloudflare'
  | 'ollama'
  | 'homestead';

export type DevxEnv = Record<string, string | undefined>;

/** Default model per provider, overridable with `S1_MODEL`. */
export const DEFAULT_MODELS: Record<DevxProviderId, string> = {
  typesafe: 'jev-latest',
  openrouter: 'typesafe/jev-1.13',
  cloudflare: CLOUDFLARE_MODELS.CLEF_FLASH,
  ollama: 'tev1:0.8b',
  homestead: 'homerouter-420M'
};

/** How a candidate was chosen, surfaced in logs and `devx doctor`. */
export type ResolutionSource = 'env' | 'binding' | 'probe' | 'offline-fallback';

export interface ProviderCandidate {
  readonly provider: DevxProviderId;
  readonly options: S1ClientOptions;
  /** Credential provenance with the secret already masked. */
  readonly credential: string;
  /** Base URL to probe before selecting this candidate. */
  readonly probeUrls?: readonly string[];
  readonly source: ResolutionSource;
}

export interface ResolvedProvider extends ProviderCandidate {
  readonly notes: readonly string[];
}

export interface ResolveOptions {
  readonly env?: DevxEnv;
  /** Try this provider first, then the standard chain (used by examples 01/02). */
  readonly prefer?: DevxProviderId;
  /** Strict pin (`S1_PROVIDER` or `--provider`). No cross-provider fallback. */
  readonly requested?: DevxProviderId | 'auto';
  /** In-Worker `env.AI` binding; the only way to reach the in-process transport. */
  readonly binding?: CloudflareAiBinding;
  /** Probe local daemons before selection. Default: true. */
  readonly probe?: boolean;
  /** Return a last-resort Homestead candidate instead of throwing. Default: true. */
  readonly allowOfflineFallback?: boolean;
  readonly probeTimeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export class DevxConfigError extends Error {
  readonly hints: readonly string[];

  constructor(message: string, hints: readonly string[] = []) {
    super(message);
    this.name = 'DevxConfigError';
    this.hints = hints;
  }
}

// ==========================================
// 1. Env loading
// ==========================================

const ENV_FILE_NAMES = ['.env', '.env.local', '.dev.vars'] as const;

/** Parses a dotenv file without mutating `process.env`. */
export function parseDotEnv(contents: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

/**
 * Loads `.env` / `.env.local` / `.dev.vars` from `startDir` and up to three
 * parents into `process.env`. Existing variables always win, so an explicit
 * shell export beats a checked-out file.
 */
export function loadDotEnv(
  startDir: string = process.cwd(),
  env: DevxEnv = process.env
): string[] {
  const loaded: string[] = [];
  let dir = path.resolve(startDir);
  for (let depth = 0; depth < 4; depth += 1) {
    for (const name of ENV_FILE_NAMES) {
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) continue;
      const parsed = parseDotEnv(fs.readFileSync(file, 'utf8'));
      let touched = false;
      for (const [key, value] of Object.entries(parsed)) {
        if (env[key] === undefined || env[key] === '') {
          env[key] = value;
          touched = true;
        }
      }
      if (touched) loaded.push(file);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return loaded;
}

// ==========================================
// 2. Small helpers
// ==========================================

/** `ts-abcdef123456` -> `ts-abc…3456`. Empty input -> `(unset)`. */
export function maskSecret(secret: string | undefined): string {
  const value = (secret ?? '').trim();
  if (!value) return '(unset)';
  if (value.length <= 8) return `${value.slice(0, 2)}…`;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/** Normalizes `host`, `host:port` or a full URL to an `http(s)` base URL. */
export function toBaseUrl(raw: string): string {
  let trimmed = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(trimmed)) trimmed = `http://${trimmed}`;
  return trimmed.replace(/\/(v1\/systemone|v1|api)\/?$/, '');
}

function readTimeout(env: DevxEnv, fallback: number): number {
  const parsed = Number(env.S1_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// ==========================================
// 3. Candidate detection (pure)
// ==========================================

/**
 * Builds the ordered candidate list for an environment. Pure: no probing, no
 * network, no mutation. `resolveProvider` does the selection.
 */
export function detectCandidates(
  env: DevxEnv,
  options: Pick<ResolveOptions, 'prefer' | 'binding'> = {}
): ProviderCandidate[] {
  const modelFor = (provider: DevxProviderId): string =>
    env.S1_MODEL?.trim() || DEFAULT_MODELS[provider];

  const typesafe: ProviderCandidate = {
    provider: 'typesafe',
    credential: `TYPESAFE_API_KEY=${maskSecret(env.TYPESAFE_API_KEY)}`,
    source: 'env',
    options: {
      provider: 'typesafe',
      apiKey: env.TYPESAFE_API_KEY ?? '',
      endpoint: env.TYPESAFE_ENDPOINT,
      model: modelFor('typesafe'),
      timeoutMs: readTimeout(env, 10_000)
    }
  };

  const openrouter: ProviderCandidate = {
    provider: 'openrouter',
    credential: `OPENROUTER_API_KEY=${maskSecret(env.OPENROUTER_API_KEY)}`,
    source: 'env',
    options: {
      provider: 'openrouter',
      apiKey: env.OPENROUTER_API_KEY ?? '',
      endpoint: env.OPENROUTER_ENDPOINT,
      model: modelFor('openrouter'),
      timeoutMs: readTimeout(env, 10_000)
    }
  };

  const cloudflare: ProviderCandidate = {
    provider: 'cloudflare',
    credential: options.binding
      ? 'env.AI binding (in-process, zero egress)'
      : `CLOUDFLARE_API_TOKEN=${maskSecret(env.CLOUDFLARE_API_TOKEN)} account=${env.CLOUDFLARE_ACCOUNT_ID ? maskSecret(env.CLOUDFLARE_ACCOUNT_ID) : '(unset)'}`,
    source: options.binding ? 'binding' : 'env',
    options: {
      provider: 'cloudflare',
      aiBinding: options.binding,
      cloudflareApiToken: env.CLOUDFLARE_API_TOKEN,
      cloudflareAccountId: env.CLOUDFLARE_ACCOUNT_ID,
      model: modelFor('cloudflare'),
      timeoutMs: readTimeout(env, 15_000)
    }
  };

  const ollamaBase = env.OLLAMA_HOST ? toBaseUrl(env.OLLAMA_HOST) : 'http://127.0.0.1:11434';
  const ollama: ProviderCandidate = {
    provider: 'ollama',
    credential: env.OLLAMA_HOST
      ? `OLLAMA_HOST=${ollamaBase}`
      : `probe ${ollamaBase} (no OLLAMA_HOST set)`,
    source: env.OLLAMA_HOST ? 'env' : 'probe',
    probeUrls: [ollamaBase],
    options: {
      provider: 'ollama',
      endpoint: ollamaBase,
      model: modelFor('ollama'),
      keepAlive: env.S1_KEEP_ALIVE,
      timeoutMs: readTimeout(env, 30_000)
    }
  };

  const homesteadBase = toBaseUrl(
    env.HOMESTEAD_API_URL ||
      env.HOMESTEAD_S1_URL ||
      env.HOMESTEAD_ENDPOINT ||
      'http://127.0.0.1:8080'
  );
  const homestead: ProviderCandidate = {
    provider: 'homestead',
    credential: env.HOMESTEAD_API_URL || env.HOMESTEAD_S1_URL || env.HOMESTEAD_ENDPOINT
      ? `HOMESTEAD_API_URL=${homesteadBase}`
      : `probe ${homesteadBase} (no HOMESTEAD_API_URL set)`,
    source: env.HOMESTEAD_API_URL || env.HOMESTEAD_S1_URL || env.HOMESTEAD_ENDPOINT
      ? 'env'
      : 'probe',
    probeUrls: [homesteadBase],
    options: {
      provider: 'homestead',
      endpoint: homesteadBase,
      apiKey: env.HOMESTEAD_API_KEY,
      model: modelFor('homestead'),
      keepAlive: env.S1_KEEP_ALIVE,
      timeoutMs: readTimeout(env, 10_000)
    }
  };

  // Only list providers whose credentials are actually present. Local daemons
  // are always listed; their probe decides whether they win.
  const available: ProviderCandidate[] = [];
  if (env.TYPESAFE_API_KEY) available.push(typesafe);
  if (env.OPENROUTER_API_KEY) available.push(openrouter);
  if (options.binding || (env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID)) {
    available.push(cloudflare);
  }
  available.push(ollama, homestead);

  const prefer = options.prefer;
  if (!prefer) return available;
  const preferred = available.find((candidate) => candidate.provider === prefer);
  if (!preferred) return available;
  return [preferred, ...available.filter((candidate) => candidate.provider !== prefer)];
}

// ==========================================
// 4. Probing
// ==========================================

/** Cheap reachability check. Never throws; `false` on any failure. */
export async function probeEndpoint(
  baseUrl: string,
  options: { readonly timeoutMs?: number; readonly fetchImpl?: typeof fetch } = {}
): Promise<boolean> {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 750;
  for (const suffix of ['', '/health', '/v1/models']) {
    try {
      const res = await doFetch(`${baseUrl}${suffix}`, {
        method: 'GET',
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (res.ok) return true;
      if (res.status >= 400 && res.status < 500 && res.status !== 404) return false;
    } catch {
      return false;
    }
  }
  return false;
}

// ==========================================
// 5. Resolution
// ==========================================

function normalizeProviderId(value: string | undefined): DevxProviderId | 'auto' | undefined {
  if (!value) return undefined;
  const raw = value.trim().toLowerCase();
  if (raw === '' || raw === 'auto') return 'auto';
  if (raw === 'cloudflare-worker' || raw === 'cloudflare-workers-ai' || raw === 'cf') {
    return 'cloudflare';
  }
  if (raw === 'local') return 'homestead';
  const known: DevxProviderId[] = ['typesafe', 'openrouter', 'cloudflare', 'ollama', 'homestead'];
  return known.find((id) => id === raw);
}

const SETUP_HINTS: Record<DevxProviderId, readonly string[]> = {
  typesafe: ['export TYPESAFE_API_KEY="ts-..."'],
  openrouter: ['export OPENROUTER_API_KEY="sk-or-..."'],
  cloudflare: [
    'export CLOUDFLARE_API_TOKEN="..." && export CLOUDFLARE_ACCOUNT_ID="..."',
    'in a Worker, pass `binding: env.AI` instead of a token'
  ],
  ollama: ['ollama serve', 'ollama pull tev1:0.8b', 'export OLLAMA_HOST=127.0.0.1:11434'],
  homestead: ['homestead serve homerouter', 'export HOMESTEAD_API_URL=http://127.0.0.1:8080']
};

/**
 * Picks the provider to run against.
 *
 * Strict pin (`requested`): only that provider is considered. If its credentials
 * are missing this throws `DevxConfigError` rather than silently billing or
 * calling a different vendor.
 *
 * Auto: first candidate with credentials wins; local daemons must answer a probe.
 * With nothing configured, the Homestead candidate is returned as an
 * `offline-fallback` so the caller gets a real connection error with the daemon
 * start command, not a config puzzle.
 */
export async function resolveProvider(
  options: ResolveOptions = {}
): Promise<ResolvedProvider> {
  const env = options.env ?? process.env;
  const notes: string[] = [];
  const requested = normalizeProviderId(
    options.requested !== undefined ? String(options.requested) : env.S1_PROVIDER
  );
  const preferParam = options.prefer ?? normalizeProviderId(env.S1_PREFER_PROVIDER);
  const prefer = preferParam && preferParam !== 'auto' ? preferParam : undefined;
  const shouldProbe = options.probe ?? env.S1_SKIP_PROBE !== '1';

  const candidates = detectCandidates(env, { prefer, binding: options.binding });

  if (requested && requested !== 'auto') {
    const pinned = candidates.find((candidate) => candidate.provider === requested);
    if (!pinned) {
      throw new DevxConfigError(
        `S1_PROVIDER=${requested} was requested but its credentials are missing.`,
        SETUP_HINTS[requested]
      );
    }
    if (shouldProbe && pinned.probeUrls?.length) {
      const alive = await probeEndpoint(pinned.probeUrls[0] ?? '', {
        timeoutMs: options.probeTimeoutMs,
        fetchImpl: options.fetchImpl
      });
      if (!alive) {
        notes.push(
          `pinned to ${requested}, but ${pinned.probeUrls[0]} did not answer the probe — continuing so the real connection error surfaces`
        );
      }
    }
    return { ...pinned, notes };
  }

  for (const candidate of candidates) {
    const needsProbe = candidate.probeUrls !== undefined && candidate.probeUrls.length > 0;
    // Hosted providers carry their own credential and need no reachability check.
    if (!needsProbe) return { ...candidate, notes };

    // Probing disabled: trust an endpoint the developer configured explicitly,
    // but never select a daemon we invented out of the default port.
    if (!shouldProbe) {
      if (candidate.source === 'env') return { ...candidate, notes };
      continue;
    }

    const alive = await probeEndpoint(candidate.probeUrls?.[0] ?? '', {
      timeoutMs: options.probeTimeoutMs,
      fetchImpl: options.fetchImpl
    });
    if (alive) {
      notes.push(`${candidate.provider} answered at ${candidate.probeUrls?.[0]}`);
      return { ...candidate, notes };
    }
    if (candidate.source === 'env') {
      notes.push(
        `${candidate.provider} is configured (${candidate.credential}) but did not answer at ${candidate.probeUrls?.[0]}; skipping`
      );
    }
  }

  if (options.allowOfflineFallback === false) {
    throw new DevxConfigError(
      'No System-1 provider is reachable: no API keys found and no local daemon answered.',
      [
        'export TYPESAFE_API_KEY=... or OPENROUTER_API_KEY=...',
        'or run `ollama serve` (then `ollama pull tev1:0.8b`)',
        'or run `homestead serve homerouter`'
      ]
    );
  }

  const fallback = candidates[candidates.length - 1] as ProviderCandidate;
  notes.push(
    'no credentials and no daemon answered — falling back to local Homestead so the connection error is actionable'
  );
  return { ...fallback, source: 'offline-fallback', notes };
}

/** Resolved provider plus a ready client. */
export async function createClient(
  options: ResolveOptions = {}
): Promise<{ client: S1Client; resolved: ResolvedProvider }> {
  const resolved = await resolveProvider(options);
  return { client: new S1Client(resolved.options), resolved };
}

/** One-line banner describing the active provider, for example headers. */
export function describeResolution(resolved: ResolvedProvider): string {
  const model = resolved.options.model ?? DEFAULT_MODELS[resolved.provider];
  return `${resolved.provider} · ${model} · ${resolved.credential} · source=${resolved.source}`;
}
