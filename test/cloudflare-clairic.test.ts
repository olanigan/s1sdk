import { describe, it, expect, vi } from 'vitest';
import {
  S1Client,
  JevClient,
  CLOUDFLARE_MODELS,
  S1_CLOUDFLARE_MODELS,
  normalizeCloudflareModel,
  sanitizeFieldsForCloudflare,
  CloudflareWorkerProvider,
  extractText,
  extractNumber,
  extractDate,
  extractTime,
  extractDateTime,
  extractDuration,
  extractList,
  extractEstimate,
  extractForecast,
  noul,
  choice,
  JevProviderError,
  type CloudflareAiBinding
} from '../src/index.js';

describe('Cloudflare Clairic S1 Extraction Model (@cf/cloudflare/clairic)', () => {
  // ==========================================
  // 1. Model Registry & Constants
  // ==========================================
  describe('Model Registry & Constants', () => {
    it('defines CLOUDFLARE_MODELS.CLAIRIC as @cf/cloudflare/clairic', () => {
      expect(CLOUDFLARE_MODELS.CLAIRIC).toBe('@cf/cloudflare/clairic');
    });

    it('defines S1_CLOUDFLARE_MODELS.CLAIRIC alias consistently', () => {
      expect(S1_CLOUDFLARE_MODELS.CLAIRIC).toBe('@cf/cloudflare/clairic');
    });
  });

  // ==========================================
  // 2. Model Normalization
  // ==========================================
  describe('Model Normalization', () => {
    it('normalizes "clairic" to @cf/cloudflare/clairic with payloadModel: "clairic"', () => {
      const normalized = normalizeCloudflareModel('clairic');
      expect(normalized).toEqual({
        bindingModel: '@cf/cloudflare/clairic',
        payloadModel: 'clairic'
      });
    });

    it('normalizes "@cf/cloudflare/clairic" to @cf/cloudflare/clairic with payloadModel: "clairic"', () => {
      const normalized = normalizeCloudflareModel('@cf/cloudflare/clairic');
      expect(normalized).toEqual({
        bindingModel: '@cf/cloudflare/clairic',
        payloadModel: 'clairic'
      });
    });

    it('preserves existing normalization for decision models (clef, clef-flash, jev)', () => {
      expect(normalizeCloudflareModel('clef-flash')).toEqual({
        bindingModel: '@cf/cloudflare/clef-flash',
        payloadModel: 'clef-flash'
      });
      expect(normalizeCloudflareModel('@cf/cloudflare/clef')).toEqual({
        bindingModel: '@cf/cloudflare/clef',
        payloadModel: 'clef'
      });
      expect(normalizeCloudflareModel('typesafe/jev')).toEqual({
        bindingModel: 'typesafe/jev',
        payloadModel: undefined
      });
    });
  });

  // ==========================================
  // 3. Extraction Field Helper Constructors
  // ==========================================
  describe('Extraction Field Helper Constructors', () => {
    it('creates extractText field definition', () => {
      const field = extractText('Extract customer full name');
      expect(field).toEqual({
        type: 'text',
        instructions: 'Extract customer full name'
      });
      expect(Object.isFrozen(field)).toBe(true);

      const fieldNoPrompt = extractText();
      expect(fieldNoPrompt).toEqual({ type: 'text' });
    });

    it('creates extractNumber field definition with options and shorthand', () => {
      const fieldWithOpts = extractNumber({
        decimals: 2,
        unit: 'USD',
        instructions: 'Invoice total amount'
      });
      expect(fieldWithOpts).toEqual({
        type: 'number',
        decimals: 2,
        unit: 'USD',
        instructions: 'Invoice total amount'
      });

      const fieldShorthand = extractNumber('Age of user');
      expect(fieldShorthand).toEqual({
        type: 'number',
        instructions: 'Age of user'
      });
    });

    it('creates extractDate, extractTime, extractDateTime, and extractDuration', () => {
      expect(extractDate('Due date')).toEqual({ type: 'date', instructions: 'Due date' });
      expect(extractTime('Meeting time')).toEqual({ type: 'time', instructions: 'Meeting time' });
      expect(extractDateTime('Timestamp')).toEqual({ type: 'datetime', instructions: 'Timestamp' });
      expect(extractDuration('SLA duration')).toEqual({ type: 'duration', instructions: 'SLA duration' });
    });

    it('creates extractList with itemType and instructions', () => {
      const listField = extractList('text', 'Line items');
      expect(listField).toEqual({
        type: 'list',
        itemType: 'text',
        instructions: 'Line items'
      });

      const numberList = extractList('number');
      expect(numberList).toEqual({
        type: 'list',
        itemType: 'number'
      });
    });

    it('creates extractEstimate with bounds and step', () => {
      const estimate = extractEstimate(0, 100, 5, 'Confidence percentage estimate');
      expect(estimate).toEqual({
        type: 'estimate',
        min: 0,
        max: 100,
        step: 5,
        instructions: 'Confidence percentage estimate'
      });
    });

    it('creates extractForecast with bounds, horizon and interval', () => {
      const forecast = extractForecast(0, 10_000, {
        horizon: 30,
        interval: 'day',
        instructions: 'Revenue forecast for next month'
      });
      expect(forecast).toEqual({
        type: 'forecast',
        min: 0,
        max: 10_000,
        horizon: 30,
        interval: 'day',
        instructions: 'Revenue forecast for next month'
      });

      const objectForm = extractForecast({ min: 0, max: 10, horizon: 3 });
      expect(objectForm).toEqual({ type: 'forecast', min: 0, max: 10, horizon: 3 });
    });
  });

  // ==========================================
  // 4. Schema Sanitization for Cloudflare Workers AI
  // ==========================================
  describe('Schema Sanitization for Cloudflare Workers AI', () => {
    it('sanitizes fields to match Cloudflare Clairic expectations', () => {
      const fields = {
        name: extractText('Customer name'),
        amount: extractNumber({ decimals: 2, unit: 'EUR', instructions: 'Total payment' }),
        items: extractList('text', 'Purchased items'),
        riskScore: extractEstimate(0, 10, 1, 'Risk rating')
      };

      const sanitized = sanitizeFieldsForCloudflare(fields);
      expect(sanitized).toEqual({
        name: {
          type: 'text',
          instructions: 'Customer name'
        },
        amount: {
          type: 'number',
          decimals: 2,
          unit: 'EUR',
          instructions: 'Total payment'
        },
        items: {
          type: 'list',
          items: 'text',
          instructions: 'Purchased items'
        },
        riskScore: {
          type: 'estimate',
          min: 0,
          max: 10,
          step: 1,
          instructions: 'Risk rating'
        }
      });
    });
  });

  // ==========================================
  // 5. CloudflareWorkerProvider Extraction Execution
  // ==========================================
  describe('CloudflareWorkerProvider Extraction Execution', () => {
    it('executes extraction request via aiBinding.run(@cf/cloudflare/clairic, ...)', async () => {
      let capturedModel = '';
      let capturedPayload: any = null;

      const fakeBinding: CloudflareAiBinding = {
        run: async (model: string, payload: any) => {
          capturedModel = model;
          capturedPayload = payload;
          return {
            answers: {
              organization: {
                value: 'Acme Health Inc.',
                confidence: 0.99,
                p_null: 0.01,
                span: [10, 26]
              },
              invoiceTotal: {
                value: 4500.5,
                confidence: 0.96,
                p_null: 0.04,
                median: 4500.5,
                interval_80: [4400.0, 4600.0]
              },
              tags: {
                value: ['urgent', 'oncology'],
                confidence: 0.92,
                p_null: 0.08
              },
              missingPoNumber: {
                value: null,
                confidence: 0.02,
                p_null: 0.98
              }
            },
            usage: {
              input_tokens: 150,
              output_tokens: 0
            }
          };
        }
      };

      const provider = new CloudflareWorkerProvider(fakeBinding, CLOUDFLARE_MODELS.CLAIRIC);
      const res = await provider.extract({
        state: 'Invoice from Acme Health Inc. for total $4500.50',
        fields: {
          organization: extractText('Vendor organization name'),
          invoiceTotal: extractNumber({ decimals: 2, unit: 'USD' }),
          tags: extractList('text', 'Associated invoice tags'),
          missingPoNumber: extractText('PO Number')
        }
      });

      expect(capturedModel).toBe('@cf/cloudflare/clairic');
      expect(capturedPayload.model).toBe('clairic');
      expect(capturedPayload.state).toBe('Invoice from Acme Health Inc. for total $4500.50');
      expect(capturedPayload.fields.organization.type).toBe('text');
      expect(capturedPayload.fields.invoiceTotal.unit).toBe('USD');

      // Answer assertions
      expect(res.answers.organization.value).toBe('Acme Health Inc.');
      expect(res.answers.organization.confidence).toBe(0.99);
      expect(res.answers.organization.p_null).toBe(0.01);
      expect(res.answers.organization.span).toEqual([10, 26]);

      expect(res.answers.invoiceTotal.value).toBe(4500.5);
      expect(res.answers.invoiceTotal.median).toBe(4500.5);
      expect(res.answers.invoiceTotal.interval_80).toEqual([4400.0, 4600.0]);

      expect(res.answers.tags.value).toEqual(['urgent', 'oncology']);
      expect(res.answers.missingPoNumber.value).toBeNull();
      expect(res.answers.missingPoNumber.p_null).toBe(0.98);

      // Billing & metadata assertions: zero output tokens
      expect(res.modelUsed).toBe('@cf/cloudflare/clairic');
      expect(res.usage?.inputTokens).toBe(150);
      expect(res.usage?.outputTokens).toBe(0);
      expect(res.latencyMs).toBeGreaterThan(0);
      expect(res.isFallback).toBe(false);
    });

    it('forwards multimodal image inputs for extraction', async () => {
      let capturedPayload: any = null;

      const fakeBinding: CloudflareAiBinding = {
        run: async (_model: string, payload: any) => {
          capturedPayload = payload;
          return {
            answers: {
              licensePlate: {
                value: '7XYZ123',
                confidence: 0.97,
                p_null: 0.03
              }
            }
          };
        }
      };

      const provider = new CloudflareWorkerProvider(fakeBinding, CLOUDFLARE_MODELS.CLAIRIC);
      await provider.extract({
        state: 'Vehicle registration review',
        fields: {
          licensePlate: extractText('License plate number')
        },
        images: ['data:image/jpeg;base64,abc123456']
      });

      expect(capturedPayload.images).toBeDefined();
      expect(capturedPayload.images).toEqual(['data:image/jpeg;base64,abc123456']);
    });

    it('rejects fields-only requests passed to provider.execute()', async () => {
      const fakeBinding: CloudflareAiBinding = {
        run: async () => ({ answers: { city: { value: 'Austin' } } })
      };

      const provider = new CloudflareWorkerProvider(fakeBinding, CLOUDFLARE_MODELS.CLAIRIC);
      await expect(
        provider.execute({
          state: 'Patient located in Austin, TX',
          fields: { city: extractText() }
        } as any)
      ).rejects.toThrow('execute() requires a "questions" object');
    });

    it('handles binding error gracefully and throws JevProviderError', async () => {
      const fakeBinding: CloudflareAiBinding = {
        run: async () => {
          throw new Error('Internal Workers AI inference timeout');
        }
      };

      const provider = new CloudflareWorkerProvider(fakeBinding, CLOUDFLARE_MODELS.CLAIRIC);
      await expect(
        provider.extract({
          state: 'test',
          fields: { name: extractText() }
        })
      ).rejects.toThrow('Cloudflare Workers AI extraction failed');
    });

    it('handles explicit result.error envelope returned by Cloudflare', async () => {
      const fakeBinding: CloudflareAiBinding = {
        run: async () => ({
          error: 'Model unavailable on regional edge'
        })
      };

      const provider = new CloudflareWorkerProvider(fakeBinding, CLOUDFLARE_MODELS.CLAIRIC);
      await expect(
        provider.extract({
          state: 'test',
          fields: { name: extractText() }
        })
      ).rejects.toThrow('Cloudflare Workers AI returned error: Model unavailable on regional edge');
    });
  });

  // ==========================================
  // 6. Provider Backward Compatibility for Decision Models
  // ==========================================
  describe('Backward Compatibility for Decision Models', () => {
    it('preserves decision model outputs and any returned span or p_null metadata', async () => {
      const fakeBinding: CloudflareAiBinding = {
        run: async () => ({
          model: 'clef-flash',
          answers: {
            is_malicious: {
              type: 'noul',
              noul: 0.94,
              p_null: 0.06,
              span: { start: 0, end: 12 }
            },
            category: {
              type: 'choice',
              choice: 'phishing',
              confidence: 0.98,
              probabilities: { phishing: 0.98, benign: 0.02 }
            }
          },
          usage: { input_tokens: 35, output_tokens: 0 }
        })
      };

      const provider = new CloudflareWorkerProvider(fakeBinding, CLOUDFLARE_MODELS.CLEF_FLASH);
      const res = await provider.execute({
        state: 'click here immediately to verify account',
        questions: {
          is_malicious: noul('Is this malicious?'),
          category: choice('Select category', { phishing: 'Phishing', benign: 'Benign' })
        }
      });

      expect(res.answers.is_malicious.noul).toBe(0.94);
      expect((res.answers.is_malicious as any).p_null).toBe(0.06);
      expect((res.answers.is_malicious as any).span).toEqual({ start: 0, end: 12 });
      expect(res.answers.category.choice).toBe('phishing');
      expect(res.modelUsed).toBe('@cf/cloudflare/clef-flash');
    });
  });

  // ==========================================
  // 7. Client Ergonomics (S1Client & JevClient)
  // ==========================================
  describe('Client Ergonomics (S1Client & JevClient)', () => {
    it('supports client.extract(state, fields, options) positional syntax', async () => {
      const fakeBinding: CloudflareAiBinding = {
        run: async () => ({
          answers: {
            diagnosis: {
              value: 'Hypertension',
              confidence: 0.94,
              p_null: 0.06,
              span: [20, 32]
            }
          }
        })
      };

      const client = new S1Client({ aiBinding: fakeBinding, model: CLOUDFLARE_MODELS.CLAIRIC });
      const res = await client.extract(
        'Patient presents with Hypertension and elevated BP',
        {
          diagnosis: extractText('Primary diagnosis')
        },
        { timeoutMs: 5000 }
      );

      expect(res.answers.diagnosis.value).toBe('Hypertension');
      expect(res.answers.diagnosis.confidence).toBe(0.94);
      expect(res.answers.diagnosis.span).toEqual([20, 32]);
    });

    it('supports client.extract(requestEnvelope, options) object syntax', async () => {
      const fakeBinding: CloudflareAiBinding = {
        run: async () => ({
          answers: {
            score: {
              value: 88,
              confidence: 0.91,
              p_null: 0.09,
              median: 88
            }
          }
        })
      };

      const client = new S1Client({ aiBinding: fakeBinding, model: CLOUDFLARE_MODELS.CLAIRIC });
      const res = await client.extract({
        state: 'Assessment grade: 88%',
        fields: {
          score: extractNumber({ instructions: 'Grade' })
        }
      });

      expect(res.answers.score.value).toBe(88);
      expect(res.answers.score.median).toBe(88);
    });

    it('works identically via JevClient alias', async () => {
      const fakeBinding: CloudflareAiBinding = {
        run: async () => ({
          answers: {
            status: { value: 'resolved', confidence: 0.99, p_null: 0.01 }
          }
        })
      };

      const client = new JevClient({ aiBinding: fakeBinding, model: CLOUDFLARE_MODELS.CLAIRIC });
      const res = await client.extract('Incident resolved successfully', {
        status: extractText('Incident resolution status')
      });

      expect(res.answers.status.value).toBe('resolved');
      expect(res.answers.status.confidence).toBe(0.99);
    });

    it('throws descriptive error if active provider does not support extraction', async () => {
      // Mock provider without extract method
      const client = new S1Client({
        provider: 'homestead',
        endpoint: 'http://127.0.0.1:9999'
      });

      await expect(
        client.extract('some text', { name: extractText() })
      ).rejects.toThrow('Active provider "homestead" does not support structured extraction');
    });
  });
});

