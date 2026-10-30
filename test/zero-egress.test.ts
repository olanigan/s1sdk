import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { S1Client, choice } from "../src/index.js";

/**
 * Zero-egress audit.
 *
 * The previous version hooked node `http`/`https` and never invoked the client,
 * so it could not observe `fetch` (which the providers use) and passed
 * vacuously. This version stubs the fetch the SDK actually calls, executes a
 * real local decision, and asserts every outbound URL is loopback.
 */
describe("Playbook Section 10B: Zero-Egress Network Audit", () => {
  let outboundAttempts: string[] = [];
  const originalFetch = globalThis.fetch;

  beforeAll(() => {
    outboundAttempts = [];
    globalThis.fetch = (async (input: any, _init?: any) => {
      const url = typeof input === "string" ? input : input?.url ?? String(input);
      outboundAttempts.push(url);
      const body = {
        answers: {
          action: { type: "choice", choice: "read", confidence: 0.93 }
        },
        usage: { input_tokens: 12, output_tokens: 0 }
      };
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => body,
        text: async () => JSON.stringify(body)
      } as any;
    }) as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it("makes only loopback calls for an offline Homestead decision", async () => {
    const client = new S1Client({
      provider: "homestead",
      endpoint: "http://127.0.0.1:18765/v1/systemone"
    });

    const res = await client.decide({
      state: "read the release notes",
      questions: { action: choice("Action", { read: "read", write: "write" }) }
    });

    expect(res.answers.action.choice).toBe("read");
    expect(outboundAttempts.length).toBeGreaterThan(0);
    const externalEgress = outboundAttempts.filter(
      (url) => !url.includes("localhost") && !url.includes("127.0.0.1")
    );
    expect(externalEgress).toEqual([]);
  });
});
