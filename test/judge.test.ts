import { describe, it, expect } from 'vitest';
import {
  S1Judge,
  judge,
  type S1JudgeContext,
  type S1JudgeOptions
} from '../src/index.js';

/**
 * S1Judge arbitration matrix.
 *
 * The judge is a deterministic scorer, not a model call: every verdict below is
 * derived from documented inputs only (schema validity, destructive-in-read
 * traps, SLA pressure, calibrated confidence, token/latency preference). Each
 * test states the scoring arithmetic that produces the verdict so a future
 * weight change fails with an explanation rather than a bare assertion.
 */

const SAFE_READ: S1JudgeContext = {
  prompt: 'read the release notes for the customer',
  candidateChoices: ['read_file', 'delete_all', 'write_file']
};

const NEUTRAL_TICKET: S1JudgeContext = {
  prompt: 'classify the ticket category',
  candidateChoices: ['billing', 'technical']
};

function ctx(overrides: Partial<S1JudgeContext> = {}): S1JudgeContext {
  return { ...NEUTRAL_TICKET, ...overrides };
}

describe('S1Judge.createJevQuestion', () => {
  it('builds a four-way choice question carrying the prompt and candidate metadata', () => {
    const q = new S1Judge().createJevQuestion(
      NEUTRAL_TICKET,
      { modelId: 'nanojev', choice: 'billing', latencyMs: 7, tokensOut: 0 },
      { modelId: 'mini-jev', choice: 'technical' }
    );

    expect(q.type).toBe('choice');
    expect(Object.keys(q.criteria)).toEqual([
      'SELECT_A',
      'SELECT_B',
      'ESCALATE_FRONTIER',
      'REJECT_BOTH'
    ]);
    expect(q.instructions).toContain('classify the ticket category');
    expect(q.criteria.SELECT_A).toContain('nanojev');
    expect(q.criteria.SELECT_A).toContain("'billing'");
    // Latency/token annotation is emitted only for candidates that report it.
    expect(q.criteria.SELECT_A).toContain('[7ms, 0tok]');
    expect(q.criteria.SELECT_B).not.toContain('ms,');
    expect(q.criteria.SELECT_B).toContain("'technical'");
  });
});

