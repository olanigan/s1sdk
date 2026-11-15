/**
 * Example 8: Advisory PR gate (Jev System-1 triage)
 *
 * Features implemented:
 *   1. Risk / impact score (score 1..5)
 *   2. Change classification (choice)
 *   5. Machine-readable receipt + CI wiring (JSON, step summary, exit codes)
 *   6. Policy checks (deterministic pre-filter + noul per policy)
 *
 * The gate is advisory by design: a single forward pass asks for a human when a
 * policy is confirmed or risk is high. It does not claim to review the code.
 *
 * Exactly one inference happens per PR. The receipt and CI wiring are pure
 * serialization of that response plus the deterministic diff reducer.
 *
 * Run:
 *   bun run examples/08-pr-gate.ts --base origin/main --head HEAD
 *   bun run examples/08-pr-gate.ts --base origin/main --head HEAD --stub
 *   bun run examples/08-pr-gate.ts --diff pr.diff --title "fix: ..." --json
 *
 * Exit codes:
 *   0  advisory pass/review (default), or below the --fail-on threshold
 *   1  verdict at or above --fail-on (e.g. --fail-on hold)
 *   2  configuration/provider error
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { S1Client } from '../src/index.js';
import {
  DevxConfigError,
  describeResolution,
  loadDotEnv,
  resolveProvider
} from './shared/provider.js';
import {
  reducePrState,
  toModelState,
  type PrMetadata
} from './shared/pr-state.js';
import {
  PR_GATE_QUESTION_DEFS,
  interpretPrGate,
  renderPrGateReceipt,
  renderPrGateSummary,
  type PrGateReceipt
} from './shared/pr-gate-schema.js';
import { PrGateStubProvider } from './shared/pr-gate-stub.js';

interface CliArgs {
  base?: string;
  head: string;
  diff?: string;
  title?: string;
  body?: string;
  labels?: string;
  author?: string;
  json: boolean;
  jsonFile?: string;
  summary?: string;
  failOn: 'none' | 'pass' | 'review' | 'hold';
  stub: boolean;
  provider?: string;
  model?: string;
  offline: boolean;
}

function parseCli(argv: readonly string[]): CliArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      base: { type: 'string' },
      head: { type: 'string', default: 'HEAD' },
      diff: { type: 'string' },
      title: { type: 'string' },
      body: { type: 'string' },
      labels: { type: 'string' },
      author: { type: 'string' },
      json: { type: 'boolean', default: false },
      'json-file': { type: 'string' },
      summary: { type: 'string' },
      'fail-on': { type: 'string', default: 'none' },
      stub: { type: 'boolean', default: false },
      provider: { type: 'string' },
      model: { type: 'string' },
      offline: { type: 'boolean', default: false }
    },
    allowPositionals: false
  });

  const failOn = String(values['fail-on'] ?? 'none');
  if (!['none', 'pass', 'review', 'hold'].includes(failOn)) {
    throw new Error(`--fail-on must be one of none|pass|review|hold (got "${failOn}")`);
  }

  return {
    ...(values.base ? { base: String(values.base) } : {}),
    head: String(values.head ?? 'HEAD'),
    ...(values.diff ? { diff: String(values.diff) } : {}),
    ...(values.title ? { title: String(values.title) } : {}),
    ...(values.body ? { body: String(values.body) } : {}),
    ...(values.labels ? { labels: String(values.labels) } : {}),
    ...(values.author ? { author: String(values.author) } : {}),
    json: Boolean(values.json),
    ...(values['json-file'] ? { jsonFile: String(values['json-file']) } : {}),
    ...(values.summary ? { summary: String(values.summary) } : {}),
    failOn: failOn as CliArgs['failOn'],
    stub: Boolean(values.stub),
    ...(values.provider ? { provider: String(values.provider) } : {}),
    ...(values.model ? { model: String(values.model) } : {}),
    offline: Boolean(values.offline)
  };
}

function git(args: readonly string[]): string {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  });
}

function refExists(ref: string): boolean {
  try {
    git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function resolveBase(explicit: string | undefined): string {
  if (explicit) return explicit;
  const candidates = ['origin/main', 'main', 'origin/master', 'master', 'HEAD~1'];
  for (const candidate of candidates) {
    if (refExists(candidate)) return candidate;
  }
  throw new Error('Could not resolve a base ref; pass --base <ref> or --diff <file>.');
}

function readDiff(base: string, head: string): string {
  try {
    return git(['diff', '--no-color', '--unified=3', `${base}...${head}`]);
  } catch {
    // Shallow clones can lack a merge base; fall back to a two-dot diff.
    return git(['diff', '--no-color', '--unified=3', base, head]);
  }
}

function readCommits(base: string, head: string): string[] {
  try {
    const out = git(['log', '--format=%s', `${base}..${head}`]).trim();
    return out ? out.split('\n') : [];
  } catch {
    return [];
  }
}

function splitLabels(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean);
}

async function main(): Promise<void> {
  const args = parseCli(process.argv.slice(2));
  loadDotEnv();

  const base = args.diff ? (args.base ?? '(file)') : resolveBase(args.base);
  const diffText = args.diff
    ? fs.readFileSync(args.diff, 'utf8')
    : readDiff(base, args.head);
  const commits = args.diff ? [] : readCommits(base, args.head);

  const author =
    args.author ?? process.env.PR_AUTHOR ?? (args.diff ? undefined : safeGitAuthor(args.head));

  const meta: PrMetadata = {
    title: args.title ?? process.env.PR_TITLE ?? (args.diff ? '(untitled)' : firstCommit(commits)),
    body: args.body ?? process.env.PR_BODY ?? '',
    ...(author ? { author } : {}),
    labels: splitLabels(args.labels ?? process.env.PR_LABELS),
    base,
    head: args.head
  };

  const state = reducePrState(diffText, meta, { commits });

  const { client, providerLabel } = await createClient(args);
  if (!args.json) {
    console.error(`provider: ${providerLabel}`);
    console.error(
      `state: ${state.signals.filesChanged} files, +${state.signals.additions}/-${state.signals.deletions}` +
        (state.filesTruncated ? ' (file list truncated for model)' : '')
    );
  }

  const decision = await client.decide({
    state: toModelState(state),
    questions: PR_GATE_QUESTION_DEFS
  });

  const receipt = interpretPrGate(state, decision);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } else {
    console.log(renderPrGateReceipt(receipt));
  }

  if (args.jsonFile) {
    fs.writeFileSync(args.jsonFile, `${JSON.stringify(receipt, null, 2)}\n`);
    if (!args.json) console.error(`receipt written: ${args.jsonFile}`);
  }

  const summaryTarget = args.summary ?? process.env.GITHUB_STEP_SUMMARY;
  if (summaryTarget) {
    fs.appendFileSync(summaryTarget, `${renderPrGateSummary(receipt)}\n`);
    if (!args.json) console.error(`step summary appended: ${summaryTarget}`);
  }

  process.exitCode = exitCodeFor(receipt, args.failOn);
}

function safeGitAuthor(head: string): string | undefined {
  try {
    return git(['log', '-1', '--format=%an', head]).trim() || undefined;
  } catch {
    return undefined;
  }
}

function firstCommit(commits: readonly string[]): string {
  return commits[0] ?? '(untitled)';
}

async function createClient(
  args: CliArgs
): Promise<{ client: S1Client; providerLabel: string }> {
  if (args.stub) {
    return {
      client: new S1Client({ providerInstance: new PrGateStubProvider() }),
      providerLabel: 'stub (offline; no model call)'
    };
  }

  const resolved = await resolveProvider({
    prefer: args.provider as any,
    requested: args.provider as any,
    probe: !args.offline
  });
  const options = args.model ? { ...resolved.options, model: args.model } : resolved.options;
  return {
    client: new S1Client(options),
    providerLabel: describeResolution(resolved)
  };
}

const VERDICT_RANK: Record<string, number> = { pass: 0, review: 1, hold: 2 };

function exitCodeFor(receipt: PrGateReceipt, failOn: CliArgs['failOn']): number {
  if (failOn === 'none') return 0;
  const threshold = VERDICT_RANK[failOn] ?? 0;
  const actual = VERDICT_RANK[receipt.decision.verdict] ?? 0;
  return actual >= threshold ? 1 : 0;
}

main().catch((err) => {
  if (err instanceof DevxConfigError) {
    console.error(`\n[pr-gate] ${err.message}`);
    for (const hint of err.hints) console.error(`  -> ${hint}`);
    process.exit(2);
  }
  console.error(`[pr-gate] ${err instanceof Error ? err.message : String(err)}`);
  if (process.env.S1SDK_DEBUG === '1' && err instanceof Error) console.error(err.stack);
  process.exit(1);
});
