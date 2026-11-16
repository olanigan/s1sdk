import { describe, it, expect } from 'vitest';
import {
  PickerCancelledError,
  commandUsesProvider,
  describeCancellation,
  matchProviderAnswer,
  runProviderPrompt,
  type ProviderSelection
} from '../scripts/devx-picker.js';
import type { ProviderChoice } from '../examples/shared/provider.js';

const CHOICES: readonly ProviderChoice[] = [
  { provider: 'typesafe', ready: true, detail: 'TYPESAFE_API_KEY=ts-…' },
  { provider: 'openrouter', ready: true, detail: 'OPENROUTER_API_KEY=sk-or-…' }
];

function scripted(answers: readonly (string | Error)[]): {
  ask: (question: string) => Promise<string>;
  questions: string[];
} {
  const questions: string[] = [];
  return {
    ask: async (question) => {
      questions.push(question);
      const next = answers[questions.length - 1];
      if (next instanceof Error) throw next;
      return next ?? '';
    },
    questions
  };
}

describe('devx picker answer mapping', () => {
  it('maps Enter to the first choice', () => {
    expect(matchProviderAnswer('', CHOICES)).toEqual({ kind: 'picked', provider: 'typesafe' });
    expect(matchProviderAnswer('   ', CHOICES)).toEqual({ kind: 'picked', provider: 'typesafe' });
  });

  it('maps Enter to the ladder when there is nothing to choose', () => {
    expect(matchProviderAnswer('', [])).toEqual({ kind: 'ladder' });
  });

  it('maps numbers, including padded and spaced input', () => {
    expect(matchProviderAnswer('1', CHOICES)).toEqual({ kind: 'picked', provider: 'typesafe' });
    expect(matchProviderAnswer('2', CHOICES)).toEqual({ kind: 'picked', provider: 'openrouter' });
    expect(matchProviderAnswer(' 02 ', CHOICES)).toEqual({ kind: 'picked', provider: 'openrouter' });
  });

  it('maps a provider id case-insensitively', () => {
    expect(matchProviderAnswer('OPENROUTER', CHOICES)).toEqual({
      kind: 'picked',
      provider: 'openrouter'
    });
    expect(matchProviderAnswer(' TypeSafe ', CHOICES)).toEqual({
      kind: 'picked',
      provider: 'typesafe'
    });
  });

  it('maps q/quit to the ladder (an explicit decline)', () => {
    expect(matchProviderAnswer('q', CHOICES)).toEqual({ kind: 'ladder' });
    expect(matchProviderAnswer(' QUIT ', CHOICES)).toEqual({ kind: 'ladder' });
  });

  it('rejects out-of-range, fractional, and unknown answers', () => {
    for (const answer of ['0', '3', '-1', '1.5', 'nope', 'cloudflare']) {
      expect(matchProviderAnswer(answer, CHOICES)).toEqual({ kind: 'invalid' });
    }
  });
});

describe('devx picker prompt loop', () => {
  it('re-asks after an invalid answer and returns the choice', async () => {
    const { ask, questions } = scripted(['nope', '2']);
    const invalid: string[] = [];

    const selection = await runProviderPrompt(CHOICES, {
      ask,
      onInvalid: (answer) => invalid.push(answer)
    });

    expect(selection).toEqual({ kind: 'picked', provider: 'openrouter' });
    expect(questions).toHaveLength(2);
    expect(invalid).toEqual(['nope']);
    expect(new Set(questions).size).toBe(1);
  });

  it('takes the first choice on Enter', async () => {
    const { ask } = scripted(['']);
    await expect(runProviderPrompt(CHOICES, { ask })).resolves.toEqual({
      kind: 'picked',
      provider: 'typesafe'
    });
  });

  it('treats q as a decline, not a cancellation', async () => {
    const { ask } = scripted(['q']);
    await expect(runProviderPrompt(CHOICES, { ask })).resolves.toEqual({
      kind: 'ladder',
      reason: 'declined'
    });
  });

  it('returns cancelled for our Ctrl-C rejection', async () => {
    const { ask } = scripted([new PickerCancelledError('sigint')]);
    await expect(runProviderPrompt(CHOICES, { ask })).resolves.toEqual({
      kind: 'cancelled',
      reason: 'sigint'
    });
  });

  it('returns cancelled for readline Ctrl-D (AbortError)', async () => {
    const ctrlD = Object.assign(new Error('Aborted with Ctrl+D'), { name: 'AbortError' });
    const { ask } = scripted([ctrlD]);
    await expect(runProviderPrompt(CHOICES, { ask })).resolves.toEqual({
      kind: 'cancelled',
      reason: 'eof'
    });
  });

  it('returns cancelled when the input stream closes', async () => {
    const closed = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    const { ask } = scripted([closed]);
    await expect(runProviderPrompt(CHOICES, { ask })).resolves.toEqual({
      kind: 'cancelled',
      reason: 'closed'
    });
  });

  it('rethrows an unrelated error instead of treating it as a decline', async () => {
    const { ask } = scripted([new Error('terminal exploded')]);
    await expect(runProviderPrompt(CHOICES, { ask })).rejects.toThrow('terminal exploded');
  });

  it('does not ask when there is nothing to choose', async () => {
    const { ask, questions } = scripted(['1']);
    const selection: ProviderSelection = await runProviderPrompt([], { ask });
    expect(selection).toEqual({ kind: 'ladder', reason: 'unavailable' });
    expect(questions).toHaveLength(0);
  });
});

describe('devx provider command scope', () => {
  it('never prompts for doctor, list, or help', () => {
    expect(commandUsesProvider('doctor')).toBe(false);
    expect(commandUsesProvider('doctor', 'extra')).toBe(false);
    expect(commandUsesProvider('list')).toBe(false);
    expect(commandUsesProvider('help')).toBe(false);
  });

  it('prompts for commands that run against a provider', () => {
    expect(commandUsesProvider('all')).toBe(true);
    expect(commandUsesProvider('smoke')).toBe(true);
    expect(commandUsesProvider('example', '2')).toBe(true);
    expect(commandUsesProvider('examples', 'all')).toBe(true);
  });

  it('does not prompt for an example listing', () => {
    expect(commandUsesProvider('example')).toBe(false);
    expect(commandUsesProvider('examples')).toBe(false);
  });
});

describe('devx cancellation messages', () => {
  it('names the abort that happened', () => {
    expect(describeCancellation('sigint')).toMatch(/Ctrl-C/);
    expect(describeCancellation('eof')).toMatch(/Ctrl-D/);
    expect(describeCancellation('closed')).toMatch(/closed/);
  });
});
