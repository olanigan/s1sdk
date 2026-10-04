/**
 * Jev System-1 Decision Client: Deterministic Offline Mock Engine
 * Specification: SPEC-001-jev-sdk-core-client.md (Section 3.2 #4)
 *
 * Zero-overhead, air-gapped deterministic simulation engine.
 * Computes deterministic hashes and domain heuristics to produce
 * mathematically stable, reproducible calibration distributions.
 */

import { JevProviderBase, type ProviderMetadata } from './base.js';
import type {
  JevQuestion,
  JevDecisionRequest,
  JevDecisionResponse,
  JevExecutionOptions,
  InferJevAnswer,
  JevAnswer
} from '../types.js';

export interface MockEngineOptions {
  readonly latencySimulationMs?: number;
}

/**
 * Deterministic string hash algorithm (FNV-1a 32-bit)
 * Produces uniform distribution without external crypto dependencies.
 */
function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export class MockEngine extends JevProviderBase {
  readonly name = 'Jev Offline Mock Engine';
  readonly providerId = 'mock-engine';

  constructor(private readonly options: MockEngineOptions = {}) {
    super();
  }

  public async execute<TState, TQuestions extends Record<string, JevQuestion>>(
    request: JevDecisionRequest<TState, TQuestions>,
    _options?: JevExecutionOptions
  ): Promise<JevDecisionResponse<TQuestions>> {
    return MockEngine.decide(request, {
      latencySimulationMs: this.options.latencySimulationMs,
      isFallback: false
    });
  }

  public async isHealthy(): Promise<boolean> {
    return true;
  }

  public getMetadata(): ProviderMetadata {
    return {
      providerId: this.providerId,
      defaultModel: 'mock-deterministic',
      supportsLocalExecution: true,
      maxConcurrentRequests: 100_000
    };
  }

  /**
   * Static evaluation helper for fast zero-overhead invocation
   */
  public static async decide<
    TState = unknown,
    TQuestions extends Record<string, JevQuestion> = Record<string, JevQuestion>
  >(
    request: JevDecisionRequest<TState, TQuestions>,
    config: { latencySimulationMs?: number; isFallback?: boolean } = {}
  ): Promise<JevDecisionResponse<TQuestions>> {
    const startTime = performance.now();
    let stateStr: string;
    if (typeof request.state === 'string') {
      stateStr = request.state;
    } else {
      try {
        stateStr = JSON.stringify(request.state ?? {});
      } catch {
        stateStr = '[Unserializable State]';
      }
    }

    const answers: Record<string, JevAnswer> = {};

    for (const [key, q] of Object.entries(request.questions)) {
      const qHash = fnv1a(`${stateStr}:${key}:${q.type}:${q.instructions}`);

      if (q.type === 'noul') {
        // Evaluate domain heuristics for security / danger (bounded regex to prevent ReDoS)
        const isDangerous =
          /rm\s+-rf|DROP\s+TABLE|format\s+[a-z]:|chmod\s+777|privilege|jailbreak|ignore[\s\S]{0,100}?previous|\bDAN\b|system\s+prompt/i.test(
            stateStr
          );

        let calibratedNoul: number;
        if (isDangerous) {
          calibratedNoul = 0.96;
        } else if (/safe|benign|verify|health|status/i.test(stateStr)) {
          calibratedNoul = 0.04;
        } else {
          // Stable calibrated probability between [0.0500, 0.9500]
          const normalized = (qHash % 9000) / 10000 + 0.05;
          calibratedNoul = Math.round(normalized * 10000) / 10000;
        }

        answers[key] = {
          noul: calibratedNoul,
          raw_logit: Math.log(calibratedNoul / (1 - calibratedNoul))
        };
      } else if (q.type === 'choice') {
        const criteriaKeys = Object.keys(q.criteria);
        if (criteriaKeys.length === 0) {
          answers[key] = {
            choice: 'default',
            confidence: 1.0,
            probabilities: { default: 1.0 }
          };
          continue;
        }

        let selectedKey = criteriaKeys[0] || 'default';

        // Domain heuristics for agent reflexes & edge routing
        if (
          /bash|terminal|rm|ls|exec|mkdir|grep|cat|tail/i.test(stateStr) &&
          criteriaKeys.includes('terminal')
        ) {
          selectedKey = 'terminal';
        } else if (
          /search|weather|query|google|find|lookup/i.test(stateStr) &&
          (criteriaKeys.includes('search') || criteriaKeys.includes('web_search'))
        ) {
          selectedKey = criteriaKeys.includes('web_search') ? 'web_search' : 'search';
        } else if (
          /read|cat|file|open/i.test(stateStr) &&
          criteriaKeys.includes('read_file')
        ) {
          selectedKey = 'read_file';
        } else if (
          /cache|faq|ping|status|hi\b|hello/i.test(stateStr) &&
          criteriaKeys.includes('CACHE_HIT')
        ) {
          selectedKey = 'CACHE_HIT';
        } else if (
          /summarize|extract|notes|release/i.test(stateStr) &&
          criteriaKeys.includes('WORKERS_AI_SLM')
        ) {
          selectedKey = 'WORKERS_AI_SLM';
        } else if (criteriaKeys.includes('FRONTIER_ANTHROPIC')) {
          selectedKey = 'FRONTIER_ANTHROPIC';
        } else if (criteriaKeys.length > 0) {
          const idx = qHash % criteriaKeys.length;
          selectedKey = criteriaKeys[idx] ?? criteriaKeys[0]!;
        }

        // Generate calibrated softmax probability distribution summing strictly to 1.00
        const probabilities: Record<string, number> = {};
        const topConfidence = 0.94;
        const remainder = Number((1.0 - topConfidence).toFixed(4));
        const numOthers = Math.max(1, criteriaKeys.length - 1);
        const otherProb = Number((remainder / numOthers).toFixed(4));

        let currentSum = 0;
        for (const k of criteriaKeys) {
          if (k === selectedKey) {
            probabilities[k] = topConfidence;
            currentSum += topConfidence;
          } else {
            probabilities[k] = otherProb;
            currentSum += otherProb;
          }
        }

        // Adjust rounding delta to guarantee sum === 1.0000
        const delta = Math.round((1.0 - currentSum) * 10000) / 10000;
        if (delta !== 0 && selectedKey in probabilities) {
          probabilities[selectedKey] = Math.round((probabilities[selectedKey]! + delta) * 10000) / 10000;
        }

        answers[key] = {
          choice: selectedKey,
          confidence: topConfidence,
          probabilities
        };
      } else if (q.type === 'score') {
        const levels = q.levels ?? [1, 2, 3, 4, 5];
        let chosenScore = 0.91;
        if (typeof levels[0] === 'number') {
          const maxLevel = Number(levels[levels.length - 1]);
          chosenScore = Math.min(maxLevel, 4);
        }

        answers[key] = {
          score: chosenScore,
          confidence: 0.89
        };
      }
    }

    if (config.latencySimulationMs && config.latencySimulationMs > 0) {
      await new Promise((res) => setTimeout(res, config.latencySimulationMs));
    }

    const elapsed = Math.max(1, Math.round(performance.now() - startTime));
    const isFallback = Boolean(config.isFallback);
    const providerUsed = isFallback ? 'mock-engine-fallback' : 'mock-engine';
    const inputTokens = Math.ceil(stateStr.length / 4);

    return {
      answers: answers as { [K in keyof TQuestions]: InferJevAnswer<TQuestions[K]> },
      latencyMs: elapsed,
      latency_ms: elapsed,
      providerUsed,
      provider: providerUsed,
      modelUsed: 'mock-deterministic',
      isFallback,
      usage: {
        inputTokens,
        outputTokens: 0,
        input_tokens: inputTokens,
        output_tokens: 0
      },
      timestamp: Date.now()
    };
  }
}

/**
 * Backward compatibility alias for JevMockEngine
 */
export const JevMockEngine = MockEngine;
