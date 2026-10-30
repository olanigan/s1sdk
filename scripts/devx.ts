#!/usr/bin/env bun
/**
 * s1sdk devx — one command for the whole local loop.
 *
 *   bun run devx                 doctor + smoke against the auto-detected provider
 *   bun run devx doctor          which credentials/daemons are visible, and what wins
 *   bun run devx smoke           one real decision + latency, against the winner
 *   bun run devx list            the runnable examples
 *   bun run devx example 02      run examples/02-* through the resolver
 *   bun run devx examples        run every provider-agnostic example in order
 *
 * Flags: --provider <id>  --model <id>  --ticket <key>  --offline  --quiet
 *
 * Nothing here is required to use the SDK; it exists so a fresh clone needs one
 * command and one credential instead of a per-example checklist.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { S1Client } from '../src/index.js';
import {
  loadDotEnv,
  resolveProvider,
  describeResolution,
  maskSecret,
  probeEndpoint,
  toBaseUrl,
  DevxConfigError,
  type DevxProviderId,
  type ResolvedProvider
} from '../examples/shared/provider.js';
import { customerServiceQuestions, sampleTickets } from '../examples/shared/customer-service-schema.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLES_DIR = path.join(REPO_ROOT, 'examples');

interface CliArgs {
  command: string;
  target?: string;
  provider?: DevxProviderId;
  model?: string;
  ticket: string;
  offline: boolean;
  quiet: boolean;
  passthrough: string[];
}

function parseCli(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    command: 'all',
    ticket: 'doubleBillingAngry',
    offline: false,
    quiet: false,
    passthrough: []
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--provider' || arg === '-p') args.provider = argv[++i] as DevxProviderId;
    else if (arg === '--model' || arg === '-m') args.model = argv[++i];
    else if (arg === '--ticket' || arg === '-t') args.ticket = argv[++i] as string;
    else if (arg === '--offline') args.offline = true;
    else if (arg === '--quiet' || arg === '-q') args.quiet = true;
    else if (arg.startsWith('-')) args.passthrough.push(arg);
    else rest.push(arg);
  }
  args.command = rest[0] ?? 'all';
  args.target = rest[1];
  return args;
}

/** Example registry: what each file needs, so `devx examples` can skip misfits. */
const EXAMPLES = [
  { id: '0', file: '00-quickstart.ts', needs: 'any provider', title: 'provider-agnostic quickstart' },
  { id: '1', file: '01-typesafe-customer-service.ts', needs: 'any provider (prefers TypeSafe)', title: 'TypeSafe REST' },
  { id: '2', file: '02-openrouter-customer-service.ts', needs: 'any provider (prefers OpenRouter)', title: 'OpenRouter' },
  { id: '4', file: '04-offline-fallback-resilience.ts', needs: 'no credentials', title: 'onError failover' },
  { id: '5', file: '05-homerouter-v1-1-agentic-dispatch.ts', needs: 'homestead daemon', title: 'HomeRouter dispatch' },
  { id: '7', file: '07-clairic-invoice-extraction.ts', needs: 'cloudflare (stubs without)', title: 'Clairic extraction' }
] as const;

const SKIP_IN_RUN_ALL = new Set(['5']);

