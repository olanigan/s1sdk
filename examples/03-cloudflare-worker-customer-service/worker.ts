/**
 * Example 3: Cloudflare Workers AI Edge Ingestion & Routing Service
 *
 * Runs System-1 decisions inside Cloudflare's global edge network via env.AI binding.
 * Sub-15ms roundtrip execution with zero external network handshakes.
 *
 * Dev:
 *   npx wrangler dev
 *
 * Deploy:
 *   npx wrangler deploy
 */

import { S1Client } from '../../src/index.js';
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

    // Initialize edge client bridging directly into Workers AI
    const client = new S1Client({
      aiBinding: env.AI,
      model: '@cf/typesafe/jev',
      fallbackToMock: true // Degrade gracefully if AI binding is absent (e.g. mock test runner)
    });

    if (request.method === 'POST') {
      try {
        const ticket: CustomerTicket = await request.json();
        const decision = await client.decide({
          state: ticket,
          questions: customerServiceQuestions
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

    // Default GET endpoint: run demo evaluation on sample enterprise ticket
    const defaultTicket = sampleTickets.doubleBillingAngry!;
    const decision = await client.decide({
      state: defaultTicket,
      questions: customerServiceQuestions
    });

    return Response.json({
      message: 'S1SDK Cloudflare Workers AI Customer Service Router',
      demoTicket: defaultTicket,
      routingDecision: decision
    });
  }
};
