/**
 * Example 7: Invoice extraction with Cloudflare Clairic
 *
 * Contract: @cf/cloudflare/clairic (input/output JSON Schemas fetched 2026-10-28)
 *
 * Run against Workers AI over the REST transport:
 *   export CLOUDFLARE_ACCOUNT_ID="..."
 *   export CLOUDFLARE_API_TOKEN="..."
 *   bun run examples/07-clairic-invoice-extraction.ts
 *
 * Inside a Worker, pass `env.AI` as `aiBinding` instead — same provider, same
 * normalizer, zero egress. With no credentials the example uses a deterministic
 * local stub so the request shape, span handling, and telemetry can be inspected
 * offline.
 */

import {
  S1Client,
  CLOUDFLARE_MODELS,
  extractText,
  extractNumber,
  extractDate,
  extractList,
  extractEstimate,
  type CloudflareAiBinding
} from '../src/index.js';

const INVOICE = `Acme Health Inc.
Invoice INV-1042
Issued March 4, total USD 4500.50
Line items: infusion pump (2 @ 1800.00), consumables (1 @ 900.50)
Tags: urgent, oncology`;

const stubBinding: CloudflareAiBinding = {
  async run(model, payload) {
    console.log(`[stub] ${model} <- ${Object.keys(payload.fields ?? {}).join(', ')}`);
    return {
      model: 'clairic',
      answers: {
        vendor: { type: 'text', value: 'Acme Health Inc.', p_null: 0.01, span: [0, 15] },
        invoiceNumber: { type: 'text', value: 'INV-1042', p_null: 0.01, span: [25, 33] },
        issuedDate: { type: 'date', value: '2026-03-04', p_null: 0.04, span: [42, 51] },
        total: {
          type: 'number',
          value: 4500.5,
          p_null: 0.01,
          span: [59, 66]
        },
        lineItems: {
          type: 'list',
          value: ['infusion pump', 'consumables'],
          p_null: 0.02,
          spans: [[82, 95], [106, 118]]
        },
        confidenceBand: {
          type: 'estimate',
          value: 0.93,
          p_null: 0.02,
          mean: 0.92,
          median: 0.93,
          p10: 0.88,
          p90: 0.97,
          p_below: 0.01,
          p_above: 0.02
        }
      },
      truncated: false,
      state_text: INVOICE,
      usage: {
        state_tokens: 96,
        image_tokens: 0,
        schema_tokens: 61,
        input_tokens: 157,
        output_tokens: 0,
        passes: 1
      }
    };
  }
};

async function main() {
  const apiToken = typeof process !== 'undefined' ? process.env.CLOUDFLARE_API_TOKEN : undefined;
  const accountId = typeof process !== 'undefined' ? process.env.CLOUDFLARE_ACCOUNT_ID : undefined;
  const useRest = Boolean(apiToken && accountId);

  const client = useRest
    ? new S1Client({
        provider: 'cloudflare',
        cloudflareApiToken: apiToken,
        cloudflareAccountId: accountId,
        // D1a: extract() requires an explicit Clairic model. Passing clef here
        // throws JevValidationError instead of silently billing Clairic.
        model: CLOUDFLARE_MODELS.CLAIRIC
      })
    : new S1Client({
        aiBinding: stubBinding,
        model: CLOUDFLARE_MODELS.CLAIRIC
      });

  console.log(useRest ? '\n[transport] Cloudflare REST' : '\n[transport] local stub (no credentials)');

  const res = await client.extract({
    state: INVOICE,
    referenceDate: '2026-01-01',
    fields: {
      vendor: extractText('Vendor organization name'),
      invoiceNumber: extractText('Invoice number'),
      issuedDate: extractDate('Invoice issue date'),
      total: extractNumber({ decimals: 2, unit: 'USD', instructions: 'Invoice total' }),
      lineItems: extractList('text', 'Purchased items'),
      confidenceBand: extractEstimate(0, 1, { step: 0.01, instructions: 'Extraction confidence' })
    },
    extractOptions: { returnStateText: true }
  });

  console.log('\n--- Extraction ---');
  console.log('vendor        ', res.answers.vendor.value, res.answers.vendor.span);
  console.log('invoiceNumber ', res.answers.invoiceNumber.value);
  console.log('issuedDate    ', res.answers.issuedDate.value);
  console.log('total         ', res.answers.total.value, res.answers.total.span);
  console.log('lineItems     ', res.answers.lineItems.value, res.answers.lineItems.spans);
  console.log(
    'confidence    ',
    res.answers.confidenceBand.value,
    'interval_80:', res.answers.confidenceBand.interval_80
  );

  // Spans are [start, end] tuples over the state (or state_text).
  const span = res.answers.vendor.span;
  if (span) {
    const [start, end] = span;
    console.log('source slice  ', JSON.stringify((res.state_text ?? '').slice(start, end)));
  }

  console.log('\n--- Telemetry ---');
  console.log('transport     ', res.transport);
  console.log('model         ', res.modelUsed);
  console.log('truncated     ', res.truncated);
  console.log('usage         ', res.usage);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
