/**
 * PR gate decision schema, scoring and receipt rendering.
 *
 * Feature 1 (risk score), 2 (change classification), 5 (receipt + CI wiring)
 * and 6 (policy checks via deterministic pre-filter + `noul`).
 *
 * Exactly one model inference happens per PR: the `decide()` call that answers
 * these questions. Everything after it is deterministic serialization.
 */

import {
  choice,
  noul,
  score,
  type JevDecisionRequest,
  type JevDecisionResponse,
  type JevQuestion
} from '../../src/index.js';
import {
  prefilterPolicies,
  type PolicyId,
  type PolicySignal,
  type PrState
} from './pr-state.js';

/** Question ids, kept in one place so receipt and stub agree. */
export const PR_GATE_QUESTIONS = {
  change_type: 'change_type',
  risk_level: 'risk_level',
  touches_secrets: 'touches_secrets',
  requires_migration_review: 'requires_migration_review',
  affects_protected_infra: 'affects_protected_infra'
} as const;

export const PR_GATE_QUESTION_DEFS = {
  change_type: choice(
    'Classify the primary intent of this pull request from the title, commits, paths, and diff shape',
    {
      bugfix: 'Fixes a defect or regression without changing the intended API',
      feature: 'Adds new user-visible behavior, API surface, or capability',
      refactor: 'Restructures code without changing intended behavior',
      docs: 'Documentation, comments, or examples only',
      test: 'Tests, fixtures, or test tooling only',
      chore: 'Build, dependency, formatting, or maintenance work',
      revert: 'Reverts a previous change',
      breaking_change: 'Intentionally changes or removes existing public behavior or API'
    } as const
  ),
  risk_level: score(
    'Assess merge risk from 1 (trivial) to 5 (critical), considering blast radius, review surface, and reversibility',
    [
      'Level 1: docs/typo/formatting, reversible, no runtime impact',
      'Level 2: small localized change with tests',
      'Level 3: normal feature or fix touching shared code',
      'Level 4: large change, core module, or missing tests in a risky area',
      'Level 5: protected infra, secrets, migrations, breaking API, or unreviewable size'
    ]
  ),
  touches_secrets: noul(
    'Determine whether the added lines introduce credentials, API keys, private keys, or other secret material that must not be committed'
  ),
  requires_migration_review: noul(
    'Determine whether this change requires a database migration review, backfill plan, or rollback strategy'
  ),
  affects_protected_infra: noul(
    'Determine whether this change alters protected infrastructure, CI, provider transports, or packaging in a way that needs a maintainer review'
  )
} as const;

const POLICY_QUESTION_KEYS: Record<PolicyId, string> = {
  secrets: 'touches_secrets',
  migration_review: 'requires_migration_review',
  protected_infra: 'affects_protected_infra'
};

export type PrGateVerdict = 'pass' | 'review' | 'hold';

export interface PrGatePolicyResult {
  id: PolicyId;
  title: string;
  deterministic: boolean;
  evidence: string[];
  modelProbability: number;
  /** `deterministic && p >= 0.5`, or a high model probability on its own. */
  triggered: boolean;
}

export interface PrGateReceipt {
  schema: 's1sdk.pr-gate/v1';
  generatedAt: string;
  pr: {
    title: string;
    base: string;
    head: string;
    author?: string;
    labels: string[];
    filesChanged: number;
    additions: number;
    deletions: number;
    commits: string[];
    filesTruncated: boolean;
  };
  decision: {
    verdict: PrGateVerdict;
    changeType: {
      value: string;
      confidence: number;
      probabilities: Record<string, number>;
    };
    risk: {
      score: number;
      confidence: number;
    };
    policies: PrGatePolicyResult[];
  };
  telemetry: {
    provider: string;
    model: string;
    transport?: string;
    latencyMs: number;
    isFallback: boolean;
    inputTokens?: number;
    outputTokens?: number;
  };
}