// ==========================================
// 8. Contract fixtures (live schemas, fetched 2026-10-28)
// ==========================================
import { readFileSync } from 'node:fs';
import { JevValidationError } from '../src/index.js';

const readFixture = (name: string): any =>
  JSON.parse(readFileSync(new URL(`./fixtures/contracts/${name}`, import.meta.url), 'utf8'));

describe('Clairic contract fixtures', () => {
  const inputSchema = readFixture('clairic-input.json');
  const outputSchema = readFixture('clairic-output.json');

  it('pins the fixture to the schema version the SDK implements', () => {
    expect(inputSchema.required).toEqual(expect.arrayContaining(['model', 'fields']));
    expect(inputSchema.properties.model.pattern).toBe('^(clairic|@cf/cloudflare/clairic)$');
    expect(inputSchema.properties.images.maxItems).toBe(4);
    expect(outputSchema.required).toEqual(expect.arrayContaining(['model', 'answers', 'truncated', 'usage']));
  });

  it('emits `items` (not `item_type`) for list fields, as the schema requires', () => {
    const sanitized = sanitizeFieldsForCloudflare({
      tags: extractList('text', 'Tags')
    } as any);
    expect(sanitized.tags.items).toBe('text');
    expect(sanitized.tags.item_type).toBeUndefined();
    expect(inputSchema.properties.fields.additionalProperties.properties.items.enum).toContain('text');
  });

  it('emits every supported field option with schema key names', () => {
    const sanitized = sanitizeFieldsForCloudflare({
      qty: extractNumber({ integer: true, nullThreshold: 0.8 }),
      when: extractDuration(undefined),
      scores: extractList('number', 'Scores', { integer: true }),
      est: extractEstimate(0, 100, { step: 5, scale: 'log', nullThreshold: 0.6 }),
      fc: extractForecast({
        min: 0,
        max: 1000,
        horizon: 12,
        interval: 'month',
        step: 'month',
        scale: 'linear'
      })
    } as any);

    expect(sanitized.qty).toEqual({ type: 'number', integer: true, null_threshold: 0.8 });
    expect(sanitized.scores).toEqual({ type: 'list', items: 'number', instructions: 'Scores', integer: true });
    expect(sanitized.est).toEqual({
      type: 'estimate',
      min: 0,
      max: 100,
      step: 5,
      scale: 'log',
      null_threshold: 0.6
    });
    expect(sanitized.fc).toEqual({
      type: 'forecast',
      min: 0,
      max: 1000,
      horizon: 12,
      interval: 'month',
      step: 'month',
      scale: 'linear'
    });
    for (const key of Object.keys(sanitized)) {
      expect(inputSchema.properties.fields.additionalProperties.required).toEqual(['type']);
    }
  });

  it('maps span arrays, spans, p10/p90, truncated and full usage from a schema-shaped response', async () => {
    const fakeBinding: CloudflareAiBinding = {
      run: async () => ({
        model: 'clairic',
        answers: {
          vendor: {
            type: 'text',
            value: 'Acme Health Inc.',
            p_null: 0.01,
            confidence: 0.99,
            span: [12, 28]
          },
          tags: {
            type: 'list',
            value: ['urgent', 'oncology'],
            p_null: 0.05,
            confidence: 0.95,
            spans: [[0, 6], [8, 16]]
          },
          total: {
            type: 'estimate',
            value: 4500.5,
            p_null: 0.02,
            confidence: 0.98,
            mean: 4499.8,
            median: 4500.5,
            p10: 4400,
            p90: 4600,
            p_below: 0.01,
            p_above: 0.02
          },
          po: {
            type: 'text',
            value: null,
            guess: 'PO-1042',
            p_null: 0.91,
            confidence: 0.09
          }
        },
        truncated: true,
        state_text: '…the state that spans index into…',
        usage: {
          state_tokens: 120,
          image_tokens: 8,
          schema_tokens: 44,
          input_tokens: 172,
          output_tokens: 0,
          passes: 3
        }
      })
    };

    const provider = new CloudflareWorkerProvider(fakeBinding, CLOUDFLARE_MODELS.CLAIRIC);
    const res = await provider.extract({
      state: 'Invoice from Acme Health Inc.',
      fields: {
        vendor: extractText(),
        tags: extractList('text'),
        total: extractEstimate(0, 10_000),
        po: extractText()
      }
    });

    expect(res.answers.vendor.span).toEqual([12, 28]);
    expect(res.answers.tags.spans).toEqual([[0, 6], [8, 16]]);
    expect(res.answers.total.interval_80).toEqual([4400, 4600]);
    expect(res.answers.total.p10).toBe(4400);
    expect(res.answers.total.p90).toBe(4600);
    expect(res.answers.total.p_below).toBe(0.01);
    expect(res.answers.total.p_above).toBe(0.02);
    expect(res.answers.po.value).toBeNull();
    expect(res.answers.po.guess).toBe('PO-1042');

    expect(res.truncated).toBe(true);
    expect(res.state_text).toBe('…the state that spans index into…');
    expect(res.usage?.passes).toBe(3);
    expect(res.usage?.state_tokens).toBe(120);
    expect(res.usage?.image_tokens).toBe(8);
    expect(res.usage?.schema_tokens).toBe(44);
    expect(res.usage?.stateTokens).toBe(120);
  });

  it('forwards reference_date and options.include_quantiles/return_state_text', async () => {
    let captured: any = null;
    const provider = new CloudflareWorkerProvider(
      {
        run: async (_model, payload) => {
          captured = payload;
          return { answers: {}, truncated: false, usage: { input_tokens: 1, output_tokens: 0 } };
        }
      },
      CLOUDFLARE_MODELS.CLAIRIC
    );

    await provider.extract({
      state: 'March 4 invoice',
      fields: { date: extractDate() },
      referenceDate: '2026-01-01',
      extractOptions: { includeQuantiles: true, returnStateText: true }
    });

    expect(captured.reference_date).toBe('2026-01-01');
    expect(captured.options).toEqual({ include_quantiles: true, return_state_text: true });
  });

  it('requires an explicit Clairic model (D1a) instead of swapping clef', async () => {
    const provider = new CloudflareWorkerProvider(
      { run: async () => ({ answers: {} }) },
      CLOUDFLARE_MODELS.CLEF_FLASH
    );
    await expect(
      provider.extract({ state: 'x', fields: { a: extractText() } })
    ).rejects.toBeInstanceOf(JevValidationError);

    const explicit = new CloudflareWorkerProvider(
      { run: async () => ({ answers: {}, truncated: false, usage: { input_tokens: 1, output_tokens: 0 } }) },
      CLOUDFLARE_MODELS.CLAIRIC
    );
    await expect(
      explicit.extract({ state: 'x', fields: { a: extractText() } })
    ).resolves.toMatchObject({ truncated: false });
  });

  it('rejects media that violates Clairic caps before dispatch (A11)', async () => {
    let calls = 0;
    const provider = new CloudflareWorkerProvider(
      {
        run: async () => {
          calls++;
          return { answers: {}, truncated: false, usage: { input_tokens: 1, output_tokens: 0 } };
        }
      },
      CLOUDFLARE_MODELS.CLAIRIC
    );
    const tiny = 'data:image/png;base64,aGVsbG8=';

    await expect(
      provider.extract({ state: 'x', fields: { a: extractText() }, images: [tiny, tiny, tiny, tiny, tiny] })
    ).rejects.toThrow('at most 4 images');

    await expect(
      provider.extract({ state: 'x', fields: { a: extractText() }, images: ['https://example.com/a.png'] })
    ).rejects.toThrow('base64 data URL');

    const oversize = `data:image/png;base64,${'A'.repeat(6 * 1024 * 1024)}`;
    await expect(
      provider.extract({ state: 'x', fields: { a: extractText() }, images: [oversize] })
    ).rejects.toThrow('per-image limit');

    expect(calls).toBe(0);
  });
});
