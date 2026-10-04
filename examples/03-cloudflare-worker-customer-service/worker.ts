/**
 * Example 3: Cloudflare Workers AI Edge Ingestion & Routing Service
 *
 * Runs System-1 decisions inside Cloudflare's global edge network via env.AI binding.
 * Supports:
 *   - `@cf/cloudflare/clef-flash` (Default: 9B fast hot-path decision model, 38.8ms median)
 *   - `@cf/cloudflare/clef` (27B high-precision decision model, 64K context)
 *   - `typesafe/jev` (TypeSafe Jev partner model on Cloudflare Workers AI)
 *
 * Dev:
 *   bunx wrangler dev --port 8791
 *
 * Test endpoints:
 *   GET  http://127.0.0.1:8791/                   (Default Clef-Flash evaluation)
 *   GET  http://127.0.0.1:8791/?model=clef        (Clef 27B evaluation)
 *   GET  http://127.0.0.1:8791/?model=jev         (TypeSafe Jev evaluation)
 *   GET  http://127.0.0.1:8791/demo/jev           (Official TypeSafe Jev snippet demo)
 *   GET  http://127.0.0.1:8791/demo/clef          (Official Cloudflare Clef snippet demo)
 *   POST http://127.0.0.1:8791/                   (Custom ticket JSON)
 */

import {
  S1Client,
  noul,
  choice,
  score,
  CLOUDFLARE_MODELS,
  type CloudflareDecisionModel
} from '../../src/index.js';

import {
  customerServiceQuestions,
  sampleTickets,
  type CustomerTicket
} from '../shared/customer-service-schema.js';

export interface Env {
  AI: any; // Cloudflare Workers AI binding
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const modelParam = url.searchParams.get('model') || 'clef-flash';

    // Map shorthand names to canonical catalog model identifiers
    let selectedModel: CloudflareDecisionModel = CLOUDFLARE_MODELS.CLEF_FLASH;
    if (modelParam === 'clef' || modelParam === CLOUDFLARE_MODELS.CLEF) {
      selectedModel = CLOUDFLARE_MODELS.CLEF;
    } else if (modelParam === 'jev' || modelParam === CLOUDFLARE_MODELS.JEV || modelParam === 'typesafe/jev') {
      selectedModel = CLOUDFLARE_MODELS.JEV;
    } else if (modelParam === 'clef-flash' || modelParam === CLOUDFLARE_MODELS.CLEF_FLASH) {
      selectedModel = CLOUDFLARE_MODELS.CLEF_FLASH;
    } else {
      selectedModel = modelParam;
    }

    // Initialize edge client bridging directly into Workers AI with fallback resilience
    const client = new S1Client({
      aiBinding: env.AI,
      model: selectedModel,
      fallbackToMock: true // Degrade gracefully if AI binding encounters quota or model errors
    });

    // 1. Official TypeSafe Jev Inspiration Demo Endpoint
    if (url.pathname === '/demo/jev') {
      const jevClient = new S1Client({
        aiBinding: env.AI,
        model: CLOUDFLARE_MODELS.JEV,
        fallbackToMock: true
      });

      const decision = await jevClient.decide({
        state: 'Help! My payouts have been failing for 3 days.',
        questions: {
          is_urgent: noul('Does this convey urgency?', {
            true: 'Explicitly time-sensitive',
            false: 'No urgency expressed'
          }),
          department: choice('Which team should handle this?', {
            billing: 'Payments, invoicing, refunds',
            technical: 'Bugs, outages, integrations',
            sales: 'Pricing, upgrades, new accounts'
          }),
          frustration: score('How frustrated is the customer?', ['Calm', 'Frustrated', 'Very angry'])
        }
      });

      return Response.json({
        demo: 'Official TypeSafe Jev on Cloudflare Workers AI Snippet',
        modelTarget: CLOUDFLARE_MODELS.JEV,
        state: 'Help! My payouts have been failing for 3 days.',
        decision
      });
    }

    // 2. Official Cloudflare Clef Inspiration Demo Endpoint
    if (url.pathname === '/demo/clef') {
      const clefClient = new S1Client({
        aiBinding: env.AI,
        model: CLOUDFLARE_MODELS.CLEF,
        fallbackToMock: true
      });

      const decision = await clefClient.decide({
        state: 'Checkout has been failing for every customer for the last hour.',
        questions: {
          urgent: noul('Is this support request urgent?'),
          team: choice('Which team should handle this request?', {
            billing: 'Payments, invoices, and refunds',
            technical: 'Outages, errors, and configuration',
            sales: 'Plans and upgrades'
          })
        }
      });

      return Response.json({
        demo: 'Official Cloudflare Clef (@cf/cloudflare/clef) Snippet',
        modelTarget: CLOUDFLARE_MODELS.CLEF,
        state: 'Checkout has been failing for every customer for the last hour.',
        decision
      });
    }

    // 3. POST Endpoint: Route custom incoming ticket
    if (request.method === 'POST') {
      try {
        const ticket: CustomerTicket = await request.json();
        const decision = await client.decide({
          state: ticket,
          questions: customerServiceQuestions,
          model: selectedModel
        });

        return Response.json({
          status: 'success',
          ticketId: ticket.ticketId,
          routing: decision.answers,
          telemetry: {
            latencyMs: decision.latencyMs,
            provider: decision.providerUsed,
            model: decision.modelUsed,
            isFallback: decision.isFallback
          }
        });
      } catch (err: any) {
        return Response.json(
          { status: 'error', message: err?.message || 'Invalid ticket request' },
          { status: 400 }
        );
      }
    }

    // 4. Default GET Endpoint: Evaluate default enterprise ticket with selected model
    const defaultTicket = sampleTickets.doubleBillingAngry!;
    const decision = await client.decide({
      state: defaultTicket,
      questions: customerServiceQuestions,
      model: selectedModel
    });

    return Response.json({
      message: 'S1SDK Cloudflare Workers AI Customer Service Router',
      selectedModel,
      demoTicket: defaultTicket,
      routingDecision: decision
    });
  }
};
