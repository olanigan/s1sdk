/**
 * Cloudflare Workers AI: protocol (vendor semantics, transport-agnostic).
 *
 * Everything in this module is a pure function. It runs identically whether the
 * call reaches Cloudflare through an in-process `env.AI` binding or through the
 * REST API, which is the whole point: payload shaping, capability gating and
 * answer normalization must never fork per transport.
 */

import {
  type JevQuestion,
  type S1ExtractField,
  type S1ExtractAnswer,
  type S1ExtractSpan,
  type S1ExtractUsage,
  CLOUDFLARE_MODELS,
  JevValidationError
} from '../../types.js';

export interface CloudflareAiBinding {
  run(model: string, input: any): Promise<any>;
}

/**
 * Normalizes user-specified model strings to Cloudflare Workers AI catalog identifiers
 * and determines if the payload requires an internal model selector (such as Clef or Clairic).
 *
 * `modelId` is transport-agnostic: it is the `env.AI` binding id and also the
 * `/ai/run/{model}` REST path segment.
 */
export function normalizeCloudflareModel(model: string): {
  modelId: string;
  payloadModel?: 'clef' | 'clef-flash' | 'clairic';
} {
  const trimmed = model.trim();
  if (trimmed === 'clairic' || trimmed === '@cf/cloudflare/clairic') {
    return { modelId: CLOUDFLARE_MODELS.CLAIRIC, payloadModel: 'clairic' };
  }
  if (trimmed === 'clef' || trimmed === '@cf/cloudflare/clef') {
    return { modelId: CLOUDFLARE_MODELS.CLEF, payloadModel: 'clef' };
  }
  if (trimmed === 'clef-flash' || trimmed === '@cf/cloudflare/clef-flash') {
    return { modelId: CLOUDFLARE_MODELS.CLEF_FLASH, payloadModel: 'clef-flash' };
  }
  if (trimmed === 'jev' || trimmed === 'typesafe/jev' || trimmed === '@cf/typesafe/jev') {
    return { modelId: CLOUDFLARE_MODELS.JEV };
  }
  const isClef = trimmed.includes('clef');
  const isClairic = trimmed.includes('clairic');
  return {
    modelId: trimmed,
    payloadModel: isClef
      ? (trimmed.includes('flash') ? 'clef-flash' : 'clef')
      : isClairic
      ? 'clairic'
      : undefined
  };
}

/**
 * Strips non-schema properties (such as redundant `levels` on score)
 * to satisfy Cloudflare Workers AI's strict additionalProperties: false schema validation.
 */
export function sanitizeQuestionsForCloudflare(
  questions: Record<string, JevQuestion>
): Record<string, any> {
  const sanitized: Record<string, any> = {};
  for (const [key, q] of Object.entries(questions)) {
    if (q.type === 'noul') {
      sanitized[key] = q.criteria
        ? { type: 'noul', instructions: q.instructions, criteria: q.criteria }
        : { type: 'noul', instructions: q.instructions };
    } else if (q.type === 'choice') {
      // The live API rejects array criteria with HTTP 400 code 5006 and a message
      // that blames the root object ("required properties at '/' are
      // 'model,state,questions'"), which sends callers hunting for the wrong bug.
      // Fail here instead, with the shape the schema actually wants.
      // Verified 2026-10-29: test/fixtures/contracts/cloudflare-rest/error-400-choice-criteria-array.json
      if (q.criteria !== undefined && (Array.isArray(q.criteria) || typeof q.criteria !== 'object')) {
        throw new JevValidationError(
          `Choice question "${key}" requires criterion keys and descriptions, e.g. ` +
            `{ criteria: { refund: "Customer wants a refund", replacement: "Customer wants a replacement" } }. ` +
            `Cloudflare Workers AI rejects arrays for choice criteria and reports a misleading root-level error.`
        );
      }
      sanitized[key] = {
        type: 'choice',
        instructions: q.instructions,
        criteria: q.criteria
      };
    } else if (q.type === 'score') {
      const criteria = q.criteria || q.levels || [1, 2, 3, 4, 5];
      sanitized[key] = {
        type: 'score',
        instructions: q.instructions,
        criteria
      };
    } else {
      sanitized[key] = q;
    }
  }
  return sanitized;
}

