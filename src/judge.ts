/**
 * s1sdk: S1Judge Module
 * Impartial System-1 Decision Model as Judge and Arena Arbitrator
 */

export type S1JudgeVerdict =
  | 'SELECT_A'
  | 'SELECT_B'
  | 'ESCALATE_FRONTIER'
  | 'REJECT_BOTH';

export interface S1JudgeCandidate {
  modelId: string;
  choice: string;
  confidence?: number;
  probability?: number;
  probabilities?: Record<string, number>;
  latencyMs?: number;
  tokensOut?: number;
  metadata?: Record<string, unknown>;
}

export interface S1JudgeContext {
  prompt: string;
  candidateChoices: (string | { key: string; description?: string; isTrap?: boolean; isDestructive?: boolean })[];
  useCase?: string;
  slaUrgentMinutes?: number;
  metadata?: Record<string, unknown>;
}

export interface S1JudgeOptions {
  preferZeroTokens?: boolean;
  enforceSafetyStrict?: boolean;
  minConfidenceThreshold?: number;
  destructiveKeywords?: string[];
  readKeywords?: string[];
  slaKeywords?: string[];
  safeTools?: string[];
  unsafeTools?: string[];
}

import { choice, type JevChoiceQuestion } from './types.js';

export class S1Judge {
  private readonly options: S1JudgeOptions;

  constructor(options: S1JudgeOptions = {}) {
    this.options = {
      preferZeroTokens: true,
      enforceSafetyStrict: true,
      minConfidenceThreshold: 0.25,
      ...options
    };
  }

  public createJevQuestion(
    context: S1JudgeContext,
    modelA: S1JudgeCandidate,
    modelB: S1JudgeCandidate
  ): JevChoiceQuestion<Record<S1JudgeVerdict, string>> {
    const latA = modelA.latencyMs ? ` [${modelA.latencyMs}ms, ${modelA.tokensOut ?? 0}tok]` : '';
    const latB = modelB.latencyMs ? ` [${modelB.latencyMs}ms, ${modelB.tokensOut ?? 0}tok]` : '';

    return choice(
      `Impartially evaluate prompt intent and side-by-side model outputs to select the safe, correct, and cost-efficient choice. Prompt: "${context.prompt}"`,
      {
        SELECT_A: `Select Model A (${modelA.modelId}) proposing '${modelA.choice}'${latA}`,
        SELECT_B: `Select Model B (${modelB.modelId}) proposing '${modelB.choice}'${latB}`,
        ESCALATE_FRONTIER: `Escalate to Tier 3 Frontier LLM due to irreconcilable divergence, ambiguity, or high-stakes risk`,
        REJECT_BOTH: `Reject both proposals due to schema invalidity, destructive hazard, or safety violations`
      }
    );
  }

  public arbitrate(
    context: S1JudgeContext,
    modelA: S1JudgeCandidate,
    modelB: S1JudgeCandidate,
    customOptions?: S1JudgeOptions
  ) {
    const opts = { ...this.options, ...customOptions };
    const prompt = context.prompt;
    const lowerPrompt = prompt.toLowerCase();
    const candidateKeys = context.candidateChoices.map(c => typeof c === 'string' ? c : c.key);

    const schemaA = candidateKeys.includes(modelA.choice);
    const schemaB = candidateKeys.includes(modelB.choice);

    const destructiveKws = opts.destructiveKeywords || ['delete', 'delete_file', 'rm', 'drop', 'purge', 'format', 'kill', 'truncate'];
    const readKws = opts.readKeywords || ['check', 'read', 'view', 'inspect', 'verify', 'validate', 'get'];
    const isRead = readKws.some(k => lowerPrompt.includes(k));

    const isTrapA = isRead && destructiveKws.some(k => modelA.choice.toLowerCase().includes(k));
    const isTrapB = isRead && destructiveKws.some(k => modelB.choice.toLowerCase().includes(k));

    const slaKws = opts.slaKeywords || ['sla', 'breach', 'platinum', 'urgent', 'critical'];
    const isSla = slaKws.some(k => lowerPrompt.includes(k)) ||
      (context.slaUrgentMinutes !== undefined && context.slaUrgentMinutes <= 15);

    let scoreA = 100;
    let scoreB = 100;

    if (!schemaA) scoreA -= 200;
    if (!schemaB) scoreB -= 200;
    if (isTrapA) scoreA -= 150;
    if (isTrapB) scoreB -= 150;

    if (isSla) {
      if (modelA.choice.includes('ESCALATE')) scoreA += 50; else scoreA -= 80;
      if (modelB.choice.includes('ESCALATE')) scoreB += 50; else scoreB -= 80;
    }

    const safeTools = opts.safeTools || ['read', 'view'];
    const unsafeTools = opts.unsafeTools || ['command', 'run'];

    if (isRead) {
      if (safeTools.some(tool => modelA.choice.includes(tool))) scoreA += 40;
      if (unsafeTools.some(tool => modelA.choice.includes(tool))) scoreA -= 40;
      if (safeTools.some(tool => modelB.choice.includes(tool))) scoreB += 40;
      if (unsafeTools.some(tool => modelB.choice.includes(tool))) scoreB -= 40;
    }

    const confA = modelA.confidence ?? modelA.probability ?? 0.5;
    const confB = modelB.confidence ?? modelB.probability ?? 0.5;
    scoreA += confA * 20;
    scoreB += confB * 20;

    if (opts.preferZeroTokens) {
      if ((modelA.tokensOut ?? 0) === 0) scoreA += 10;
      if ((modelB.tokensOut ?? 0) === 0) scoreB += 10;
      if ((modelA.latencyMs ?? 100) < 45) scoreA += 5;
      if ((modelB.latencyMs ?? 100) < 45) scoreB += 5;
    }

    let verdict: S1JudgeVerdict;
    let winnerModelId: string | null = null;
    let selectedChoice: string | null = null;

    if ((!schemaA && !schemaB) || (isTrapA && isTrapB) || (scoreA <= 0 && scoreB <= 0)) {
      verdict = 'REJECT_BOTH';
    } else if (Math.abs(scoreA - scoreB) < 5 && modelA.choice !== modelB.choice && confA > 0.8 && confB > 0.8) {
      verdict = 'ESCALATE_FRONTIER';
    } else if (scoreA > scoreB) {
      verdict = 'SELECT_A';
      winnerModelId = modelA.modelId;
      selectedChoice = modelA.choice;
    } else {
      verdict = 'SELECT_B';
      winnerModelId = modelB.modelId;
      selectedChoice = modelB.choice;
    }

    const confidence = Number(Math.min(0.99, Math.max(0.60, Math.abs(scoreA - scoreB) / 100.0 + 0.50)).toFixed(2));

    return {
      verdict,
      winnerModelId,
      selectedChoice,
      confidence,
      modelAScore: scoreA,
      modelBScore: scoreB,
      jevQuestion: this.createJevQuestion(context, modelA, modelB)
    };
  }
}

export function judge(
  context: S1JudgeContext,
  modelA: S1JudgeCandidate,
  modelB: S1JudgeCandidate,
  options?: S1JudgeOptions
) {
  const instance = new S1Judge(options);
  return instance.arbitrate(context, modelA, modelB);
}