describe('S1Judge verdict selection', () => {
  it('SELECT_A when the safe read beats a destructive proposal in a read context', () => {
    // A: 100 + 40 (safe tool) + 18.4 (conf) + 10 (zero tokens) + 5 (fast) = 173.4
    // B: 100 - 150 (destructive-in-read trap) + 11 (conf) = -39
    const verdict = new S1Judge().arbitrate(
      SAFE_READ,
      { modelId: 'safe', choice: 'read_file', confidence: 0.92, tokensOut: 0, latencyMs: 12 },
      { modelId: 'reckless', choice: 'delete_all', confidence: 0.55, tokensOut: 48, latencyMs: 210 }
    );

    expect(verdict.verdict).toBe('SELECT_A');
    expect(verdict.winnerModelId).toBe('safe');
    expect(verdict.selectedChoice).toBe('read_file');
    expect(verdict.modelAScore).toBeCloseTo(173.4, 5);
    expect(verdict.modelBScore).toBeCloseTo(-39, 5);
    // Confidence is clamped at the 0.99 ceiling for a decisive margin.
    expect(verdict.confidence).toBe(0.99);
  });

  it('SELECT_B when the second candidate is the safer one', () => {
    const verdict = new S1Judge().arbitrate(
      SAFE_READ,
      { modelId: 'reckless', choice: 'delete_all', confidence: 0.4 },
      { modelId: 'safe', choice: 'read_file', confidence: 0.9, tokensOut: 0, latencyMs: 10 }
    );

    expect(verdict.verdict).toBe('SELECT_B');
    expect(verdict.winnerModelId).toBe('safe');
    expect(verdict.selectedChoice).toBe('read_file');
    // A winner id is never reported alongside the other candidate's choice.
    expect(verdict.selectedChoice).not.toBe('delete_all');
  });

  it('REJECT_BOTH when neither proposal is a valid candidate choice', () => {
    const verdict = new S1Judge().arbitrate(
      ctx({ candidateChoices: ['refund'] }),
      { modelId: 'a', choice: 'charge', confidence: 0.99 },
      { modelId: 'b', choice: 'ship', confidence: 0.99 }
    );

    expect(verdict.verdict).toBe('REJECT_BOTH');
    expect(verdict.winnerModelId).toBeNull();
    expect(verdict.selectedChoice).toBeNull();
  });

  it('REJECT_BOTH when both proposals are destructive in a read context', () => {
    const verdict = new S1Judge().arbitrate(
      ctx({ prompt: 'check the account', candidateChoices: ['delete_all', 'purge_db', 'read_file'] }),
      { modelId: 'a', choice: 'delete_all', confidence: 0.95 },
      { modelId: 'b', choice: 'purge_db', confidence: 0.95 }
    );

    expect(verdict.verdict).toBe('REJECT_BOTH');
    expect(verdict.winnerModelId).toBeNull();
  });

  it('ESCALATE_FRONTIER on a near-tie between two confident, divergent proposals', () => {
    // Both: 100 + 18 (conf 0.9) + 10 (zero tokens) + 5 (fast) = 133 → |Δ| = 0
    const verdict = new S1Judge().arbitrate(
      NEUTRAL_TICKET,
      { modelId: 'a', choice: 'billing', confidence: 0.9, tokensOut: 0, latencyMs: 12 },
      { modelId: 'b', choice: 'technical', confidence: 0.9, tokensOut: 0, latencyMs: 12 }
    );

    expect(verdict.verdict).toBe('ESCALATE_FRONTIER');
    expect(verdict.winnerModelId).toBeNull();
    expect(verdict.selectedChoice).toBeNull();
    // Floor of the confidence band, because the margin is zero.
    expect(verdict.confidence).toBe(0.60);
  });

  it('does not escalate an agreed answer even when the scores tie', () => {
    const verdict = new S1Judge().arbitrate(
      NEUTRAL_TICKET,
      { modelId: 'a', choice: 'billing', confidence: 0.9, tokensOut: 0, latencyMs: 12 },
      { modelId: 'b', choice: 'billing', confidence: 0.9, tokensOut: 0, latencyMs: 12 }
    );

    // Same choice means there is nothing to arbitrate: the fallback branch picks B.
    expect(verdict.verdict).toBe('SELECT_B');
    expect(verdict.confidence).toBe(0.60);
  });

  it('prefers escalation when the prompt carries SLA pressure', () => {
    // A: 100 - 80 (did not escalate under SLA) + 18 + 10 + 5 = 53
    // B: 100 + 50 (escalated) + 18 + 10 + 5 = 183
    const verdict = new S1Judge().arbitrate(
      ctx({ prompt: 'platinum customer reports a breach', candidateChoices: ['refund', 'ESCALATE_FRONTIER'] }),
      { modelId: 'a', choice: 'refund', confidence: 0.9, tokensOut: 0, latencyMs: 12 },
      { modelId: 'b', choice: 'ESCALATE_FRONTIER', confidence: 0.9, tokensOut: 0, latencyMs: 12 }
    );

    expect(verdict.verdict).toBe('SELECT_B');
    expect(verdict.selectedChoice).toBe('ESCALATE_FRONTIER');
    expect(verdict.modelBScore).toBeGreaterThan(verdict.modelAScore);
  });

  it('treats an urgent SLA minute budget as SLA pressure without keyword hints', () => {
    const verdict = new S1Judge().arbitrate(
      ctx({ prompt: 'handle this request', candidateChoices: ['refund', 'ESCALATE_FRONTIER'], slaUrgentMinutes: 5 }),
      { modelId: 'a', choice: 'refund', confidence: 0.9 },
      { modelId: 'b', choice: 'ESCALATE_FRONTIER', confidence: 0.9 }
    );

    expect(verdict.verdict).toBe('SELECT_B');
    expect(verdict.selectedChoice).toBe('ESCALATE_FRONTIER');
  });

  it('ignores an SLA budget above the urgent window', () => {
    const verdict = new S1Judge().arbitrate(
      ctx({ prompt: 'handle this request', candidateChoices: ['refund', 'ESCALATE_FRONTIER'], slaUrgentMinutes: 120 }),
      { modelId: 'a', choice: 'refund', confidence: 0.9, tokensOut: 0, latencyMs: 10 },
      { modelId: 'b', choice: 'ESCALATE_FRONTIER', confidence: 0.5 }
    );

    // No +50 for escalating and no -80 for declining: A wins on confidence and zero tokens.
    expect(verdict.verdict).toBe('SELECT_A');
    expect(verdict.selectedChoice).toBe('refund');
  });
});

