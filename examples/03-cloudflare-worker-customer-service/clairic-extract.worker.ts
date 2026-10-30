/**
 * Clairic extraction smoke worker (DE-115, Phase A — live binding validation)
 *
 * Purpose: exercise `client.extract()` through a REAL Cloudflare Workers AI
 * `env.AI` binding instead of a stub. This is the only path that can validate
 * in-process binding execution; the REST transport needs no worker.
 *
 * Dev (remote AI, local worker — no deploy):
 *   set -a && . ./.env && set +a
 *   bunx wrangler@4 dev --config examples/03-cloudflare-worker-customer-service/wrangler.clairic.jsonc --port 8791
 *
 * Endpoints:
 *   GET  http://127.0.0.1:8791/        Invoice extraction (spans, list, estimate, usage)
 *   GET  http://127.0.0.1:8791/health  Binding presence + model wiring
 *   POST http://127.0.0.1:8791/        { state, fields, referenceDate?, model? }
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
} from '../../src/index.js';

export interface Env {
  AI: CloudflareAiBinding;
}

const INVOICE = `Acme Health Inc.
Invoice INV-1042
Issued March 4, total USD 4500.50
Line items: infusion pump (2 @ 1800.00), consumables (1 @ 900.50)
Tags: urgent, oncology`;

const INVOICE_FIELDS = {
  vendor: extractText('Vendor organization name'),
  invoiceNumber: extractText('Invoice number'),
  issuedDate: extractDate('Invoice issue date'),
  total: extractNumber({ decimals: 2, unit: 'USD', instructions: 'Invoice total' }),
  lineItems: extractList('text', 'Purchased items'),
  confidenceBand: extractEstimate(0, 1, { step: 0.01, instructions: 'Extraction confidence' })
} as const;

function buildClient(env: Env, model?: string): S1Client {
  return new S1Client({
    aiBinding: env.AI,
    model: model ?? CLOUDFLARE_MODELS.CLAIRIC
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({
        ok: typeof env?.AI?.run === 'function',
        binding: 'env.AI',
        clairic: CLOUDFLARE_MODELS.CLAIRIC,
        remote: request.headers.get('cf-ray') ? 'edge' : 'dev'
      });
    }

    const started = Date.now();

    try {
      if (request.method === 'POST') {
        const body: any = await request.json();
        const client = buildClient(env, body.model);
        const res = await client.extract({
          state: body.state,
          referenceDate: body.referenceDate,
          fields: body.fields ?? INVOICE_FIELDS
        });
        return Response.json({
          status: 'success',
          mode: 'binding',
          wallMs: Date.now() - started,
          result: res
        });
      }

      const client = buildClient(env);
      const res = await client.extract({
        state: INVOICE,
        referenceDate: '2026-01-01',
        fields: INVOICE_FIELDS,
        extractOptions: { returnStateText: true }
      });

      const span = res.answers.vendor?.span;
      return Response.json({
        status: 'success',
        mode: 'binding',
        wallMs: Date.now() - started,
        modelUsed: res.modelUsed,
        providerUsed: res.providerUsed,
        latencyMs: res.latencyMs,
        truncated: res.truncated,
        usage: res.usage,
        answers: res.answers,
        spanSlice:
          span && res.state_text ? res.state_text.slice(span[0], span[1]) : undefined
      });
    } catch (err: any) {
      return Response.json(
        {
          status: 'error',
          mode: 'binding',
          wallMs: Date.now() - started,
          code: err?.code ?? err?.name,
          message: err?.message ?? String(err)
        },
        { status: 502 }
      );
    }
  }
};
