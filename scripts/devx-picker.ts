/**
 * Pure provider-picker logic, split out of `scripts/devx.ts` so the answer
 * mapping and the prompt loop can be tested without a TTY.
 *
 * `scripts/devx.ts` owns the terminal (readline, colours, the persistence
 * store); this module owns the decisions: what an answer means, when to retry,
 * and how Ctrl-C/Ctrl-D map to an abort instead of a silent ladder run.
 */

import type { DevxProviderId, ProviderChoice } from '../examples/shared/provider.js';

export type PickerCancellationReason = 'sigint' | 'eof' | 'closed';

/**
 * What the command should do after the picker had its chance.
 *
 * `ladder` is a deliberate "keep the existing resolution" (declined, not
 * interactive, nothing usable to choose), `cancelled` aborts the command, and
 * `picked` pins exactly the chosen provider.
 */
export type ProviderSelection =
  | { readonly kind: 'picked'; readonly provider: DevxProviderId }
  | {
      readonly kind: 'ladder';
      readonly reason: 'declined' | 'unavailable' | 'none';
    }
  | { readonly kind: 'cancelled'; readonly reason: PickerCancellationReason };

/** A cancellation we initiate (Ctrl-C), distinct from readline's AbortError. */
export class PickerCancelledError extends Error {
  readonly reason: PickerCancellationReason;

  constructor(reason: PickerCancellationReason) {
    super(
      reason === 'sigint'
        ? 'provider selection cancelled with Ctrl-C'
        : 'provider selection cancelled before a choice was made'
    );
    this.name = 'PickerCancelledError';
    this.reason = reason;
  }
}

/**
 * Recognises an asked-question cancellation. Ctrl-D surfaces as readline's
 * `AbortError` ("Aborted with Ctrl+D"); closed/non-TTY input may reject with a
 * generic abort, which we still treat as a cancel rather than a ladder run.
 */
export function cancellationReason(error: unknown): PickerCancellationReason | undefined {
  if (error instanceof PickerCancelledError) return error.reason;
  if (error instanceof Error && error.name === 'AbortError') {
    return /ctrl\+d|\beof\b|closed/i.test(error.message) ? 'eof' : 'closed';
  }
  return undefined;
}

/** One parsed answer. `invalid` means "ask again", never "run the ladder". */
export type ProviderAnswer =
  | { readonly kind: 'picked'; readonly provider: DevxProviderId }
  | { readonly kind: 'ladder' }
  | { readonly kind: 'invalid' };

/**
 * Maps a raw answer to an intent. Pure and total:
 *   - empty (Enter) -> the first listed choice, or the ladder when there is none
 *   - `q`/`quit`    -> keep the ladder (an explicit decline)
 *   - `1..n`        -> that choice
 *   - provider id   -> that choice, case-insensitive
 *   - anything else -> invalid; the caller re-asks
 */
export function matchProviderAnswer(
  raw: string,
  choices: readonly ProviderChoice[]
): ProviderAnswer {
  const answer = raw.trim();
  if (answer === '') {
    const first = choices[0];
    return first ? { kind: 'picked', provider: first.provider } : { kind: 'ladder' };
  }

  const lowered = answer.toLowerCase();
  if (lowered === 'q' || lowered === 'quit') return { kind: 'ladder' };

  const numeric = Number(answer);
  if (Number.isInteger(numeric)) {
    const choice =
      numeric >= 1 && numeric <= choices.length ? choices[numeric - 1] : undefined;
    return choice ? { kind: 'picked', provider: choice.provider } : { kind: 'invalid' };
  }

  const byName = choices.find((choice) => choice.provider === lowered);
  return byName ? { kind: 'picked', provider: byName.provider } : { kind: 'invalid' };
}

export interface PromptLoopOptions {
  /** Ask one question. Rejections are classified by `cancellationReason`. */
  readonly ask: (question: string) => Promise<string>;
  /** Override the prompt text (lets the caller keep its colours). */
  readonly question?: string;
  /** Called for an unparseable answer before the loop asks again. */
  readonly onInvalid?: (answer: string) => void;
}

/**
 * Runs the read-eval-retry loop until a choice, a decline, or a cancellation.
 * Unrelated errors are rethrown so a broken terminal is never mistaken for a
 * "keep the ladder" answer.
 */
export async function runProviderPrompt(
  choices: readonly ProviderChoice[],
  options: PromptLoopOptions
): Promise<ProviderSelection> {
  if (choices.length === 0) return { kind: 'ladder', reason: 'unavailable' };

  const question =
    options.question ??
    `\nselect [1-${choices.length}] (enter = 1, q = keep the ladder default): `;

  for (;;) {
    let answer: string;
    try {
      answer = await options.ask(question);
    } catch (error) {
      const reason = cancellationReason(error);
      if (reason) return { kind: 'cancelled', reason };
      throw error;
    }

    const match = matchProviderAnswer(answer, choices);
    if (match.kind === 'picked') return match;
    if (match.kind === 'ladder') return { kind: 'ladder', reason: 'declined' };
    options.onInvalid?.(answer);
  }
}

/**
 * Which commands execute against a provider — and therefore may ask the
 * interactive picker. `doctor` is deliberately absent: it is a passive
 * diagnostic and must never read stdin or change its own `winner` by prompting.
 */
export function commandUsesProvider(command: string, target?: string): boolean {
  return (
    command === 'all' ||
    command === 'smoke' ||
    (command === 'example' && Boolean(target)) ||
    (command === 'examples' && Boolean(target))
  );
}

/** Human-readable reason for the abort message and exit status. */
export function describeCancellation(reason: PickerCancellationReason): string {
  if (reason === 'sigint') return 'cancelled (Ctrl-C)';
  if (reason === 'eof') return 'no provider chosen (Ctrl-D)';
  return 'no provider chosen (input closed)';
}
