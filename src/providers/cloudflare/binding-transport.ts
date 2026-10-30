/**
 * Cloudflare Workers AI: in-process `env.AI` binding transport.
 *
 * Zero egress by construction: this module never touches `fetch`, so a provider
 * configured with a binding cannot make an outbound call even if it fails.
 */

import type { CloudflareAiBinding } from './protocol.js';
import type { CloudflareTransport } from './transport.js';

export class BindingTransport implements CloudflareTransport {
  readonly kind = 'binding' as const;
  readonly zeroEgress = true;

  private readonly binding: CloudflareAiBinding;

  constructor(binding: CloudflareAiBinding) {
    this.binding = binding;
  }

  public async run(model: string, payload: Record<string, unknown>): Promise<any> {
    return this.binding.run(model, payload);
  }

  public describe(): string {
    return 'env.AI binding (in-process, zero egress)';
  }
}
