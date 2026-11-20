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
  renderPrGateSummary,
  type PrGateReceipt
} from '../examples/shared/pr-gate-schema.js';
import {
  buildOverride,
  calibrationReport,
  readOverrides,
  OVERRIDE_SCHEMA
} from '../examples/shared/pr-gate-calibration.js';
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Built at runtime so this test file does not itself contain a literal that
// the gate would flag when this PR is scanned. The gate sees source text, not
// the value this expression evaluates to.
const SECRET_VALUE = 'sk-' + 'proj-' + 'Qm9vR2xT7kL4pN8sW1zY6cB3';

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
  '+API_KEY=' + SECRET_VALUE,
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
    expect(JSON.stringify(state.signals)).not.toContain(SECRET_VALUE);
  });

  it('ignores obvious placeholder fixtures in examples and tests', () => {
    const diff = [
      'diff --git a/.env.example b/.env.example',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/.env.example',
      '@@ -0,0 +1,1 @@',
      '+API_KEY=sk-example-not-a-real-key',
      ''
    ].join('\n');

    const state = reducePrState(diff, META);
    expect(state.signals.secretHits).toEqual([]);
  });

  it('sends only bounded state to the model', () => {
    const state = reducePrState(RISKY_DIFF, META);
    const modelState = toModelState(state);
    const serialized = JSON.stringify(modelState);

    expect(serialized).not.toContain('+extra');
    expect(serialized).not.toContain(SECRET_VALUE);
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

describe('pr-gate placeholder scan (value-level)', () => {
  const diffWithLine = (line: string, path = 'src/config.ts') =>
    [
      `diff --git a/${path} b/${path}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${path}`,
      '@@ -0,0 +1,1 @@',
      `+${line}`,
      ''
    ].join('\n');

  it('still flags a real-looking key on a line that carries a marker comment', () => {
    const state = reducePrState(diffWithLine('export const k = "AKIAQ7XPL2MZ9RTVB4HW" // example'), META);
    expect(state.signals.secretHits.map((h) => h.rule)).toContain('aws-access-key');
  });

  it('does not flag a documented placeholder key value', () => {
    const state = reducePrState(diffWithLine('export const k = "AKIAIOSFODNN7EXAMPLE"'), META);
    expect(state.signals.secretHits).toEqual([]);
  });

  it('judges a generic assignment by its value, not by the variable name', () => {
    // Variable name carries a marker word; the value is real. Line-level skipping would miss it.
    const real = reducePrState(diffWithLine('example.token = "q7XPl2MZ9rTVb4HWk8Lm"'), META);
    expect(real.signals.secretHits.map((h) => h.rule)).toContain('generic-secret-assignment');

    const placeholder = reducePrState(diffWithLine('const api_key = "example-value-here-123"'), META);
    expect(placeholder.signals.secretHits).toEqual([]);
  });
});

describe('pr-gate calibration', () => {
  const docsState = () => reducePrState(DOCS_DIFF, { ...META, title: 'docs: expand guide' });

  function receiptWithRiskConfidence(confidence: number): PrGateReceipt {
    const state = docsState();
    const decision = buildStubDecision({
      state: toModelState(state),
      questions: PR_GATE_QUESTION_DEFS
    });
    const answers = { ...(decision.answers as Record<string, any>) };
    answers.risk_level = { ...answers.risk_level, confidence };
    return interpretPrGate(state, { ...decision, answers } as typeof decision);
  }

  it('keeps a confident pass as a pass', () => {
    const receipt = receiptWithRiskConfidence(0.78);
    expect(receipt.decision.verdict).toBe('pass');
    expect(receipt.decision.confidence.escalated).toBe(false);
    expect(receipt.decision.confidence.overall).toBeCloseTo(0.78);
  });

  it('escalates a would-be pass when confidence is below tau', () => {
    const receipt = receiptWithRiskConfidence(0.48);
    expect(receipt.decision.verdict).toBe('escalate');
    expect(receipt.decision.confidence.baseVerdict).toBe('pass');
    expect(receipt.decision.confidence.escalated).toBe(true);
    expect(receipt.decision.confidence.reasons[0]).toContain('risk confidence 0.48');
  });

  it('respects a custom tau', () => {
    const state = docsState();
    const decision = buildStubDecision({
      state: toModelState(state),
      questions: PR_GATE_QUESTION_DEFS
    });
    // Stub confidence is 0.78, so a tau of 0.8 escalates it.
    expect(interpretPrGate(state, decision, { tau: 0.8 }).decision.verdict).toBe('escalate');
    expect(interpretPrGate(state, decision, { tau: 0.5 }).decision.verdict).toBe('pass');
  });

  it('never softens a hold: a confirmed secret stays a hold at low confidence', () => {
    const state = reducePrState(RISKY_DIFF, META, { commits: ['feat: add retry'] });
    const decision = buildStubDecision({
      state: toModelState(state),
      questions: PR_GATE_QUESTION_DEFS
    });
    const answers = { ...(decision.answers as Record<string, any>) };
    answers.risk_level = { ...answers.risk_level, confidence: 0.2 };
    const receipt = interpretPrGate(state, { ...decision, answers } as typeof decision);
    expect(receipt.decision.verdict).toBe('hold');
    expect(receipt.decision.confidence.escalated).toBe(false);
  });

  it('records agreement and override, and reports per-verdict rates', () => {
    const receipt = receiptWithRiskConfidence(0.48);
    const dir = mkdtempSync(join(tmpdir(), 'pr-gate-cal-'));
    const log = join(dir, 'overrides.jsonl');

    const agree = buildOverride(receipt, 'escalate', { now: new Date('2026-11-20T00:00:00Z') });
    const override = buildOverride(receipt, 'pass', { reason: 'docs only' });
    expect(agree.agreed).toBe(true);
    expect(override.agreed).toBe(false);
    expect(override.schema).toBe(OVERRIDE_SCHEMA);

    writeFileSync(log, '');
    appendFileSync(log, JSON.stringify(agree) + '\n');
    appendFileSync(log, JSON.stringify(override) + '\n');
    appendFileSync(log, 'not json\n');

    const read = readOverrides(log);
    expect(read.records).toHaveLength(2);
    expect(read.malformed).toBe(1);

    const report = calibrationReport(read);
    expect(report.total).toBe(2);
    expect(report.overrideRate).toBeCloseTo(0.5);
    // Both records were made on the same escalated receipt.
    expect(report.byVerdict.escalate.count).toBe(2);
    expect(report.byVerdict.escalate.overrideRate).toBeCloseTo(0.5);
    expect(report.byVerdict.pass.count).toBe(0);
    expect(report.byVerdict.pass.overrideRate).toBeNull();
    expect(JSON.parse(readFileSync(log, 'utf8').split('\n')[0]!).schema).toBe(OVERRIDE_SCHEMA);
  });

  it('reports no rate for an empty log instead of 0%', () => {
    const report = calibrationReport({ records: [], malformed: 0 });
    expect(report.overrideRate).toBeNull();
  });

  it('applies the rolling window to the most recent records', () => {
    const receipt = receiptWithRiskConfidence(0.78);
    // Oldest first: an override that falls outside the window must not count.
    const records = [
      buildOverride(receipt, 'review'),
      buildOverride(receipt, 'pass'),
      buildOverride(receipt, 'pass')
    ];
    expect(calibrationReport({ records, malformed: 0 }).overrideRate).toBeCloseTo(1 / 3);
    const report = calibrationReport({ records, malformed: 0 }, { last: 2 });
    expect(report.total).toBe(2);
    expect(report.overrideRate).toBe(0);
  });
});