function color(enabled: boolean, code: number): (text: string) => string {
  return (text) => (enabled ? `\u001b[${code}m${text}\u001b[0m` : text);
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const dim = color(useColor, 2);
const bold = color(useColor, 1);
const green = color(useColor, 32);
const yellow = color(useColor, 33);

function section(title: string): void {
  console.log(`\n${bold(title)}`);
  console.log(dim('─'.repeat(66)));
}

// ==========================================
// doctor
// ==========================================

async function doctor(args: CliArgs): Promise<void> {
  const env = process.env;
  section('s1sdk doctor');

  const loaded = loadDotEnv(REPO_ROOT, env);
  console.log(
    `env files: ${loaded.length > 0 ? loaded.map((f) => path.relative(REPO_ROOT, f)).join(', ') : dim('none found (shell exports only)')}`
  );

  const rows: Array<[string, string, string]> = [];
  const mark = (ok: boolean) => (ok ? green('✓') : dim('·'));

  rows.push([
    mark(Boolean(env.TYPESAFE_API_KEY)),
    'TYPESAFE_API_KEY',
    maskSecret(env.TYPESAFE_API_KEY)
  ]);
  rows.push([
    mark(Boolean(env.OPENROUTER_API_KEY)),
    'OPENROUTER_API_KEY',
    maskSecret(env.OPENROUTER_API_KEY)
  ]);

  const cfToken = Boolean(env.CLOUDFLARE_API_TOKEN);
  const cfAccount = Boolean(env.CLOUDFLARE_ACCOUNT_ID);
  rows.push([
    mark(cfToken && cfAccount),
    'CLOUDFLARE_API_TOKEN + ACCOUNT_ID',
    cfToken && cfAccount
      ? `${maskSecret(env.CLOUDFLARE_API_TOKEN)} / ${maskSecret(env.CLOUDFLARE_ACCOUNT_ID)}`
      : dim(`token=${cfToken ? 'set' : 'missing'} account=${cfAccount ? 'set' : 'missing'}`)
  ]);

  const ollamaBase = env.OLLAMA_HOST ? toBaseUrl(env.OLLAMA_HOST) : 'http://127.0.0.1:11434';
  const homesteadBase = toBaseUrl(
    env.HOMESTEAD_API_URL || env.HOMESTEAD_S1_URL || env.HOMESTEAD_ENDPOINT || 'http://127.0.0.1:8080'
  );
  const [ollamaUp, homesteadUp] = args.offline
    ? [false, false]
    : await Promise.all([probeEndpoint(ollamaBase), probeEndpoint(homesteadBase)]);

  rows.push([
    mark(ollamaUp),
    'OLLAMA_HOST',
    `${ollamaBase} ${ollamaUp ? green('up') : dim(env.OLLAMA_HOST ? 'down' : 'not configured')}`
  ]);
  rows.push([
    mark(homesteadUp),
    'HOMESTEAD_API_URL',
    `${homesteadBase} ${homesteadUp ? green('up') : dim('down')}`
  ]);

  const width = Math.max(...rows.map(([, name]) => name.length));
  for (const [flag, name, detail] of rows) {
    console.log(`  ${flag} ${name.padEnd(width)}  ${detail}`);
  }

  section('resolution');
  try {
    const resolved = await resolveProvider({
      prefer: args.provider,
      requested: args.provider,
      probe: !args.offline
    });
    console.log(`  winner: ${desc(resolved)}`);
    for (const note of resolved.notes) console.log(`  ${yellow('note')}: ${note}`);
    console.log(`\n  next: ${bold('bun run devx smoke')}`);
  } catch (err) {
    if (err instanceof DevxConfigError) {
      console.log(`  ${yellow('no provider')}: ${err.message}`);
      for (const hint of err.hints) console.log(`    -> ${hint}`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }
}

function desc(resolved: ResolvedProvider): string {
  return `${bold(resolved.provider)} ${dim('|')} ${describeResolution(resolved)}`;
}

// ==========================================
// smoke
// ==========================================

async function smoke(args: CliArgs): Promise<void> {
  const resolved = await resolveProvider({
    prefer: args.provider,
    requested: args.provider,
    probe: !args.offline
  });
  const options = args.model
    ? { ...resolved.options, model: args.model }
    : resolved.options;
  const client = new S1Client(options);
  const ticket = sampleTickets[args.ticket];
  if (!ticket) {
    throw new Error(
      `Unknown ticket "${args.ticket}". Available: ${Object.keys(sampleTickets).join(', ')}`
    );
  }

  if (!args.quiet) {
    section('s1sdk smoke');
    console.log(`  ${desc(resolved)}`);
    for (const note of resolved.notes) console.log(`  ${yellow('note')}: ${note}`);
  }

  const started = performance.now();
  const decision = await client.decide({ state: ticket, questions: customerServiceQuestions });
  const wallMs = Math.round(performance.now() - started);

  const answers = decision.answers;
  console.log(
    `\n  ${green('ok')} ${answers.target_department.choice} ` +
      `(${(answers.target_department.confidence * 100).toFixed(1)}% confidence) · ` +
      `escalation ${(answers.is_escalation_risk.noul * 100).toFixed(1)}% · ` +
      `priority ${answers.priority_level.score}`
  );
  console.log(
    `  provider=${decision.providerUsed} model=${decision.modelUsed}` +
      `${decision.transport ? ` transport=${decision.transport}` : ''} ` +
      `reported=${decision.latencyMs}ms wall=${wallMs}ms` +
      `${decision.isFallback ? ' (fallback)' : ''}`
  );
  if (decision.usage) {
    console.log(
      dim(`  tokens in=${decision.usage.inputTokens} out=${decision.usage.outputTokens} (out=0 means no generation)`)
    );
  }
}

// ==========================================
// examples
// ==========================================

function resolveExampleFile(target: string): string {
  const files = fs
    .readdirSync(EXAMPLES_DIR)
    .filter((file) => file.endsWith('.ts'))
    .sort();

  const direct = path.join(EXAMPLES_DIR, target);
  if (target.endsWith('.ts') && fs.existsSync(direct)) return direct;

  if (/^\d+$/.test(target)) {
    const prefix = target.padStart(2, '0');
    const byNumber = files.find((file) => file.slice(0, file.indexOf('-')) === prefix);
    if (byNumber) return path.join(EXAMPLES_DIR, byNumber);
  }

  const byName = files.find((file) => file.startsWith(target));
  if (byName) return path.join(EXAMPLES_DIR, byName);

  throw new Error(
    `Unknown example "${target}". Try: ${EXAMPLES.map((e) => e.id).join(', ')} (see \`bun run devx list\`)`
  );
}

function runExampleFile(file: string, args: CliArgs, resolved?: ResolvedProvider): number {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (resolved) env.S1_PROVIDER = resolved.provider;
  if (args.model) env.S1_MODEL = args.model;
  if (args.offline) env.S1_SKIP_PROBE = '1';

  console.log(`\n${bold(`▶ ${path.relative(REPO_ROOT, file)}`)}`);
  const result = spawnSync(process.execPath, [...process.execArgv, file, ...args.passthrough], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env
  });
  return result.status ?? 1;
}

async function runOneExample(args: CliArgs): Promise<void> {
  if (!args.target) {
    listExamples();
    return;
  }
  const file = resolveExampleFile(args.target);
  // Resolve once here so a bad provider is reported before the child process
  // prints a stack trace of its own.
  const resolved = await resolveProvider({
    prefer: args.provider,
    requested: args.provider,
    probe: !args.offline
  });
  console.log(`provider: ${describeResolution(resolved)}`);
  process.exitCode = runExampleFile(file, args, resolved);
}

async function runAllExamples(args: CliArgs): Promise<void> {
  const resolved = await resolveProvider({
    prefer: args.provider,
    requested: args.provider,
    probe: !args.offline
  });
  section(`running examples against ${resolved.provider}`);
  console.log(`  ${describeResolution(resolved)}`);

  const failures: string[] = [];
  for (const example of EXAMPLES) {
    if (SKIP_IN_RUN_ALL.has(example.id)) continue;
    const file = path.join(EXAMPLES_DIR, example.file);
    if (!fs.existsSync(file)) continue;
    const status = runExampleFile(file, args, resolved);
    if (status !== 0) failures.push(example.file);
  }

  section('summary');
  if (failures.length === 0) {
    console.log(`  ${green('all examples passed')}`);
  } else {
    console.log(`  ${yellow(`${failures.length} example(s) failed`)}: ${failures.join(', ')}`);
    process.exitCode = 1;
  }
}

function listExamples(): void {
  section('examples');
  const width = Math.max(...EXAMPLES.map((e) => e.file.length));
  for (const example of EXAMPLES) {
    console.log(
      `  ${example.id.padEnd(2)} ${example.file.padEnd(width)}  ${dim(example.needs.padEnd(30))} ${example.title}`
    );
  }
  console.log(`\n  run one: ${bold('bun run devx example 0')}`);
}

// ==========================================
// main
// ==========================================

function usage(): void {
  console.log(`s1sdk devx

  bun run devx                  doctor + smoke (default)
  bun run devx doctor           inspect credentials and daemons
  bun run devx smoke            one real decision
  bun run devx list             list runnable examples
  bun run devx example <id>     run one example
  bun run devx examples         run all provider-agnostic examples

  --provider, -p <id>   typesafe | openrouter | cloudflare | ollama | homestead
  --model, -m <id>      override the provider default model
  --ticket, -t <key>    ticket fixture for smoke (default: doubleBillingAngry)
  --offline             skip local daemon probes
  --quiet, -q           minimal output

environments: TYPESAFE_API_KEY, OPENROUTER_API_KEY,
  CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID,
  OLLAMA_HOST, HOMESTEAD_API_URL, S1_PROVIDER, S1_MODEL, S1_TIMEOUT_MS`);
}

async function main(): Promise<void> {
  const args = parseCli(process.argv.slice(2));
  switch (args.command) {
    case 'doctor':
      await doctor(args);
      return;
    case 'smoke':
      await smoke(args);
      return;
    case 'list':
      listExamples();
      return;
    case 'example':
      await runOneExample(args);
      return;
    case 'examples':
      await runAllExamples(args);
      return;
    case 'all':
      await doctor(args);
      await smoke(args);
      return;
    case 'help':
    case '--help':
    case '-h':
      usage();
      return;
    default:
      usage();
      process.exitCode = 2;
  }
}

main().catch((err) => {
  if (err instanceof DevxConfigError) {
    console.error(`\n[devx] ${err.message}`);
    for (const hint of err.hints) console.error(`  -> ${hint}`);
    process.exit(2);
  }
  console.error(`[devx] ${err instanceof Error ? err.message : String(err)}`);
  if (process.env.S1SDK_DEBUG === '1' && err instanceof Error) console.error(err.stack);
  process.exit(1);
});
