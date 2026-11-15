import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Packaged-artifact smoke test.
 *
 * Every other test imports `src/`. This one answers the question that actually
 * matters at publish time: does the tarball `npm publish` would upload install,
 * resolve through the `exports` map, typecheck for a consumer, and execute a
 * real decision under both `require()` and `import()`?
 *
 * The tarball is built into a temp directory; nothing is written to the repo.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

let tmpDir: string;
let unpackedRoot: string;
let tarballPath: string;
let packedFiles: string[];

function run(cmd: string, args: string[], cwd: string, timeout = 120_000): string {
  // Strip inherited npm configuration. `npm publish --dry-run` (prepublishOnly)
  // exports npm_config_dry_run=true, which would make the nested
  // `npm pack`/`npm install` below no-ops and turn this test into a false pass.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase().startsWith('npm_config_')) delete env[key];
  }
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', timeout, env });
}

function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

beforeAll(() => {
  // Always rebuild: `dist/` is gitignored, and packing a stale local build
  // would make this test green for code that is not in the working tree.
  run('bun', ['run', 'build'], repoRoot);

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 's1sdk-pack-'));

  const packed = run('npm', ['pack', '--pack-destination', tmpDir, '--silent'], repoRoot).trim();
  const tarballName = packed.split(/\r?\n/).pop()!.trim();
  tarballPath = path.join(tmpDir, tarballName);
  expect(fs.existsSync(tarballPath), `npm pack produced ${tarballPath}`).toBe(true);

  const extractDir = path.join(tmpDir, 'extract');
  fs.mkdirSync(extractDir, { recursive: true });
  run('tar', ['-xzf', tarballPath, '-C', extractDir], tmpDir);
  unpackedRoot = path.join(extractDir, 'package');
  packedFiles = listFiles(unpackedRoot);

  // Install the tarball exactly as a consumer would, so bare specifiers and the
  // `exports` map resolve through node_modules rather than a relative path.
  run(
    'npm',
    ['install', tarballPath, '--no-audit', '--no-fund', '--ignore-scripts', '--silent'],
    tmpDir
  );
}, 240_000);

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('published tarball contents', () => {
  it('ships both module formats, declarations and the documented extras', () => {
    const required = [
      'package.json',
      'README.md',
      'LICENSE',
      'CHANGELOG.md',
      'RELEASE-CHECKLIST.md',
      'dist/index.js',
      'dist/index.cjs',
      'dist/index.d.ts',
      'dist/providers/index.js',
      'dist/providers/index.cjs',
      'dist/providers/index.d.ts',
      'dist/providers/cloudflare/index.js',
      'src/index.ts',
      'examples/00-quickstart.ts',
      'skills/s1sdk/SKILL.md'
    ];

    for (const file of required) {
      expect(packedFiles, `tarball is missing ${file}`).toContain(file);
    }
  });

  it('never ships tests, local secrets, runtime state or dependency trees', () => {
    const forbidden = [
      /^test\//,
      /^coverage\//,
      /^node_modules\//,
      /^\.env/,
      /^\.wrangler\//,
      /^examples\/.*\.env/
    ];

    expect(packedFiles.length).toBeGreaterThan(20);
    for (const file of packedFiles) {
      for (const pattern of forbidden) {
        expect(file, `${file} must not be published`).not.toMatch(pattern);
      }
    }
  });

  it('declares the same version as the repository and keeps the runtime dependency surface empty', () => {
    const repoPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const packedPkg = JSON.parse(fs.readFileSync(path.join(unpackedRoot, 'package.json'), 'utf8'));

    expect(packedPkg.version).toBe(repoPkg.version);
    expect(packedPkg.name).toBe('s1sdk');
    expect(packedPkg.dependencies ?? {}).toEqual({});
    expect(packedPkg.engines).toEqual({ node: '>=18.0.0' });
  });

  it('resolves every path advertised by the exports map', () => {
    const packedPkg = JSON.parse(fs.readFileSync(path.join(unpackedRoot, 'package.json'), 'utf8'));

    for (const [subpath, entry] of Object.entries(packedPkg.exports)) {
      if (subpath === './package.json') continue;
      const targets = entry as Record<string, string>;
      for (const [condition, rel] of Object.entries(targets)) {
        expect(
          fs.existsSync(path.join(unpackedRoot, rel)),
          `exports[${subpath}].${condition} -> ${rel} is missing`
        ).toBe(true);
      }
    }
  });
});

