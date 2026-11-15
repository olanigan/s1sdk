import { describe, it, expect } from 'vitest';
import {
  reducePrState,
  toModelState,
  prefilterPolicies,
  type PrMetadata
} from '../examples/shared/pr-state.js';
import {
  PR_GATE_QUESTION_DEFS,
  buildStubDecision,
  interpretPrGate,
  renderPrGateSummary
} from '../examples/shared/pr-gate-schema.js';

const META: PrMetadata = {
  title: 'feat: add retry policy',
  base: 'origin/main',
  head: 'HEAD',
  labels: ['backend'],
  author: 'dev'
};

const RISKY_DIFF = [
  'diff --git a/src/http.ts b/src/http.ts',
  'index 1111111..2222222 100644',
  '--- a/src/http.ts',
  '+++ b/src/http.ts',
  '@@ -1,3 +1,4 @@',
  ' line1',
  '-old',
  '+new',
  '+extra',
  ' line3',
  'diff --git a/test/pr-gate.test.ts b/test/pr-gate.test.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/test/pr-gate.test.ts',
  '@@ -0,0 +1,2 @@',
  "+import { it } from 'vitest';",
  "+it('works', () => {});",
  'diff --git a/package.json b/package.json',
  'index 3333333..4444444 100644',
  '--- a/package.json',
  '+++ b/package.json',
  '@@ -1,2 +1,2 @@',
  '-  "old": "1.0.0",',
  '+  "left-pad": "^1.3.0",',
  'diff --git a/.env b/.env',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/.env',
  '@@ -0,0 +1,2 @@',
  '+API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456',
  '+SAFE=1',
  ''
].join('\n');

const DOCS_DIFF = [
  'diff --git a/docs/guide.md b/docs/guide.md',
  'index 5555555..6666666 100644',
  '--- a/docs/guide.md',
  '+++ b/docs/guide.md',
  '@@ -1,1 +1,2 @@',
  ' # Guide',
  '+More words.',
  ''
].join('\n');

describe('pr-gate state reducer', () => {
  it('parses per-file stats, tests, lockfiles, protected paths and migrations', () => {
    const state = reducePrState(RISKY_DIFF, META, { commits: ['feat: add retry'] });

    expect(state.signals.filesChanged).toBe(4);
    expect(state.signals.additions).toBe(7);
    expect(state.signals.deletions).toBe(2);
    expect(state.signals.testFiles).toEqual(['test/pr-gate.test.ts']);
    expect(state.signals.protectedPaths).toEqual([
      '.env',
      'package.json',
      'src/http.ts'
    ]);
    expect(state.signals.migrations).toEqual([]);
    expect(state.signals.dependencyAdditions).toEqual(['left-pad']);
    expect(state.filesTruncated).toBe(false);
  });

  it('records secret rule hits by location without storing the secret', () => {
    const state = reducePrState(RISKY_DIFF, META);
    const rules = state.signals.secretHits.map((hit) => hit.rule);

    expect(state.signals.secretHits[0]?.file).toBe('.env');
    expect(rules).toContain('openai-key');
    expect(rules).toContain('generic-secret-assignment');
    expect(JSON.stringify(state.signals)).not.toContain('sk-abcdefghijklmnop');
  });

  it('sends only bounded state to the model', () => {
    const state = reducePrState(RISKY_DIFF, META);
    const modelState = toModelState(state);
    const serialized = JSON.stringify(modelState);

    expect(serialized).not.toContain('+extra');
    expect(serialized).not.toContain('sk-abcdefghijklmnop');
    expect(modelState.signals.secretRuleHits).toHaveLength(
      state.signals.secretHits.length
    );
  });

  it('detects migrations', () => {
    const diff = [
      'diff --git a/db/migrate/001_add_user.sql b/db/migrate/001_add_user.sql',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/db/migrate/001_add_user.sql',
      '@@ -0,0 +1,1 @@',
      '+alter table users add column email text;',
      ''
    ].join('\n');

    const state = reducePrState(diff, META);
    expect(state.signals.migrations).toEqual(['db/migrate/001_add_user.sql']);
  });
});

describe('pr-gate policy pre-filter', () => {
  it('marks path/regex hits as deterministic evidence', () => {
    const state = reducePrState(RISKY_DIFF, META);
    const policies = prefilterPolicies(state);

    const secrets = policies.find((policy) => policy.id === 'secrets');
    const migration = policies.find((policy) => policy.id === 'migration_review');
    const infra = policies.find((policy) => policy.id === 'protected_infra');

    expect(secrets?.deterministic).toBe(true);
    expect(secrets?.evidence[0]).toContain('.env');
    expect(migration?.deterministic).toBe(false);
    expect(infra?.deterministic).toBe(true);
  });
});

describe('pr-gate interpretation', () => {
  it('holds when a deterministic secret hit is confirmed by the model', () => {
    const state = reducePrState(RISKY_DIFF, META, { commits: ['feat: add retry'] });
    const decision = buildStubDecision({
      state: toModelState(state),
      questions: PR_GATE_QUESTION_DEFS
    });
    const receipt = interpretPrGate(state, decision);

    expect(receipt.schema).toBe('s1sdk.pr-gate/v1');
    expect(receipt.decision.verdict).toBe('hold');
    expect(receipt.decision.changeType.value).toBe('feature');
    expect(receipt.decision.risk.score).toBeGreaterThanOrEqual(4);
    expect(receipt.decision.policies.find((p) => p.id === 'secrets')?.triggered).toBe(true);
    expect(receipt.telemetry.provider).toBe('stub');
  });

  it('passes a small docs-only change', () => {
    const state = reducePrState(DOCS_DIFF, { ...META, title: 'docs: expand guide' });
    const decision = buildStubDecision({
      state: toModelState(state),
      questions: PR_GATE_QUESTION_DEFS
    });
    const receipt = interpretPrGate(state, decision);

    expect(receipt.decision.changeType.value).toBe('docs');
    expect(receipt.decision.risk.score).toBe(1);
    expect(receipt.decision.verdict).toBe('pass');
  });

  it('renders a GitHub step summary with the verdict and policies', () => {
    const state = reducePrState(RISKY_DIFF, META);
    const decision = buildStubDecision({
      state: toModelState(state),
      questions: PR_GATE_QUESTION_DEFS
    });
    const receipt = interpretPrGate(state, decision);
    const summary = renderPrGateSummary(receipt);

    expect(summary).toContain('## S1 PR gate: `hold`');
    expect(summary).toContain('| secrets |');
    expect(summary).toContain('advisory only');
  });
});