/**
 * Strips non-schema properties and normalizes extraction fields
 * to satisfy Cloudflare Workers AI Clairic schema validation.
 */
export function sanitizeFieldsForCloudflare(
  fields: Record<string, S1ExtractField>
): Record<string, any> {
  const sanitized: Record<string, any> = {};
  for (const [key, field] of Object.entries(fields)) {
    const entry: Record<string, any> = { type: field.type };
    if (field.instructions) {
      entry.instructions = field.instructions;
    }
    // Schema default is 0.5; only send when explicitly configured.
    if (field.nullThreshold !== undefined) {
      entry.null_threshold = field.nullThreshold;
    }
    if (field.type === 'number') {
      if (field.decimals !== undefined) entry.decimals = field.decimals;
      if (field.unit !== undefined) entry.unit = field.unit;
      if (field.integer !== undefined) entry.integer = field.integer;
    } else if (field.type === 'duration') {
      if (field.unit !== undefined) entry.unit = field.unit;
      if (field.integer !== undefined) entry.integer = field.integer;
      if (field.decimals !== undefined) entry.decimals = field.decimals;
    } else if (field.type === 'list') {
      // The API requires `items`; the SDK helper accepts `itemType`.
      const itemType = field.itemType || (field as any).item_type || 'text';
      entry.items = itemType;
      if (field.integer !== undefined) entry.integer = field.integer;
      if (field.decimals !== undefined) entry.decimals = field.decimals;
    } else if (field.type === 'estimate') {
      entry.min = field.min;
      entry.max = field.max;
      if (field.step !== undefined) entry.step = field.step;
      if (field.scale !== undefined) entry.scale = field.scale;
    } else if (field.type === 'forecast') {
      entry.min = field.min;
      entry.max = field.max;
      if (field.horizon !== undefined) entry.horizon = field.horizon;
      if (field.interval !== undefined) entry.interval = field.interval;
      if (field.step !== undefined) entry.step = field.step;
      if (field.scale !== undefined) entry.scale = field.scale;
    }
    sanitized[key] = entry;
  }
  return sanitized;
}

/** Clairic media limits from the published input schema. */
export const CLAIRIC_MEDIA_LIMITS = {
  maxImages: 4,
  maxImageBytes: 4 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024
} as const;