describe('consumer resolution of the installed tarball', () => {
  it('loads under CommonJS, ESM and the providers subpath', () => {
    const script = path.join(tmpDir, 'resolve.cjs');
    fs.writeFileSync(
      script,
      `
const assert = require('node:assert/strict');
const cjs = require('s1sdk');
assert.equal(typeof cjs.S1Client, 'function');
assert.equal(typeof cjs.choice, 'function');
assert.equal(typeof cjs.S1Judge, 'function');
assert.equal(typeof cjs.CloudflareProvider, 'function');

(async () => {
  const esm = await import('s1sdk');
  assert.equal(typeof esm.S1Client, 'function');
  assert.equal(typeof esm.choice, 'function');
  assert.equal(typeof esm.S1Judge, 'function');

  const providers = await import('s1sdk/providers');
  assert.equal(typeof providers.CloudflareProvider, 'function');
  assert.equal(typeof providers.OpenRouterProvider, 'function');

  const pkg = require('s1sdk/package.json');
  assert.equal(pkg.name, 's1sdk');
  console.log('resolve-ok');
})().catch((err) => { console.error(err); process.exit(1); });
`
    );

    const output = run(process.env.S1_QA_NODE ?? 'node', [script], tmpDir);
    expect(output).toContain('resolve-ok');
  });

  it('executes a real System-1 decision through the published bundle in both module systems', () => {
    const script = path.join(tmpDir, 'decision.cjs');
    fs.writeFileSync(
      script,
      `
const assert = require('node:assert/strict');
const calls = [];
globalThis.fetch = async (url) => {
  calls.push(String(url));
  const body = {
    answers: { action: { type: 'choice', choice: 'read', confidence: 0.93 } },
    usage: { input_tokens: 12, output_tokens: 0 }
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
};

async function decide(mod, label) {
  const client = new mod.S1Client({
    provider: 'homestead',
    endpoint: 'http://127.0.0.1:18765/v1/systemone'
  });
  const res = await client.decide({
    state: 'read the release notes',
    questions: { action: mod.choice('Action', { read: 'read', write: 'write' }) }
  });
  assert.equal(res.answers.action.choice, 'read', label + ': answer');
  assert.equal(res.providerUsed, 'homestead', label + ': provider');
  assert.deepEqual(res.usage, {
    inputTokens: 12,
    outputTokens: 0,
    input_tokens: 12,
    output_tokens: 0
  }, label + ': usage');
}

(async () => {
  await decide(require('s1sdk'), 'cjs');
  await decide(await import('s1sdk'), 'esm');
  assert.equal(calls.length, 2);
  console.log('decision-ok');
})().catch((err) => { console.error(err); process.exit(1); });
`
    );

    const output = run(process.env.S1_QA_NODE ?? 'node', [script], tmpDir);
    expect(output).toContain('decision-ok');
  });

  it('typechecks for a TypeScript consumer using the shipped declarations', () => {
    const tsc = path.join(repoRoot, 'node_modules', '.bin', 'tsc');
    expect(fs.existsSync(tsc), 'typescript must be installed to verify declarations').toBe(true);

    fs.writeFileSync(
      path.join(tmpDir, 'consumer.ts'),
      `
import { S1Client, S1Judge, choice, type JevDecisionResponse } from 's1sdk';
import { CloudflareProvider, OpenRouterProvider } from 's1sdk/providers';

const client = new S1Client({
  provider: 'openrouter',
  apiKey: 'sk-test',
  model: 'typesafe/jev-1.13'
});

const action = choice('Pick an action', { read: 'read', write: 'write' });

async function decide(): Promise<string> {
  const res: JevDecisionResponse<{ action: typeof action }> = await client.decide({
    state: { id: 1 },
    questions: { action }
  });
  return res.answers.action.choice;
}

const verdict = new S1Judge().arbitrate(
  { prompt: 'read the notes', candidateChoices: ['read_file'] },
  { modelId: 'nanojev', choice: 'read_file', confidence: 0.9 },
  { modelId: 'mini-jev', choice: 'read_file', confidence: 0.8 }
);

void decide;
void verdict;
void CloudflareProvider;
void OpenRouterProvider;
`
    );

    const output = run(
      tsc,
      [
        '--noEmit',
        '--strict',
        '--target',
        'ES2022',
        '--module',
        'nodenext',
        '--moduleResolution',
        'nodenext',
        '--lib',
        'ES2022,DOM',
        'consumer.ts'
      ],
      tmpDir
    );
    expect(output.trim()).toBe('');
  }, 120_000);
});