function asRecord(value: unknown): Record<string, any> {
  return value !== null && typeof value === 'object' ? (value as Record<string, any>) : {};
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round(value: number, digits = 3): number {
  return Number(value.toFixed(digits));
}

/**
 * Feature 5: turn the model response plus deterministic state into a stable
 * receipt. No inference happens here.
 */
export function interpretPrGate(
  state: PrState,
  decision: JevDecisionResponse<Record<string, JevQuestion>>
): PrGateReceipt {
  const answers = asRecord(decision.answers);
  const changeAnswer = asRecord(answers[PR_GATE_QUESTIONS.change_type]);
  const riskAnswer = asRecord(answers[PR_GATE_QUESTIONS.risk_level]);

  const changeValue = typeof changeAnswer.choice === 'string' ? changeAnswer.choice : 'unknown';
  const changeConfidence = typeof changeAnswer.confidence === 'number' ? changeAnswer.confidence : 0;
  const changeProbabilities =
    changeAnswer.probabilities && typeof changeAnswer.probabilities === 'object'
      ? (changeAnswer.probabilities as Record<string, number>)
      : {};

  const riskScore = typeof riskAnswer.score === 'number' ? riskAnswer.score : 3;
  const riskConfidence = typeof riskAnswer.confidence === 'number' ? riskAnswer.confidence : 0;

  const policies = prefilterPolicies(state).map((signal) => {
    const answer = asRecord(answers[POLICY_QUESTION_KEYS[signal.id]]);
    const modelProbability = clamp01(
      typeof answer.noul === 'number' ? answer.noul : 0
    );
    return {
      id: signal.id,
      title: signal.title,
      deterministic: signal.deterministic,
      evidence: [...signal.evidence],
      modelProbability,
      triggered: (signal.deterministic && modelProbability >= 0.5) || modelProbability >= 0.8
    };
  });

  // A secret is the only policy that holds on its own at moderate confidence.
  // Protected infra and migrations ask for review; a very high model
  // probability on any policy is enough to hold.
  const hardPolicy =
    policies.some(
      (policy) =>
        policy.id === 'secrets' && policy.deterministic && policy.modelProbability >= 0.5
    ) || policies.some((policy) => policy.modelProbability >= 0.9);
  const softPolicy = policies.some(
    (policy) => policy.deterministic || policy.modelProbability >= 0.8
  );

  // Advisory by construction: a high score or a confirmed policy hit asks for a
  // human, it does not claim to have reviewed the code.
  const verdict: PrGateVerdict =
    riskScore >= 5 || hardPolicy ? 'hold' : riskScore >= 3 || softPolicy ? 'review' : 'pass';

  return {
    schema: 's1sdk.pr-gate/v1',
    generatedAt: new Date().toISOString(),
    pr: {
      title: state.meta.title,
      base: state.meta.base,
      head: state.meta.head,
      ...(state.meta.author ? { author: state.meta.author } : {}),
      labels: [...state.meta.labels],
      filesChanged: state.signals.filesChanged,
      additions: state.signals.additions,
      deletions: state.signals.deletions,
      commits: [...state.commits],
      filesTruncated: state.filesTruncated
    },
    decision: {
      verdict,
      changeType: {
        value: changeValue,
        confidence: round(changeConfidence),
        probabilities: Object.fromEntries(
          Object.entries(changeProbabilities).map(([key, value]) => [key, round(Number(value))])
        )
      },
      risk: { score: riskScore, confidence: round(riskConfidence) },
      policies
    },
    telemetry: {
      provider: decision.providerUsed,
      model: decision.modelUsed,
      ...(decision.transport ? { transport: decision.transport } : {}),
      latencyMs: decision.latencyMs,
      isFallback: decision.isFallback,
      ...(decision.usage
        ? {
            inputTokens: decision.usage.inputTokens,
            outputTokens: decision.usage.outputTokens
          }
        : {})
    }
  };
}

function bar(value: number, width = 18): string {
  const filled = Math.round(clamp01(value) * width);
  return '#'.repeat(filled).padEnd(width, '.');
}

/** Human-readable console receipt. */
export function renderPrGateReceipt(receipt: PrGateReceipt): string {
  const lines: string[] = [];
  const rule = '='.repeat(72);
  lines.push(rule);
  lines.push(` S1 PR GATE  |  verdict: ${receipt.decision.verdict.toUpperCase()}`);
  lines.push(rule);
  lines.push(` PR:       ${receipt.pr.title || '(untitled)'}`);
  lines.push(
    ` Range:    ${receipt.pr.base}..${receipt.pr.head}  (${receipt.pr.filesChanged} files, +${receipt.pr.additions}/-${receipt.pr.deletions})`
  );
  if (receipt.pr.labels.length > 0) lines.push(` Labels:   ${receipt.pr.labels.join(', ')}`);
  lines.push('-'.repeat(72));
  lines.push(
    ` Change:   ${receipt.decision.changeType.value} (${(receipt.decision.changeType.confidence * 100).toFixed(1)}% confidence)`
  );
  for (const [key, value] of Object.entries(receipt.decision.changeType.probabilities)) {
    lines.push(`   ${key.padEnd(16)} ${bar(value)} ${(value * 100).toFixed(0).padStart(3)}%`);
  }
  lines.push(
    ` Risk:     ${receipt.decision.risk.score}/5 (${(receipt.decision.risk.confidence * 100).toFixed(1)}% confidence)`
  );
  lines.push('-'.repeat(72));
  lines.push(' Policies (deterministic pre-filter + model probability):');
  for (const policy of receipt.decision.policies) {
    const marker = policy.triggered ? 'TRIGGERED' : policy.deterministic ? 'advisory ' : 'clear    ';
    lines.push(
      `   [${marker}] ${policy.id.padEnd(18)} p=${policy.modelProbability.toFixed(2)}` +
        `${policy.deterministic ? ` det=hit` : ' det=no '}`
    );
    for (const evidence of policy.evidence.slice(0, 3)) {
      lines.push(`               - ${evidence}`);
    }
    if (policy.evidence.length > 3) {
      lines.push(`               - ... ${policy.evidence.length - 3} more`);
    }
  }
  lines.push('-'.repeat(72));
  const { telemetry } = receipt;
  lines.push(
    ` Provider: ${telemetry.provider} / ${telemetry.model}` +
      `${telemetry.transport ? ` (${telemetry.transport})` : ''}  ${telemetry.latencyMs}ms` +
      `${telemetry.isFallback ? '  [fallback]' : ''}`
  );
  if (telemetry.inputTokens !== undefined) {
    const outputTokens = telemetry.outputTokens ?? 0;
    lines.push(
      ` Tokens:   in=${telemetry.inputTokens} out=${outputTokens}` +
        (outputTokens === 0 ? ' (out=0 means no generation)' : '')
    );
  }
  lines.push(rule);
  return lines.join('\n');
}

/** GitHub Step Summary markdown. */
export function renderPrGateSummary(receipt: PrGateReceipt): string {
  const lines: string[] = [];
  lines.push(`## S1 PR gate: \`${receipt.decision.verdict}\``);
  lines.push('');
  lines.push(`**${receipt.pr.title || '(untitled)'}**`);
  lines.push('');
  lines.push('| Signal | Value |');
  lines.push('| :-- | :-- |');
  lines.push(
    `| Range | \`${receipt.pr.base}..${receipt.pr.head}\` |`
  );
  lines.push(
    `| Diff | ${receipt.pr.filesChanged} files, +${receipt.pr.additions}/-${receipt.pr.deletions}${receipt.pr.filesTruncated ? ' (truncated for model)' : ''} |`
  );
  lines.push(
    `| Change type | \`${receipt.decision.changeType.value}\` (${(receipt.decision.changeType.confidence * 100).toFixed(1)}%) |`
  );
  lines.push(
    `| Risk | ${receipt.decision.risk.score}/5 (${(receipt.decision.risk.confidence * 100).toFixed(1)}%) |`
  );
  lines.push('');
  lines.push('### Policies');
  lines.push('');
  lines.push('| Policy | Deterministic | Model p | Result |');
  lines.push('| :-- | :--: | --: | :-- |');
  for (const policy of receipt.decision.policies) {
    lines.push(
      `| ${policy.id} | ${policy.deterministic ? 'hit' : '-'} | ${policy.modelProbability.toFixed(2)} | ${policy.triggered ? '**triggered**' : 'clear'} |`
    );
  }
  const evidence = receipt.decision.policies.flatMap((policy) =>
    policy.evidence.map((item) => `- \`${policy.id}\`: ${item}`)
  );
  if (evidence.length > 0) {
    lines.push('');
    lines.push('### Evidence');
    lines.push('');
    lines.push(...evidence);
  }
  lines.push('');
  lines.push(
    `<sub>${receipt.telemetry.provider}/${receipt.telemetry.model} · ${receipt.telemetry.latencyMs}ms · advisory only — a human decides.</sub>`
  );
  return lines.join('\n');
}

function estimateRisk(modelState: Record<string, any>): number {
  const diff = asRecord(modelState.diff);
  const signals = asRecord(modelState.signals);
  const churn = Number(diff.additions ?? 0) + Number(diff.deletions ?? 0);
  const files = Number(diff.filesChanged ?? 0);
  let risk = 1;
  if (churn > 800) risk += 2;
  else if (churn > 300) risk += 1;
  if (files > 25) risk += 1;
  if (Array.isArray(signals.protectedPaths) && signals.protectedPaths.length > 0) risk += 1;
  if (Array.isArray(signals.migrations) && signals.migrations.length > 0) risk += 1;
  if (Array.isArray(signals.secretRuleHits) && signals.secretRuleHits.length > 0) risk += 2;
  const tests = Array.isArray(signals.testFiles) ? signals.testFiles.length : 0;
  if (tests === 0 && churn > 40) risk += 1;
  return Math.max(1, Math.min(5, risk));
}

function estimateChangeType(modelState: Record<string, any>): string {
  const text = `${modelState.title ?? ''} ${(modelState.commits ?? []).join(' ')}`.toLowerCase();
  const files = Array.isArray(modelState.diff?.files) ? modelState.diff.files : [];
  const paths = files.map((file: any) => String(file.path ?? ''));
  const onlyDocs =
    paths.length > 0 && paths.every((path) => /\.(md|mdx|txt)$/i.test(path) || /docs?\//i.test(path));
  if (onlyDocs) return 'docs';
  if (/\brevert\b/.test(text)) return 'revert';
  if (/\b(fix|bug|regression|hotfix)\b/.test(text)) return 'bugfix';
  if (/\b(feat|feature|add|adds|implement|support)\b/.test(text)) return 'feature';
  if (/\brefactor|cleanup|restructure\b/.test(text)) return 'refactor';
  if (/\btest(s|ing)?\b/.test(text)) return 'test';
  return 'chore';
}

/**
 * Deterministic stand-in for the model, used by `--stub` and by tests. It reads
 * the same compact state the real model sees, so the reducer, policy merge,
 * receipt and CI wiring are all exercised without credentials.
 */
export function buildStubDecision<TQuestions extends Record<string, JevQuestion>>(
  request: JevDecisionRequest<unknown, TQuestions>
): JevDecisionResponse<TQuestions> {
  const modelState = asRecord(request.state);
  const risk = estimateRisk(modelState);
  const changeType = estimateChangeType(modelState);
  const signals = asRecord(modelState.signals);
  const secretHits = Array.isArray(signals.secretRuleHits) ? signals.secretRuleHits.length : 0;
  const migrations = Array.isArray(signals.migrations) ? signals.migrations.length : 0;
  const protectedPaths = Array.isArray(signals.protectedPaths) ? signals.protectedPaths.length : 0;

  const noulProbabilities: Record<string, number> = {
    touches_secrets: secretHits > 0 ? 0.92 : 0.03,
    requires_migration_review: migrations > 0 ? 0.88 : 0.04,
    affects_protected_infra: protectedPaths > 0 ? 0.71 : 0.05
  };

  const answers: Record<string, any> = {};
  for (const [id, question] of Object.entries(request.questions ?? {})) {
    if (question.type === 'noul') {
      answers[id] = { noul: noulProbabilities[id] ?? 0.1 };
      continue;
    }
    if (question.type === 'score') {
      answers[id] = {
        score: risk,
        confidence: 0.78,
        probabilities: Object.fromEntries(
          [1, 2, 3, 4, 5].map((level) => [level, level === risk ? 0.78 : 0.055])
        )
      };
      continue;
    }
    const keys = Object.keys((question as any).criteria ?? {});
    const chosen = keys.includes(changeType) ? changeType : keys[0] ?? 'unknown';
    answers[id] = {
      choice: chosen,
      confidence: 0.81,
      probabilities: Object.fromEntries(
        keys.map((key) => [key, key === chosen ? 0.81 : round(0.19 / Math.max(1, keys.length - 1))])
      )
    };
  }

  return {
    answers: answers as JevDecisionResponse<TQuestions>['answers'],
    latencyMs: 2,
    latency_ms: 2,
    providerUsed: 'stub',
    provider: 'stub',
    modelUsed: 'stub-pr-gate',
    transport: 'none',
    isFallback: false,
    usage: { inputTokens: 0, outputTokens: 0 },
    timestamp: Date.now()
  };
}