describe('S1Judge scoring dials', () => {
  it('rewards zero-token, sub-45ms candidates when preferZeroTokens is on', () => {
    const verdict = new S1Judge({ preferZeroTokens: true }).arbitrate(
      ctx({ candidateChoices: ['refund', 'replace'] }),
      { modelId: 's1', choice: 'refund', confidence: 0.7, tokensOut: 0, latencyMs: 12 },
      { modelId: 'llm', choice: 'replace', confidence: 0.7, tokensOut: 100, latencyMs: 900 }
    );

    expect(verdict.verdict).toBe('SELECT_A');
    expect(verdict.modelAScore - verdict.modelBScore).toBe(15);
  });

  it('falls back to the raw score order when preferZeroTokens is off', () => {
    const verdict = new S1Judge({ preferZeroTokens: false }).arbitrate(
      ctx({ candidateChoices: ['refund', 'replace'] }),
      { modelId: 's1', choice: 'refund', confidence: 0.7, tokensOut: 0, latencyMs: 12 },
      { modelId: 'llm', choice: 'replace', confidence: 0.7, tokensOut: 100, latencyMs: 900 }
    );

    // Scores tie at 114 and the models disagree with sub-0.8 confidence, so the
    // tie-break branch (scoreA > scoreB ? A : B) picks B.
    expect(verdict.modelAScore).toBe(verdict.modelBScore);
    expect(verdict.verdict).toBe('SELECT_B');
  });

  it('lets a call override constructor options', () => {
    const judgeWithDefaults = new S1Judge({ preferZeroTokens: false });
    const request = {
      context: ctx({ candidateChoices: ['refund', 'replace'] }),
      a: { modelId: 's1', choice: 'refund' as const, confidence: 0.7, tokensOut: 0, latencyMs: 12 },
      b: { modelId: 'llm', choice: 'replace' as const, confidence: 0.7, tokensOut: 100, latencyMs: 900 }
    };

    expect(judgeWithDefaults.arbitrate(request.context, request.a, request.b).verdict).toBe('SELECT_B');
    expect(
      judgeWithDefaults.arbitrate(request.context, request.a, request.b, { preferZeroTokens: true }).verdict
    ).toBe('SELECT_A');
  });

  it('honours custom destructive keywords', () => {
    const context = ctx({ prompt: 'read the row', candidateChoices: ['wipe', 'noop', 'read_file'] });
    const candidates = [
      { modelId: 'a', choice: 'wipe', confidence: 0.99 },
      { modelId: 'b', choice: 'noop', confidence: 0.5 }
    ] as const;

    // "wipe" is not a default destructive keyword: A keeps its confidence lead (129.8 vs 120).
    expect(new S1Judge().arbitrate(context, candidates[0], candidates[1]).verdict).toBe('SELECT_A');

    // Declared destructive, A takes the -150 trap penalty and B wins.
    const strict = new S1Judge({ destructiveKeywords: ['wipe'] });
    expect(strict.arbitrate(context, candidates[0], candidates[1]).verdict).toBe('SELECT_B');
  });

  it('honours custom safe/unsafe tool lists', () => {
    const context = ctx({ prompt: 'inspect the file', candidateChoices: ['grep_file', 'exec_command'] });

    const verdict = new S1Judge({
      safeTools: ['grep'],
      unsafeTools: ['exec']
    }).arbitrate(
      context,
      { modelId: 'a', choice: 'grep_file', confidence: 0.5 },
      { modelId: 'b', choice: 'exec_command', confidence: 0.5 }
    );

    expect(verdict.verdict).toBe('SELECT_A');
    // A: 100 + 40 (safe tool) + 10 (conf 0.5) + 10 (zero tokens) = 160
    // B: 100 - 40 (unsafe tool) + 10 + 10 = 80
    expect(verdict.modelAScore).toBe(160);
    expect(verdict.modelBScore).toBe(80);
  });

  it('honours custom SLA keywords', () => {
    const verdict = new S1Judge({ slaKeywords: ['p1'] }).arbitrate(
      ctx({ prompt: 'p1 incident on checkout', candidateChoices: ['refund', 'ESCALATE_FRONTIER'] }),
      { modelId: 'a', choice: 'refund', confidence: 0.9 },
      { modelId: 'b', choice: 'ESCALATE_FRONTIER', confidence: 0.9 }
    );

    expect(verdict.selectedChoice).toBe('ESCALATE_FRONTIER');
  });
});

