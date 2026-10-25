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

    it('creates extractForecast with horizon', () => {
      const forecast = extractForecast('30d', 'Revenue forecast for next month');
      expect(forecast).toEqual({
        type: 'forecast',
        horizon: '30d',
        instructions: 'Revenue forecast for next month'
      });
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
          item_type: 'text',
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
                span: { start: 10, end: 26 }
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

      const provider = new CloudflareWorkerProvider(fakeBinding);
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
      expect(res.answers.organization.span).toEqual({ start: 10, end: 26 });

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

      const provider = new CloudflareWorkerProvider(fakeBinding);
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

    it('transparently executes extraction when passed via provider.execute() with fields', async () => {
      const fakeBinding: CloudflareAiBinding = {
        run: async () => ({
          answers: {
            city: { value: 'Austin', confidence: 0.95, p_null: 0.05 }
          }
        })
      };

      const provider = new CloudflareWorkerProvider(fakeBinding);
      const res = await provider.execute({
        state: 'Patient located in Austin, TX',
        fields: { city: extractText() }
      } as any);

      expect(res.answers.city.value).toBe('Austin');
      expect(res.answers.city.confidence).toBe(0.95);
    });

    it('handles binding error gracefully and throws JevProviderError', async () => {
      const fakeBinding: CloudflareAiBinding = {
        run: async () => {
          throw new Error('Internal Workers AI inference timeout');
        }
      };

      const provider = new CloudflareWorkerProvider(fakeBinding);
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

      const provider = new CloudflareWorkerProvider(fakeBinding);
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
              span: { start: 20, end: 32 }
            }
          }
        })
      };

      const client = new S1Client({ aiBinding: fakeBinding });
      const res = await client.extract(
        'Patient presents with Hypertension and elevated BP',
        {
          diagnosis: extractText('Primary diagnosis')
        },
        { timeoutMs: 5000 }
      );

      expect(res.answers.diagnosis.value).toBe('Hypertension');
      expect(res.answers.diagnosis.confidence).toBe(0.94);
      expect(res.answers.diagnosis.span).toEqual({ start: 20, end: 32 });
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

      const client = new S1Client({ aiBinding: fakeBinding });
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

      const client = new JevClient({ aiBinding: fakeBinding });
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
