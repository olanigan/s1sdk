/**
 * Shared Customer Service Routing Schema & Primitives
 * Wire-compatible across TypeSafe AI, OpenRouter, Cloudflare Workers AI, and MockEngine.
 */

import {
  noul,
  choice,
  score,
  type JevDecisionResponse
} from '../../src/index.js';

export interface CustomerTicket {
  readonly ticketId: string;
  readonly customerId: string;
  readonly customerTier: 'free' | 'growth' | 'enterprise';
  readonly accountAgeDays: number;
  readonly lastPaymentStatus: 'paid' | 'failed' | 'disputed_double_charge';
  readonly subject: string;
  readonly message: string;
}

/**
 * Canonical System-1 questions evaluated in a single forward pass (< 25ms)
 */
export const customerServiceQuestions = {
  // 1. noul: Binary risk / escalation likelihood [0.0, 1.0]
  is_escalation_risk: noul(
    'Determine if customer is furious, threatening immediate churn, or demanding executive escalation'
  ),

  // 2. choice: Discrete department routing with explicit criteria
  target_department: choice(
    'Route customer ticket to the most appropriate operational department',
    {
      billing: 'Invoice disputes, double charges, refunds, credit adjustments, or payment processing',
      technical_support: 'API errors, 500 downtime, SDK bugs, or integration defects',
      retention: 'Cancellation threats, competitor switches, downgrade requests, or SLA penalty disputes',
      general_inquiry: 'Documentation help, receipt downloads, account settings, or feature questions'
    } as const
  ),

  // 3. score: Ordinal priority tier [1..5]
  priority_level: score(
    'Assess operational priority from level 1 to level 5',
    [
      'Level 1: Routine inquiry or documentation question',
      'Level 2: Minor account or configuration request',
      'Level 3: Normal business operations support',
      'Level 4: High operational impact or degraded service',
      'Level 5: Critical emergency, financial dispute, or immediate churn threat'
    ]
  )
};

export type CustomerServiceQuestions = typeof customerServiceQuestions;

/**
 * Benchmark & test fixtures representing real-world customer interactions
 */
export const sampleTickets: Record<string, CustomerTicket> = {
  doubleBillingAngry: {
    ticketId: 'TCK-9481',
    customerId: 'CUST-ENT-402',
    customerTier: 'enterprise',
    accountAgeDays: 480,
    lastPaymentStatus: 'disputed_double_charge',
    subject: 'UNAUTHORIZED DOUBLE CHARGE - IMMEDIATE REFUND REQUIRED',
    message:
      'We noticed two identical charges of $4,800 on our corporate Amex this morning. Our CFO has flagged this as unauthorized and our legal team is preparing a dispute. If this is not resolved today we are cancelling our annual contract.'
  },

  apiOutageUrgent: {
    ticketId: 'TCK-9482',
    customerId: 'CUST-DEV-119',
    customerTier: 'growth',
    accountAgeDays: 92,
    lastPaymentStatus: 'paid',
    subject: 'Production API returning 500 on /v1/checkout webhook',
    message:
      'Starting 15 minutes ago, our production checkout webhooks are intermittently throwing 500 Internal Server Error. We have traced this to the decision routing endpoint timeout.'
  },

  faqInvoiceDownload: {
    ticketId: 'TCK-9483',
    customerId: 'CUST-FREE-882',
    customerTier: 'free',
    accountAgeDays: 14,
    lastPaymentStatus: 'paid',
    subject: 'Where can I find last month invoice PDF?',
    message:
      'Hi team, could you please point me to where I can download the PDF statement for our account settings? Thanks!'
  }
};

/**
 * Ergonomic console formatter displaying the System-1 decision receipt
 */
export function renderRoutingReceipt(
  ticket: CustomerTicket,
  decision: JevDecisionResponse<CustomerServiceQuestions>
): void {
  const answers = decision.answers;
  const escalationProb = (answers.is_escalation_risk.noul * 100).toFixed(1);
  const dept = answers.target_department.choice;
  const confidence = (answers.target_department.confidence * 100).toFixed(1);
  const priority = typeof answers.priority_level.score === 'number'
    ? answers.priority_level.score.toFixed(1)
    : answers.priority_level.score;

  console.log('='.repeat(70));
  console.log(`[RECEIPT] Ticket ${ticket.ticketId} (${ticket.customerTier.toUpperCase()})`);
  console.log(`Subject: "${ticket.subject}"`);
  console.log('-'.repeat(70));
  console.log(`⚡ Provider:       ${decision.providerUsed} (${decision.modelUsed})`);
  console.log(`⏱️  Latency:        ${decision.latencyMs}ms`);
  console.log(`🏷️  Fallback:       ${decision.isFallback ? 'YES (Graceful Mock)' : 'NO (Direct Provider)'}`);
  console.log('-'.repeat(70));
  console.log(`🎯 Target Dept:    ${dept.toUpperCase()} (Confidence: ${confidence}%)`);
  console.log(`🚨 Escalation:     ${escalationProb}% probability`);
  console.log(`⭐ Priority Score: ${priority} / 5.0`);
  console.log('📊 Distribution:');
  for (const [key, prob] of Object.entries(answers.target_department.probabilities)) {
    const bar = '█'.repeat(Math.round(prob * 20));
    console.log(`   - ${key.padEnd(18)} ${(prob * 100).toFixed(1).padStart(5)}% | ${bar}`);
  }
  console.log('='.repeat(70) + '\n');
}