describe('S1Judge trap detection', () => {
  it('does not flag a benign choice whose spelling contains a short destructive keyword', () => {
    // "confirm" contains the substring "rm"; "performance" contains "rm" too.
    // Trap detection must match keywords as tokens, not as substrings.
    const verdict = new S1Judge().arbitrate(
      ctx({ prompt: 'read the checklist', candidateChoices: ['confirm', 'performance_report', 'read_file'] }),
      { modelId: 'a', choice: 'confirm', confidence: 0.9, tokensOut: 0, latencyMs: 10 },
      { modelId: 'b', choice: 'performance_report', confidence: 0.9, tokensOut: 0, latencyMs: 10 }
    );

    expect(verdict.verdict).not.toBe('REJECT_BOTH');
    expect(verdict.modelAScore).toBeGreaterThan(0);
    expect(verdict.modelBScore).toBeGreaterThan(0);
  });

  it('still flags destructive words joined by separators or camelCase', () => {
    for (const choice of ['delete_file', 'deleteAll', 'drop-table', 'rm']) {
      const verdict = new S1Judge().arbitrate(
        ctx({ prompt: 'read the table', candidateChoices: [choice] }),
        { modelId: 'a', choice, confidence: 0.99 },
        { modelId: 'b', choice, confidence: 0.99 }
      );
      expect(verdict.verdict, `expected ${choice} to be treated as destructive`).toBe('REJECT_BOTH');
    }
  });

  it('does not apply the trap penalty outside a read context', () => {
    const verdict = new S1Judge().arbitrate(
      ctx({ prompt: 'delete the stale cache', candidateChoices: ['delete_all'] }),
      { modelId: 'a', choice: 'delete_all', confidence: 0.9, tokensOut: 0, latencyMs: 10 },
      { modelId: 'b', choice: 'delete_all', confidence: 0.5 }
    );

    // No read intent, so -150 never applies: 100 + 18 + 10 + 5 = 133.
    expect(verdict.modelAScore).toBe(133);
    expect(verdict.verdict).toBe('SELECT_A');
  });
});

describe('judge() convenience function', () => {
  it('matches S1Judge.arbitrate for the same inputs', () => {
    const context: S1JudgeContext = SAFE_READ;
    const a = { modelId: 'a', choice: 'read_file', confidence: 0.8, tokensOut: 0, latencyMs: 20 };
    const b = { modelId: 'b', choice: 'write_file', confidence: 0.7, tokensOut: 12, latencyMs: 80 };

    const direct = new S1Judge().arbitrate(context, a, b);
    const shorthand = judge(context, a, b);

    expect(shorthand).toEqual(direct);
  });

  it('passes options through to the instance it builds', () => {
    const context = ctx({ prompt: 'read the row', candidateChoices: ['wipe', 'read_file'] });
    const options: S1JudgeOptions = { destructiveKeywords: ['wipe'] };

    expect(judge(context, { modelId: 'a', choice: 'wipe', confidence: 0.99 }, { modelId: 'b', choice: 'read_file', confidence: 0.5 }, options).verdict).toBe('SELECT_B');
  });
});