function decodedBase64Bytes(value: string): number {
  const clean = value.replace(/\s+/g, '');
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

/**
 * Validates Clairic image inputs client-side so callers get a typed error
 * instead of an opaque Workers AI 400. Accepts data URLs and
 * `{ content_type, base64 }` objects; remote URLs are rejected by the schema.
 */
export function validateClairicImages(images: readonly unknown[] | undefined): void {
  if (images === undefined) return;
  if (!Array.isArray(images)) {
    throw new JevValidationError('Clairic "images" must be an array.');
  }
  if (images.length > CLAIRIC_MEDIA_LIMITS.maxImages) {
    throw new JevValidationError(
      `Clairic accepts at most ${CLAIRIC_MEDIA_LIMITS.maxImages} images; received ${images.length}.`
    );
  }

  let totalBytes = 0;
  images.forEach((image, index) => {
    let base64: string;
    if (typeof image === 'string') {
      const match = /^data:image\/[a-z0-9.+-]+;base64,(.*)$/is.exec(image);
      if (!match) {
        throw new JevValidationError(
          `Clairic image[${index}] must be a base64 data URL (data:image/...;base64,...); remote URLs are not accepted.`
        );
      }
      base64 = match[1] ?? '';
    } else if (
      image !== null &&
      typeof image === 'object' &&
      typeof (image as any).content_type === 'string' &&
      typeof (image as any).base64 === 'string'
    ) {
      if (!/^image\//i.test((image as any).content_type)) {
        throw new JevValidationError(
          `Clairic image[${index}].content_type must start with "image/"; received "${(image as any).content_type}".`
        );
      }
      base64 = (image as any).base64;
    } else {
      throw new JevValidationError(
        `Clairic image[${index}] must be a data URL or { content_type, base64 }.`
      );
    }

    const bytes = decodedBase64Bytes(base64);
    if (bytes > CLAIRIC_MEDIA_LIMITS.maxImageBytes) {
      throw new JevValidationError(
        `Clairic image[${index}] is ${bytes} bytes decoded; the per-image limit is ${CLAIRIC_MEDIA_LIMITS.maxImageBytes} bytes.`
      );
    }
    totalBytes += bytes;
  });

  if (totalBytes > CLAIRIC_MEDIA_LIMITS.maxTotalBytes) {
    throw new JevValidationError(
      `Clairic images total ${totalBytes} bytes decoded; the combined limit is ${CLAIRIC_MEDIA_LIMITS.maxTotalBytes} bytes.`
    );
  }
}

/**
 * Normalizes a Clairic answer: span tuples, quantiles -> interval_80,
 * guess fallback, and telemetry fields.
 */
export function normalizeClairicAnswer(raw: any): S1ExtractAnswer<any> {
  // The backend keeps `confidence` and `p_null` complementary, so deriving one
  // from the other is safe. Fabricating a score when the backend reported
  // *neither* is not: Clairic estimate/forecast answers carry quantiles only,
  // and inventing `confidence: 1.0` would corrupt calibration auditing.
  const hasConfidence = typeof raw.confidence === 'number';
  const hasPNull = typeof raw.p_null === 'number';
  const confidence = hasConfidence
    ? raw.confidence
    : hasPNull
    ? Math.max(0, 1 - raw.p_null)
    : undefined;
  const pNull = hasPNull
    ? raw.p_null
    : hasConfidence
    ? Math.max(0, 1 - raw.confidence)
    : undefined;

  const normalizeSpan = (span: any): S1ExtractSpan | undefined =>
    Array.isArray(span) && span.length === 2 ? [span[0], span[1]] : undefined;

  const span = normalizeSpan(raw.span);
  const spans = Array.isArray(raw.spans)
    ? raw.spans
        .map((s: any) => normalizeSpan(s))
        .filter((s: S1ExtractSpan | undefined): s is S1ExtractSpan => s !== undefined)
    : undefined;

  const interval80 =
    raw.interval_80 ??
    raw.interval80 ??
    (typeof raw.p10 === 'number' && typeof raw.p90 === 'number'
      ? ([raw.p10, raw.p90] as const)
      : undefined);

  return {
    ...raw,
    value:
      raw.value !== undefined
        ? raw.value
        : raw.guess !== undefined
        ? raw.guess
        : raw.text !== undefined
        ? raw.text
        : null,
    ...(confidence !== undefined ? { confidence } : {}),
    ...(pNull !== undefined ? { p_null: pNull } : {}),
    ...(span ? { span } : {}),
    ...(spans && spans.length > 0 ? { spans } : {}),
    ...(interval80 !== undefined ? { interval_80: interval80 } : {})
  };
}

/**
 * Normalizes Clairic usage telemetry. Never fabricates token counts: reports the
 * server breakdown, or zero when the endpoint omits it. Cost math depends on
 * `passes` and `image_tokens`, so they must survive the trip.
 */
export function normalizeExtractUsage(raw: any): S1ExtractUsage {
  const inputTokens = raw?.input_tokens ?? raw?.inputTokens ?? 0;
  const outputTokens = raw?.output_tokens ?? raw?.outputTokens ?? 0;

  const usage: Record<string, number> = {
    inputTokens,
    outputTokens,
    input_tokens: inputTokens,
    output_tokens: outputTokens
  };

  const tokenPairs = [
    ['state_tokens', 'stateTokens'],
    ['image_tokens', 'imageTokens'],
    ['schema_tokens', 'schemaTokens']
  ] as const;
  for (const [snake, camel] of tokenPairs) {
    if (typeof raw?.[snake] === 'number') {
      usage[snake] = raw[snake];
      usage[camel] = raw[snake];
    }
  }
  if (typeof raw?.passes === 'number') {
    usage.passes = raw.passes;
  }

  return usage as unknown as S1ExtractUsage;
}
